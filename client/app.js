// 表示クライアント本体：cap 検出・入力の意味化・メッセージ配線。
// 設計の根拠は protocol/README.md。§番号のコメントはそこを指す。

// 本物の server（WS）に繋ぐ。オフライン開発は import 先を './mock-server.js' に替えるだけ
// （mock も同じ connect({onMessage})→{send} の顔。client/README の「継ぎ目」参照）
import { connect } from './ws-client.js';
import * as cssFace from './face.js';

// 顔は差し替え可能な継ぎ目（client/README）。既定は CSS の卵（どの端末でも動く床）。
// WebGL が効く端末では VRM アバター（face-vrm.js）へ「格上げ」する＝プログレッシブ・
// エンハンスメントが顔にも効く。activeFace は {emote,act,say,presence,setView} を持つ。
let activeFace = cssFace;

const $ = (s) => document.querySelector(s);
const scene = $('#scene'), stage = $('#stage'), tatazuka = $('#tatazuka'),
      video = $('#camera'), perm = $('#perm'), hud = $('#hud');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- caps 検出（§3）----
const caps = { orientation: 'none', motion: 'none', camera: 'none', webgl: 'none' };
let helloSent = false;

function setCap(name, state) {
  if (caps[name] === state) return;
  caps[name] = state;
  if (helloSent) send({ type: 'caps', data: { [name]: state } }); // 変化は差分で（§3-3）
  renderPerm();
  renderHud();
}

// webgl: この顔は CSS 3D 描画なので使わないが、cap としては正直に申告する
try { if (document.createElement('canvas').getContext('webgl')) caps.webgl = 'on'; } catch { /* none のまま */ }

// camera: getUserMedia があれば常に許可ゲート付き → ask
// ※ iOS 12 向けに ?. を使わず明示チェック（client/README「iOS 12 対応」参照）
if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) caps.camera = 'ask';

// orientation / motion:
// - iOS 系は明示許可（ユーザー操作起点）が要る → ask にして許可ボタンを出す
// - それ以外はリスナーを張り、実際にイベントが来て初めて on にする
//   （API が存在してもセンサが無い端末＝デスクトップでは一生イベントが来ない。
//    「API がある」を信用せず「動いた」だけを信用する）
const needsGate = 'DeviceOrientationEvent' in window
  && typeof window.DeviceOrientationEvent.requestPermission === 'function';
if (needsGate) {
  caps.orientation = 'ask';
  caps.motion = 'ask';
} else {
  if ('DeviceOrientationEvent' in window) addEventListener('deviceorientation', onOrientation);
  if ('DeviceMotionEvent' in window) addEventListener('devicemotion', onMotion);
}

// ---- 傾き → 視点（client 内で完結。server には流さない：§5-2）----
let tx = 0, ty = 0, cx = 0, cy = 0; // 目標と現在（度）
let base = null;                    // 持ちはじめの姿勢を基準にする

function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  if (caps.orientation !== 'on') setCap('orientation', 'on');
  if (!base) base = { beta: e.beta, gamma: e.gamma };
  tx = clamp(-(e.beta - base.beta) * 0.7, -14, 14);
  ty = clamp((e.gamma - base.gamma) * 0.7, -14, 14);
}

(function loop() {
  cx += (tx - cx) * 0.12;
  cy += (ty - cy) * 0.12;
  if (activeFace.setView) activeFace.setView(cx, cy); // 視点反映は顔側の責務（CSS=箱を回す / VRM=カメラ）
  requestAnimationFrame(loop);
})();

// 傾きが無い間はマウスで視点を動かす代替（デスクトップ用）。
// Pointer Events は iOS 12 非対応なので使わない。touch 端末は傾きで覗き込む。
scene.addEventListener('mousemove', (e) => {
  if (caps.orientation === 'on') return;
  if (p) return;                             // なで/つつき中（ドラッグ）は視点を動かさない
  if (e.target.closest('#tatazuka')) return; // 佇かを触っている間は視点を動かさない
  ty = clamp(((e.clientX / innerWidth) - 0.5) * 22, -14, 14);
  tx = clamp(-((e.clientY / innerHeight) - 0.5) * 22, -14, 14);
});

// ---- 加速度 → 「揺らす」に意味化（§5）。生データは送らない ----
let lastShake = 0;
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  if (caps.motion !== 'on') setCap('motion', 'on');
  const m = Math.hypot(a.x, a.y, a.z || 0); // 静止時は重力分 ≒ 9.8
  if (m > 22 && Date.now() - lastShake > 1500) {
    lastShake = Date.now();
    sense('揺らす');
  }
}

