// 佇かの振る舞い（人格エンジン）。protocol v0 を server 側として実装する。
// 役割分担：
//   behavior.js … 「いつ・どんな状況で喋るか」（トリガ・間・presence/motion の副作用）
//   persona.js  … 「何を喋るか」（situation タグ → 台詞）。LLM の継ぎ目はあちら
// トランスポート非依存：
//   const s = createSession({ send, persona? });
//   s.receive(msg)  ← client からの {type,data}
//   s.close()       ← 切断。タイマーを掃除する
//
// イベント源（M4）：①触られた（sense・反応）②時刻帯 ③在席・連続時間。
// PC作業監視・天気・LLM は別マイルストーン。

import { createPersona } from './persona.js';

const TICK_MS = 30000;             // 時刻帯・在席時間・暇つぶしを刻む間隔
const WEATHER_MS = 30 * 60 * 1000; // 天気を見直す間隔（変化はゆっくり。tick とは別サイクル）
const WORK_MARKS = [60, 120, 180]; // 在席ぶっ通しで茶々を入れる分

function timeBand(hour) {
  if (hour < 5) return 'deepnight';
  if (hour < 10) return 'morning';
  if (hour < 17) return 'noon';
  if (hour < 21) return 'evening';
  return 'night';
}

// opts.now / opts.tickMs は注入可（テスト・デモで「間」を早送りするため。既定は実時間）。
// opts.weather は天気イベント源（任意）。無ければ天気には触れない（PE）。weatherMs はその間隔。
export function createSession({ send, persona, now, tickMs, weather, weatherMs }) {
  const p = persona || createPersona();
  const clock = now || Date.now;
  const interval = tickMs || TICK_MS;
  const weatherEvery = weatherMs || WEATHER_MS;
  const ctx = { label: '名前のない部屋' };

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
    if (closed || !ln) return;
    send({ type: 'say', data: ln.mood ? { text: ln.text, mood: ln.mood } : { text: ln.text } });
  };
  const motion = (act) => send({ type: 'motion', data: { act } });

  let helloDone = false;
  let connectStart = 0;
  let lastBand = null;
  let lastWeatherAt = 0; // 直近に天気を見た時刻（0＝まだ。最初の tick で一度見る）
  const workDone = new Set(); // 既に出した在席マーク
  let nade = 0, poke = 0, lastShake = 0;

  // ---- ②③ 時刻帯・在席時間・暇つぶし（「間」は server が刻む：protocol §4-1） ----
  // 天気は work/time/idle と独立した遅いサイクル。変化があれば一言（poll が null なら黙る）。
  // 非同期・撃ちっぱなし：解決は数百 ms 後なので、この tick の他の発話とは衝突しにくい。
  function weatherTick(now) {
    if (!weather || now - lastWeatherAt < weatherEvery) return;
    lastWeatherAt = now;
    weather.poll().then((w) => { if (w && !closed) say(w.situation, w.ctx); }).catch(() => {});
  }

  const tick = setInterval(() => {
    if (closed || !helloDone) return;
    const now = clock();

    weatherTick(now); // ④ 天気（撃ちっぱなし。下の work/time/idle とは別サイクル）

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
      send({ type: 'presence', data: { here: false } });
      later(() => { send({ type: 'presence', data: { here: true } }); say('walk.back'); }, 8000);
    } else if (r < 0.55) {
      say('idle');
    }
  }, interval);
  timers.add(tick);

  // ---- protocol §3: hello / welcome ----
  function onHello(d) {
    if (!d || d.protocol !== 0) { send({ type: 'error', data: { message: 'protocol version mismatch' } }); return; }
    helloDone = true;
    connectStart = clock();
    lastBand = timeBand(new Date(clock()).getHours()); // 接続時のバンドは「またいだ」扱いにしない
    if (d.label) ctx.label = d.label;

    send({ type: 'welcome', data: { protocol: 0 } });
    send({ type: 'presence', data: { here: true } });

    later(() => say(d.resumed ? 'greet.resumed' : 'greet'), 800); // 落ちたことは茶々に（§6-3）
    if (lastBand === 'deepnight') later(() => say('time.deepnight'), 4000); // 深夜の接続には一言

    const caps = d.caps || {};
    if (caps.orientation === 'ask') later(() => say('nudge.orientation'), 7000);
    if (caps.camera === 'ask') later(() => say('nudge.camera'), 14000);
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
      default:
        break; // 未知の kind は黙って無視
    }
  }

  return {
    receive(msg) {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'hello') onHello(msg.data);
      else if (msg.type === 'caps') onCaps(msg.data);
      else if (msg.type === 'sense') onSense(msg.data);
      // 未知の型は黙って無視
    },
    close() {
      closed = true;
      for (const id of timers) clearTimeout(id);
      clearInterval(tick);
      timers.clear();
    },
  };
}
