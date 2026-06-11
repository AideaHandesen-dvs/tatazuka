// Stackchan 出力コネクタ（物理スタックチャンの「替え玉」＝v0 を喋るヘッドレス client）。connectors の **出力役の初例**。
// 入力コネクタ群（MQTT/HA…）が「外 → 佇か」なのに対し、これは **佇か → 外**：server の語彙（say/emote/motion/presence）を
// **別の身体（サーボ/LED/口）で再生する**。connectors/README §1-2・§3-2 が言い切った「出力コネクタ＝protocol v0 を喋る
// もう一つの client でしかない・新しい型は要らない」を、実機を待たずソフトで実証する一本。
//
// なぜ protocol 変更ゼロで実機の替え玉になれるか（二つの先払い）：
//   - 封筒分離 {type,data}（protocol §2）… hub は封筒を見て転送するだけ＝別の身体に流すのがタダ。
//   - 意味論型語彙（protocol §4-1）… server は「喜び」「こっちを見る」という**意味**を送る。描き方は受け手任せ。
//     ブラウザは VRM の blendshape に、**物理スタックチャンはサーボ/LED の表情に**解釈する＝完全に対称。
// だから物理スタックチャンは server/hub.js に挿さる**もう一つの「部屋＝身体」**になるだけ。このエミュレータが
// hub に WS で挿さって presence を受け取ることが、その「別デバイスが部屋として挿さる」の実証になる。
//
// 構造（repo の規律：駆動ロジックを純関数に・IO は注入・依存ゼロ）：
//   - makeBody({log}) … v0 メッセージ → 物理駆動コマンド列（純ロジック）。**実機ファームはこの log を実駆動
//     （NeoPixel.setColor / servo.write / speaker）に差し替えるだけで drop-in**。だから log 注入でテストできる。
//   - runStackchan({url,label,log}) … node 22 のグローバル WebSocket で実 server に v0 client として繋ぐ（依存ゼロ）。
//     再接続（resumed 申告・protocol §6-2/§6-3）・sense 送信（タッチの替え・§5）を持つ。
//
// 実行：
//   node connectors/stackchan.js                       # 既定 wss://localhost:8443/ws へ
//   node connectors/stackchan.js wss://durandal.local:8443/ws
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node connectors/stackchan.js   # 自己署名証明書の dev server に繋ぐとき
//   TZ_MQTT_URL=mqtt://localhost:1883 node connectors/stackchan.js # MQTT 身体モード＝実機へ（README §3-3）
//   （起動後 stdin に「つつく」「なでる」「揺らす」と打つと sense を送る＝実機のタッチセンサの替え）
// env：TZ_SERVER_URL（接続先）／TZ_STACKCHAN_LABEL（端末名＝hub が呼び分ける名前・既定「机のスタックチャン」）
//     ／TZ_MQTT_URL（身体バス。無ければ従来どおり log だけ＝PE）／TZ_STACKCHAN_TOPIC（基底 topic）。

import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { makeMqttClient } from './mqtt.js';

// mood → 物理表現（LED 色 ＋ 目の形 ＋ 頬LED）。protocol §4-3 の語彙表に対応。
// id/hex は MQTT 身体バス（README §3-3）に流す ASCII 駆動プリミティブ＝ファームはこの id を描くだけ。
// 知らない mood は黙って無視（§4-1：表情を全部無視しても佇かは成立する）。
const MOOD = {
  '通常': { led: '白',   eyes: '・ ・',  id: 'normal', hex: '#FFFFFF' },
  '呆れ': { led: '青白', eyes: '‐ ‐',   id: 'flat',   hex: '#AAC8FF' },
  '疑い': { led: '紫',   eyes: '・_ ・', id: 'squint', hex: '#AA66FF' },
  '喜び': { led: '黄',   eyes: '＾ ＾',  id: 'happy',  hex: '#FFD700' },
  '怒り': { led: '赤',   eyes: '＞ ＜',  id: 'angry',  hex: '#FF3030' },
  '照れ': { led: '桃',   eyes: '／ ／',  id: 'shy',    hex: '#FF9EB5', cheek: true },
};
// act → サーボのジェスチャ（首 pan/tilt と body の上下）。id は MQTT に流すジェスチャ名＝
// アニメーション（時間芸）はファーム内で完結させ、ネット越しに角度を刻まない（README §3-3）。
// 知らない act は無視（§4-1）。
const ACT = {
  'こっちを見る': { desc: 'pan 0°, tilt +10°（顔を上げてこちらへ）', id: 'look' },
  'うなずく':     { desc: 'tilt 下→上 ×2',                          id: 'nod' },
  '首を振る':     { desc: 'pan 左→右 ×2',                           id: 'shake' },
  '跳ねる':       { desc: 'body servo 上下 ×2',                     id: 'hop' },
};