// ---- 許可ボタン（ask の cap だけ並ぶ。佇かにねだられる対象：§3-2）----
function renderPerm() {
  perm.innerHTML = '';
  if (caps.orientation === 'ask') {
    const b = document.createElement('button');
    b.textContent = '傾きを許可';
    b.onclick = async () => {
      try {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r === 'granted') {
          addEventListener('deviceorientation', onOrientation);
          setCap('orientation', 'on');
        } else setCap('orientation', 'none'); // 拒否は ask → none（§3-2）
      } catch { setCap('orientation', 'none'); }
      try {
        if ('DeviceMotionEvent' in window && typeof DeviceMotionEvent.requestPermission === 'function') {
          const r = await DeviceMotionEvent.requestPermission();
          if (r === 'granted') {
            addEventListener('devicemotion', onMotion);
            setCap('motion', 'on');
          } else setCap('motion', 'none');
        }
      } catch { setCap('motion', 'none'); }
    };
    perm.append(b);
  }
  if (caps.camera === 'ask') {
    const b = document.createElement('button');
    b.textContent = 'カメラを許可';
    b.onclick = async () => {
      try {
        const st = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }, audio: false,
        });
        video.srcObject = st;
        video.hidden = false;
        setCap('camera', 'on');
      } catch { setCap('camera', 'none'); }
    };
    perm.append(b);
  }
}

// ---- 入力 → 意味化（つつく・なでる・長押し：§5）----
// server は描画位置を知らないので、当たり判定と解釈はここ（client）の仕事。
// Pointer Events は iOS 12 非対応 → touch（スマホ/タブレット）＋ mouse（デスクトップ）で書く。
function partAt(target, clientY) {
  if (target.closest && target.closest('.face')) return '顔';
  const r = tatazuka.getBoundingClientRect();
  // VRM 時は #tatazuka が hidden（rect=0）＝顔の DOM も無いので、画面の上下で頭/体を分ける
  const top = r.height ? r.top : 0;
  const h = r.height || window.innerHeight;
  return (clientY - top) < h * 0.45 ? '頭' : '体';
}

let p = null;
function gestureStart(target, x, y) {
  p = {
    lx: x, ly: y, dist: 0, sent: 0,
    part: partAt(target, y), done: false,
    long: setTimeout(() => {
      if (p && p.dist < 12) { sense('長押し', p.part); p.done = true; }
    }, 600),
  };
}
function gestureMove(x, y) {
  if (!p) return;
  p.dist += Math.hypot(x - p.lx, y - p.ly);
  p.lx = x; p.ly = y;
  if (p.dist - p.sent > 240) { // 「一なで分」たまるたびに繰り返し送る（§5-2）
    p.sent = p.dist;
    sense('なでる', p.part);
    p.done = true;
  }
}
function gestureEnd() {
  if (!p) return;
  clearTimeout(p.long);
  if (!p.done && p.dist < 12) sense('つつく', p.part);
  p = null;
}

// ジェスチャは #scene（常に在る・全画面）で拾う。VRM 化で #tatazuka が hidden になっても
// 効くように＝CSS の卵でも VRM の canvas でも、タップ/なで/長押しは #scene に bubble する。
// （canvas は #scene の子なので pointer-events 設定無しでもイベントは #scene に届く）
// touch（iOS 12 含む）
scene.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  gestureStart(e.target, t.clientX, t.clientY);
}, { passive: true });
scene.addEventListener('touchmove', (e) => {
  const t = e.changedTouches[0];
  gestureMove(t.clientX, t.clientY);
  if (p) e.preventDefault(); // なで中はスクロール/ラバーバンドを止める
}, { passive: false });
scene.addEventListener('touchend', gestureEnd);
scene.addEventListener('touchcancel', gestureEnd);

// mouse（デスクトップ）。setPointerCapture の代わりに window で move/up を拾う
scene.addEventListener('mousedown', (e) => gestureStart(e.target, e.clientX, e.clientY));
addEventListener('mousemove', (e) => { if (p) gestureMove(e.clientX, e.clientY); });
addEventListener('mouseup', gestureEnd);

