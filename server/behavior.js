// 佇かの振る舞い（人格エンジン）。protocol v0 を server 側として実装する。
// 役割分担：
//   behavior.js … 「いつ・どんな状況で喋るか」（トリガ・間・presence/motion の副作用）
//   persona.js  … 「何を喋るか」（situation タグ → 台詞）。LLM の継ぎ目はあちら
// トランスポート非依存：
//   const s = createSession({ send, persona? });
//   s.receive(msg)  ← client からの {type,data}
//   s.close()       ← 切断。タイマーを掃除する
//
// イベント源（M4）：①触られた（sense・反応）②時刻帯 ③在席・連続時間 ④天気 ⑤作業監視
// ⑥外部 connector（Home Assistant 等＝connectors/）。④以降は「外部イベント源 → situation
// タグ → 人格層」の同型（README §6-4）。activity と connectors は poll() を持つ入力源として
// 一様に扱う（sources）。LLM persona は別の継ぎ目（persona-llm.js）。

import { createPersona } from './persona.js';
import { humanizeGap } from './reunion.js';

const REUNION_MIN_MS = 60 * 1000;  // この間隔以上あいて再接続したら「N分ぶりだな」と言及（§6-3）
const TICK_MS = 30000;             // 時刻帯・在席時間・暇つぶしを刻む間隔
const WEATHER_MS = 30 * 60 * 1000; // 天気を見直す間隔（変化はゆっくり。tick とは別サイクル）
const WORK_MARKS = [60, 120, 180]; // 在席ぶっ通しで茶々を入れる分
const TALK_MAX = 500;              // talk の text 上限（protocol §5-4。超過は頭だけ読む）

function timeBand(hour) {
  if (hour < 5) return 'deepnight';
  if (hour < 10) return 'morning';
  if (hour < 17) return 'noon';
  if (hour < 21) return 'evening';
  return 'night';
}