// v0 メッセージ → 物理駆動コマンド列（純ロジック・IO は log/drive 注入）。
// メソッド名＝メッセージ型名（handle が type で引く）。
//   log   … 人間向けの実況（コンソール・テスト）。
//   drive … 機械向けの駆動プリミティブ drive(channel, obj)（任意）。MQTT 身体モードでは
//           `…/cmd/<channel>` への publish に差さる（README §3-3）。実機ファームはこれを実行するだけ。
export function makeBody({ log, drive }) {
  const out = drive || (() => {}); // drive 未注入なら従来どおり log だけ（PE）
  let here = true;
  return {
    welcome(d) { log(`[welcome] protocol ${d.protocol}`); },
    presence(d) {
      here = !!d.here;
      log(here
        ? '[presence] here=true → 起きる（LED 点灯・サーボ neutral）'
        : '[presence] here=false → 寝る（LED 消灯・誰もいない部屋）');
      out('power', { on: here });
    },
    emote(d) {
      const m = MOOD[d.mood];
      if (!m) return; // 知らない mood は黙って無視（§4-1）
      log(`[emote] ${d.mood} → [LED]${m.led} [目]${m.eyes}${m.cheek ? ' [頬LED]on' : ''}`);
      out('face', { eyes: m.id, led: m.hex, cheek: !!m.cheek });
    },
    motion(d) {
      const g = ACT[d.act];
      if (!g) return; // 知らない act は黙って無視（§4-1）
      log(`[motion] ${d.act} → [サーボ]${g.desc}`);
      out('neck', { gesture: g.id });
    },
    say(d) {
      if (d.mood && MOOD[d.mood]) this.emote({ mood: d.mood }); // say＋mood はアトミック（§4-2）＝表情と口が同時着地
      const text = d.text || '';
      const n = text.length;
      log(`[say] 「${text}」 → [口パク]${'◦'.repeat(Math.min(n, 20))}（${n}音）`);
      out('mouth', { n: Math.min(n, 20) }); // 台詞本文は身体に流さない（要るのは口の動きだけ・README §3-3）
    },
    error(d) { log(`[error] ${d.message}`); },
  };
}

// 1 メッセージを body にディスパッチ。**未知の型は黙って無視**（§4-1 が語彙レベルまで貫通）。
export function handle(body, msg) {
  const fn = body[msg.type];
  if (typeof fn === 'function') fn.call(body, msg.data || {});
}

// 身体からのイベント（`…/ev/sense` の payload・README §3-3）→ v0 の sense data（純ロジック）。
// ASCII kind → §5-3 の語彙。part はポインタ系（つつく等）だけ「頭」を付ける（§5-2：センサ系に part は無い）。
// 未知 kind・壊れた JSON は null（＝黙って無視。§4-1 の対称）。
const EV_KIND = { poke: 'つつく', stroke: 'なでる', hold: '長押し', shake: '揺らす', lift: '持ち上げる' };
const EV_PART = { poke: '頭', stroke: '頭', hold: '頭' };
export function senseFromEvent(payload) {
  try {
    const j = JSON.parse(payload);
    const kind = EV_KIND[j.kind];
    if (!kind) return null;
    return EV_PART[j.kind] ? { kind, part: EV_PART[j.kind] } : { kind };
  } catch {
    return null;
  }
}