// 留守（presence:false）の箱をつつくと佇かがこちらへ移る「ノック」は、gestureEnd の
// sense('つつく') が兼ねる：hub は留守の部屋への sense を移動の蛇口として解釈し（§6-1）、
// 在室なら poke として数える。だから別の knock ハンドラは要らない（タップ＝一つの出口）。

// ---- HUD（プロト用デバッグ表示）----
let lastIn = '-', lastOut = '-';
function renderHud() {
  hud.innerHTML = Object.entries(caps).map(([k, v]) => `${k}: ${v}`).join('<br>')
    + `<br>← ${lastIn}<br>→ ${lastOut}<br><button data-recal>視点リセット</button>`;
}
hud.addEventListener('click', (e) => {
  if (e.target.dataset && 'recal' in e.target.dataset) base = null;
});

// ---- 配線（mock も本物の WS も同じ形：connect({onMessage}) → {send}）----
let lastMood = '通常', lastHere = true; // 顔を差し替えたとき状態を引き継ぐため
const handlers = {
  welcome() {},
  say(d) { activeFace.say(d.text); if (d.mood) { lastMood = d.mood; activeFace.emote(d.mood); } },
  emote(d) { lastMood = d.mood; activeFace.emote(d.mood); },
  motion(d) { activeFace.act(d.act); },
  presence(d) { lastHere = d.here; activeFace.presence(d.here); },
  error(d) { lastIn = 'error: ' + d.message; renderHud(); },
};
const link = connect({
  onMessage(msg) {
    lastIn = msg.type + (msg.data && msg.data.text ? `「${msg.data.text.slice(0, 12)}」` : '');
    renderHud();
    (handlers[msg.type] || (() => {}))(msg.data || {}); // 未知の型は黙って無視
  },
});

function send(msg) {
  lastOut = msg.type + (msg.data && msg.data.kind ? `(${msg.data.kind})` : '');
  renderHud();
  link.send(msg);
}
function sense(kind, part) {
  send({ type: 'sense', data: part ? { kind, part } : { kind } });
}

// ---- hello（§3-1）----
const label = new URLSearchParams(location.search).get('label') || '名無しの部屋';
// 初回接続（リロード・再訪を含む）は必ず「初めまして」。再訪を「落ちた」と誤解しない。
// resumed が立つのは “途中で WS が切れて自動再接続した” ときだけで、それは ws-client.js が
// everConnected で握って打ち直す（§6-3）。client 側はここで嘘の resumed を作らない。
send({ type: 'hello', data: { protocol: 0, label, resumed: false, caps: { ...caps } } });
helloSent = true;
renderPerm();
renderHud();

// ---- 顔の「格上げ」：WebGL が効き、モデルが在るときだけ VRM へ（プログレッシブ・エンハンスメント）----
// 失敗（古い Safari でライブラリがパース不可・モデル 404・WebGL不可）は全部 CSS の卵のまま。
// iOS 12（=試金石の iPad Air 2）は three.js をパースできず、ここで自然にフォールバックする。
(async function tryVRM() {
  if (caps.webgl !== 'on') return;
  const q = new URLSearchParams(location.search);
  const modelUrl = q.get('model') || './models/vrm/aya-nogloves.vrm';
  const num = (k) => (q.has(k) ? parseFloat(q.get(k)) : undefined); // 未指定は face-vrm の既定に任せる
  try {
    const head = await fetch(modelUrl, { method: 'HEAD' });
    if (!head.ok) return; // モデルが無ければ CSS のまま（既定の床）
    const mod = await import('./face-vrm.js');     // 動的 import：iOS12 はここで reject → catch
    // 向き・距離・高さ・腕角は実機から ?turn= ?dist= ?y= ?arms= で微調整できる
    const vrm = await mod.createVRMFace({
      scene, modelUrl, turn: num('turn'), dist: num('dist'), yOffset: num('y'), arms: num('arms'),
    });
    cssFace.presence(false);                        // CSS の卵を退場
    document.getElementById('tatazuka').hidden = true;
    activeFace = vrm;
    activeFace.presence(lastHere);                  // 現在の状態を引き継ぐ
    activeFace.emote(lastMood);
    lastIn = 'VRM: ' + modelUrl.split('/').pop();
    renderHud();
  } catch (e) {
    lastIn = 'VRM不可(CSS継続): ' + (e && e.message ? e.message.slice(0, 40) : e);
    renderHud(); // 卵のまま。設計通り佇かは出る
  }
})();
