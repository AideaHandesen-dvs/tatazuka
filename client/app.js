// 表示クライアント本体：cap 検出・入力の意味化・メッセージ配線。
// 設計の根拠は protocol/README.md。§番号のコメントはそこを指す。

import { connect } from './mock-server.js'; // ← M3 で本物の WS 実装に差し替える継ぎ目
import * as face from './face.js';

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
if (navigator.mediaDevices?.getUserMedia) caps.camera = 'ask';

// orientation / motion:
// - iOS 系は明示許可（ユーザー操作起点）が要る → ask にして許可ボタンを出す
// - それ以外はリスナーを張り、実際にイベントが来て初めて on にする
//   （API が存在してもセンサが無い端末＝デスクトップでは一生イベントが来ない。
//    「API がある」を信用せず「動いた」だけを信用する）
const needsGate = typeof window.DeviceOrientationEvent?.requestPermission === 'function';
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
  stage.style.transform = `rotateX(${cx.toFixed(2)}deg) rotateY(${cy.toFixed(2)}deg)`;
  requestAnimationFrame(loop);
})();

// 傾きが無い間はポインタで視点を動かす代替（プログレッシブ・エンハンスメント）
scene.addEventListener('pointermove', (e) => {
  if (caps.orientation === 'on') return;
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
        if (typeof DeviceMotionEvent?.requestPermission === 'function') {
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

// ---- ポインタ → 意味化（つつく・なでる・長押し：§5）----
// server は描画位置を知らないので、当たり判定と解釈はここ（client）の仕事
function partOf(e) {
  if (e.target.closest('.face')) return '顔';
  const r = tatazuka.getBoundingClientRect();
  return (e.clientY - r.top) < r.height * 0.45 ? '頭' : '体';
}

let p = null;
tatazuka.addEventListener('pointerdown', (e) => {
  tatazuka.setPointerCapture(e.pointerId);
  p = {
    lx: e.clientX, ly: e.clientY, dist: 0, sent: 0,
    part: partOf(e), done: false,
    long: setTimeout(() => {
      if (p && p.dist < 12) { sense('長押し', p.part); p.done = true; }
    }, 600),
  };
});
tatazuka.addEventListener('pointermove', (e) => {
  if (!p) return;
  p.dist += Math.hypot(e.clientX - p.lx, e.clientY - p.ly);
  p.lx = e.clientX; p.ly = e.clientY;
  if (p.dist - p.sent > 240) { // 「一なで分」たまるたびに繰り返し送る（§5-2）
    p.sent = p.dist;
    sense('なでる', p.part);
    p.done = true;
  }
});
tatazuka.addEventListener('pointerup', () => {
  if (!p) return;
  clearTimeout(p.long);
  if (!p.done && p.dist < 12) sense('つつく', p.part);
  p = null;
});

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
const handlers = {
  welcome() {},
  say(d) { face.say(d.text); if (d.mood) face.emote(d.mood); },
  emote(d) { face.emote(d.mood); },
  motion(d) { face.act(d.act); },
  presence(d) { face.presence(d.here); },
  error(d) { lastIn = 'error: ' + d.message; renderHud(); },
};
const link = connect({
  onMessage(msg) {
    lastIn = msg.type + (msg.data?.text ? `「${msg.data.text.slice(0, 12)}」` : '');
    renderHud();
    (handlers[msg.type] || (() => {}))(msg.data || {}); // 未知の型は黙って無視
  },
});

function send(msg) {
  lastOut = msg.type + (msg.data?.kind ? `(${msg.data.kind})` : '');
  renderHud();
  link.send(msg);
}
function sense(kind, part) {
  send({ type: 'sense', data: part ? { kind, part } : { kind } });
}

// ---- hello（§3-1）----
const label = new URLSearchParams(location.search).get('label') || '名無しの部屋';
const resumed = sessionStorage.getItem('tz-connected') === '1'; // 「さっきまで繋がってた」の自覚（§6-3）
send({ type: 'hello', data: { protocol: 0, label, resumed, caps: { ...caps } } });
helloSent = true;
sessionStorage.setItem('tz-connected', '1');
renderPerm();
renderHud();