// ---- ランナブル：実 server に v0 client として繋ぐ（node 22 のグローバル WebSocket・依存ゼロ） ----
export function runStackchan(opts) {
  opts = opts || {};
  const url = opts.url || process.env.TZ_SERVER_URL || 'wss://localhost:8443/ws';
  const label = opts.label || process.env.TZ_STACKCHAN_LABEL || '机のスタックチャン';
  const log = opts.log || ((s) => console.log(s));
  // MQTT 身体バス（README §3-3）。TZ_MQTT_URL（or opts.mqtt 注入）が無ければ従来の log のみ（PE）。
  // 下り＝駆動プリミティブを `…/cmd/<channel>` へ publish／上り＝`…/ev/sense` を購読して v0 sense へ。
  const base = opts.topic || process.env.TZ_STACKCHAN_TOPIC || 'tatazuka/body/stackchan';
  const mq = 'mqtt' in opts ? opts.mqtt : makeMqttClient({
    clientId: 'tatazuka-stackchan-brain',
    onMessage: (topic, payload) => {
      if (topic !== `${base}/ev/sense`) return;
      const s = senseFromEvent(payload);
      if (s) { log(`[ev] 身体から ${s.kind}`); sendSense(s.kind, s.part); }
    },
  });
  if (mq) {
    mq.subscribe(`${base}/ev/sense`);
    log(`[mqtt] 身体バス: ${base}/{cmd/*,ev/sense}`);
  }
  const drive = mq ? (ch, obj) => mq.publish(`${base}/cmd/${ch}`, JSON.stringify(obj)) : null;
  const body = makeBody({ log, drive });
  // スタックチャンの cap：画面は WebGL でない＝webgl:none。サーボ/LED は「将来の cap 拡張」（§3-2）として正直に申告する。
  // server は知らない cap を黙って無視する（§3-2 前方互換）ので、**protocol 変更ゼロで「この身体の能力」を名乗れる**。
  const caps = { orientation: 'none', motion: 'none', camera: 'none', webgl: 'none', servo: 'on', led: 'on' };
  let ws = null, everConnected = false, backoff = 1000, closed = false;

  function dial() {
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      backoff = 1000;
      // 再接続なら resumed:true（落ちた自覚の申告・§6-3）。初回は false。
      const data = { protocol: 0, label, resumed: everConnected, caps };
      ws.send(JSON.stringify({ type: 'hello', data }));
      everConnected = true;
      log(`[hello] ${label} caps{webgl:none, servo:on, led:on}${data.resumed ? ' resumed' : ''}`);
    });
    ws.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { msg = null; }
      if (msg) handle(body, msg);
    });
    ws.addEventListener('close', () => {
      if (closed) return;
      setTimeout(dial, backoff);                 // 自動再接続（§6-2）
      backoff = Math.min(backoff * 2, 10000);    // 指数バックオフ（上限10秒・ws-client.js と同じ）
    });
    ws.addEventListener('error', () => { try { ws.close(); } catch { /* close に任せる */ } });
  }
  dial();

  // タッチセンサの替え＝sense を送る（§5。実機ならボタン/静電容量タッチ起点）。
  const sendSense = (kind, part) => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'sense', data: part ? { kind, part } : { kind } }));
    }
  };
  return {
    stop() {
      closed = true;
      try { ws && ws.close(); } catch { /* noop */ }
      try { mq && mq.close && mq.close(); } catch { /* noop */ }
    },
    sendSense, body,
  };
}

// ---- 直接実行されたときだけ起動（import 時は副作用ゼロ＝テストが繋ぎにいかない） ----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sc = runStackchan({ url: process.argv[2] });
  const SENSES = ['つつく', 'なでる', '長押し', '揺らす', '持ち上げる'];
  console.log('（stdin: つつく/なでる/長押し/揺らす/持ち上げる と打つと sense を送る。Ctrl-C で終了）');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const k = line.trim();
    if (!k) return;
    if (SENSES.includes(k)) sc.sendSense(k, '頭');
    else console.log(`（未知の入力「${k}」。${SENSES.join('/')} のどれか）`);
  });
}