// opts.now / opts.tickMs は注入可（テスト・デモで「間」を早送りするため。既定は実時間）。
// opts.weather はイベント源（任意・current() を持つ特別扱い＝朝の挨拶／遅い別サイクル）。
// opts.activity / opts.sources は poll() だけ持つ入力源。activity（作業監視）も sources の一員として
// 一様に毎 tick poll される（connectors の Home Assistant 等も sources で挿す）。無ければ触れない（PE）。
//
// 活性（presence §6-1）：佇かが「この部屋に居る」間だけ喋る/動く/居る。
//   - managed=false（既定・単体）：hello が通った瞬間に自分で活性化する＝従来どおり。
//   - managed=true（hub 配下）：活性は hub が activate()/deactivate() で制御する（一度に一箇所）。
//   present(here) は presence の出口（既定は send。hub は自分の出口を注入）。onReady は hello 成立の
//   合図（hub が部屋として迎え入れる）。onActive(bool) は活性の変化を hub に知らせる（出力の関所用）。
// opts.reunion は再会の記憶（任意・接続をまたぐ共有ストア。reunion.js）。無ければ間隔に言及しない（PE）。
// opts.talkMemory は会話の短期記憶（任意・接続をまたぐ共有ストア。talkmemory.js）。無ければ覚えない（PE）。
export function createSession({ send, persona, now, tickMs, weather, weatherMs, activity, sources,
                               present, managed, onReady, onActive, reunion, talkMemory }) {
  const p = persona || createPersona();
  const clock = now || Date.now;
  const interval = tickMs || TICK_MS;
  const weatherEvery = weatherMs || WEATHER_MS;
  const ctx = { label: '名前のない部屋' };
  // 入力源（poll() → {situation, ctx?}|null）を一様に扱う。activity も connectors も区別しない。
  const pollables = [activity, ...(sources || [])].filter(Boolean);
  const showPresence = present || ((here) => send({ type: 'presence', data: { here } }));
  const notifyActive = onActive || (() => {});

  const timers = new Set();
  let closed = false;
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); if (!closed) fn(); }, ms);
    timers.add(id);
    return id;
  };

  // 台詞は必ず persona 経由。situation を知らなければ persona が null を返し、何も喋らない。
  // line() は async（LLM persona は生成を待つ。ルール persona は同期値だが await で素通り）。
  // ★ 生成中（数秒）にセッションが切れることがあるので、await の後に closed を再チェックしてから送る。
  // extra は situation 固有の ctx（天気など）。基底 ctx（label 等）に重ねて persona に渡す。
  const say = async (situation, extra) => {
    const ln = await p.line(situation, extra ? { ...ctx, ...extra } : ctx);
    if (closed || !active || !ln) return null; // 生成待ちの間に切断/退室していたら送らない
    send({ type: 'say', data: ln.mood ? { text: ln.text, mood: ln.mood } : { text: ln.text } });
    return ln; // 実際に届いた台詞（onTalk が往復の記録に使う。他の呼び出しは無視）
  };
  const motion = (act) => { if (!closed && active) send({ type: 'motion', data: { act } }); };

  let helloDone = false;
  let active = false;        // この部屋に佇かが居るか（居る間だけ喋る/動く）
  let resumed = false;       // 直近の hello が resumed 申告だったか（活性化時の挨拶に効く）
  let helloCaps = {};        // 直近の hello の caps（活性化時の許可ねだりに使う）
  let helloLabel = null;     // 直近の hello の label（再会の記憶のキー。未命名なら覚えない）
  let connectStart = 0;
  let lastBand = null;
  let lastWeatherAt = 0; // 直近に天気を見た時刻（0＝まだ。最初の tick で一度見る）
  const workDone = new Set(); // 既に出した在席マーク
  let nade = 0, poke = 0, lastShake = 0, lastLift = 0;

  // ---- ②③ 時刻帯・在席時間・暇つぶし（「間」は server が刻む：protocol §4-1） ----
  // 天気は work/time/idle と独立した遅いサイクル。変化があれば一言（poll が null なら黙る）。
  // 非同期・撃ちっぱなし：解決は数百 ms 後なので、この tick の他の発話とは衝突しにくい。
  function weatherTick(now) {
    if (!weather || now - lastWeatherAt < weatherEvery) return;
    lastWeatherAt = now;
    weather.poll().then((w) => { if (w && !closed) say(w.situation, w.ctx); }).catch(() => {});
  }

  // 入力源：毎 tick で各 poll を撃ち、situation が返れば ctx 込みで喋る（追加の蛇口。
  // ナグの時計には触らない＝振る舞いを崩さず台詞を足すだけ）。撃ちっぱなし・解決は遅延。
  function sourcesTick() {
    for (const src of pollables) {
      src.poll().then((r) => { if (r && !closed) say(r.situation, r.ctx); }).catch(() => {});
    }
  }

  const tick = setInterval(() => {
    if (closed || !helloDone || !active) return; // 居ない部屋では時計を回さない（喋らない）
    const now = clock();

    weatherTick(now); // ④ 天気（撃ちっぱなし。下の work/time/idle とは別サイクル）
    sourcesTick();    // ⑤⑥ 入力源＝作業監視・connectors（撃ちっぱなし・追加の蛇口）

    // ③ 在席・連続時間：閾値をまたいだら一度だけ
    const mins = (now - connectStart) / 60000;
    for (const t of WORK_MARKS) {
      if (mins >= t && !workDone.has(t)) { workDone.add(t); say(`work.${t}`); return; }
    }

    // ② 時刻帯：バンドが変わった瞬間に一度だけ
    const band = timeBand(new Date(now).getHours());
    if (band !== lastBand) {
      lastBand = band;
      // 朝は天気を添えて挨拶（weather.morning）。取れない／天気オフなら従来の time.morning に縮退
      if (band === 'morning' && weather) {
        weather.current().then((w) => {
          if (closed) return;
          say(w ? w.situation : 'time.morning', w ? w.ctx : undefined);
        }).catch(() => { if (!closed) say('time.morning'); });
      } else {
        say(`time.${band}`);
      }
      return;
    }

    // それ以外：たまに暇つぶし／ふらっと散歩（presence：protocol §6-1）
    const r = Math.random();
    if (r < 0.15) {
      showPresence(false); // 居る部屋から一瞬出る（hub 配下でも自分の部屋の中の話）
      later(() => { if (closed || !active) return; showPresence(true); say('walk.back'); }, 8000);
    } else if (r < 0.55) {
      say('idle');
    }
  }, interval);
  timers.add(tick);

  // ---- 活性化：佇かがこの部屋に「入った」。挨拶・許可ねだり・presence:true（§6-1/§6-3） ----
  // greet=false は「つつかれて移ってきた」移動（挨拶せず、sense の反応で迎える）。
  function activate(opts) {
    if (active || !helloDone) return;
    active = true;
    notifyActive(true);
    showPresence(true);
    if (opts && opts.greet === false) return;
    // 再会の記憶：この端末を前に見ていて、間隔がそこそこ空いていれば「N分ぶりだな」（§6-3）。
    // 短い間隔は resumed の「落ちてたぞ」、初見/記憶なしは素の greet に落ちる。
    let greet = resumed ? 'greet.resumed' : 'greet';
    let greetCtx;
    if (reunion && helloLabel) {
      const last = reunion.seen(helloLabel);
      if (last != null && clock() - last >= REUNION_MIN_MS) {
        greet = 'greet.reunion';
        greetCtx = { since: humanizeGap(clock() - last) };
      }
    }
    later(() => say(greet, greetCtx), 800);
    if (lastBand === 'deepnight') later(() => say('time.deepnight'), 4000); // 深夜の接続には一言
    if (helloCaps.orientation === 'ask') later(() => say('nudge.orientation'), 7000);
    if (helloCaps.camera === 'ask') later(() => say('nudge.camera'), 14000);
  }

  // 退室：別の部屋へ佇かが移った／この部屋が空いた。presence:false にして黙る。
  function deactivate() {
    active = false;
    notifyActive(false);
    showPresence(false);
  }

  // ---- protocol §3: hello / welcome ----
  function onHello(d) {
    if (!d || d.protocol !== 0) { send({ type: 'error', data: { message: 'protocol version mismatch' } }); return; }
    helloDone = true;
    resumed = !!d.resumed;
    helloCaps = d.caps || {};
    helloLabel = d.label || null; // 再会の記憶のキー（未命名は覚えない）
    connectStart = clock();
    lastBand = timeBand(new Date(clock()).getHours()); // 接続時のバンドは「またいだ」扱いにしない
    if (d.label) ctx.label = d.label;

    send({ type: 'welcome', data: { protocol: 0 } });
    if (onReady) onReady();    // hub に「部屋として迎えてよい」と知らせる（活性は hub が決める）
    if (!managed) activate();  // 単体（hub 無し）は即この部屋に居つく＝従来の挙動
  }

  // ---- protocol §3-3: cap の変化 ----
  function onCaps(d) {
    if (!d) return;
    if (d.orientation === 'on') { say('caps.orientation.on'); motion('跳ねる'); }
    if (d.camera === 'on') say('caps.camera.on');
    if (d.orientation === 'none' || d.camera === 'none') say('caps.denied');
  }

  // ---- protocol §5: sense ----
  function onSense(d) {
    if (!d) return;
    switch (d.kind) {
      case 'つつく':
        poke++;
        if (poke < 2) say('sense.poke.soft');
        else if (poke < 4) say('sense.poke.mid');
        else { say('sense.poke.hard'); motion('首を振る'); poke = 0; }
        break;
      case 'なでる':
        nade++;
        if (nade === 1) say('sense.nade.start');
        else if (nade === 4) say('sense.nade.warm');
        else if (nade >= 8) { say('sense.nade.enough'); motion('跳ねる'); nade = 0; }
        break;
      case '長押し':
        say('sense.grab');
        break;
      case '揺らす': {
        const now = clock();
        if (now - lastShake > 4000) { lastShake = now; say('sense.shake'); motion('首を振る'); }
        break;
      }
      case '持ち上げる': {
        // §5-3 制定時からの語彙だが反応は物理ボディ（IMU・connectors §3-3）が初の送り手。
        // IMU のチャタはファームが均す前提だが、server 側も揺らす同様 4 秒のゲートで防御。
        const now = clock();
        if (now - lastLift > 4000) { lastLift = now; say('sense.lift'); motion('首を振る'); }
        break;
      }
      default:
        break; // 未知の kind は黙って無視
    }
  }

  // ---- protocol §5-4: talk（受動の口） ----
  // 生成（数秒）を待つ間、まず「うなずく」を返す＝server が刻む「間」（§4-1）。語彙追加ゼロ。
  // 自由文は persona の ctx.text にだけ流す（LLM の user プロンプト行き。injection の構えは §5-4）。
  async function onTalk(d) {
    if (!d || typeof d.text !== 'string') return;
    let text = d.text.trim();
    if (!text) return;                                    // 空は黙って無視（§5-4）
    if (text.length > TALK_MAX) text = text.slice(0, TALK_MAX); // 長すぎは頭だけ読む
    motion('うなずく');
    const extra = { text };
    if (talkMemory) extra.history = talkMemory.recent();  // 直近のやり取りを persona に渡す
    const ln = await say('talk', extra);
    if (ln && talkMemory) talkMemory.push(text, ln.text); // 実際に届いた往復だけ覚える
  }

  return {
    receive(msg) {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'hello') onHello(msg.data);
      else if (msg.type === 'caps') onCaps(msg.data);
      else if (msg.type === 'sense') onSense(msg.data);
      else if (msg.type === 'talk') onTalk(msg.data); // 撃ちっぱなし（既存の async say と同じ扱い）
      // 未知の型は黙って無視
    },
    activate,    // hub が「この部屋に入った」と告げる（managed 時）。単体時は hello で自動
    deactivate,  // hub が「別の部屋へ移った／空いた」と告げる
    close() {
      // 再会の記憶：この端末を「今まで見ていた」と刻む（次の接続で間隔に言及できる。§6-3）
      if (reunion && helloLabel) reunion.mark(helloLabel, clock());
      closed = true;
      for (const id of timers) clearTimeout(id);
      clearInterval(tick);
      timers.clear();
    },
  };
}
