// VRM アバターの顔レイヤ（上位レイヤ＝enhancement）。CSS の卵（face.js）と同じ顔を実装する：
//   createVRMFace({scene, modelUrl}) → { emote, act, say, presence, setView }
// app.js は WebGL が効く端末でだけこれを動的 import し、失敗すれば CSS にフォールバックする。
//
// Three.js / three-vrm はリポに vendor 済み（client/vendor/、importmap で "three" を解決）。
// バンドラ不要＝ビルド済み ESM を配るだけ。外部 CDN に依存しない（オリジン一つ・オフライン可）。
//
// ※ このファイルは three.js を静的 import するため、iOS 12 等の古い Safari ではパースできない。
//   それでよい：app.js 側の import() が reject し、CSS の卵にフォールバックする（設計通り）。

import * as THREE from 'three';
import { GLTFLoader } from './vendor/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from './vendor/three-vrm.module.js';

// mood（protocol §4-3）→ VRM 標準表情の重み
const EXPR = {
  '通常': {},
  '喜び': { happy: 1 },
  '怒り': { angry: 1 },
  '呆れ': { relaxed: 0.7 },
  '疑い': { surprised: 0.5 },
  '照れ': { happy: 0.6 },
};
const ALL_EXPR = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];

// turn=モデルの向き(半回転数, 既定1=180°でカメラを向く), dist=顔までの距離,
// yOffset=注視点の高さ補正, arms=腕を下げる角度(rad, T字→Aポーズ。0で無効、符号反転で上下逆)
// ※ 見た目はヘッドレスで確認できないため、これらは ?turn= ?dist= ?y= ?arms= で実機から微調整できる
export async function createVRMFace({ scene: host, modelUrl, turn = 1, dist = 0.95, yOffset = 0, arms = 1.0 }) {
  // ---- レンダラ（背景透過：カメラ映像＝透明な箱が後ろに透ける）----
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;right:0;bottom:0;left:0;width:100%;height:100%;';
  host.appendChild(canvas);

  // antialias(MSAA) は全画面×高DPIだと描画バッファを数倍に膨らませ、モデルの軽重と無関係に
  // 非力な端末の GPU を巻き込んで落とす（軽量モデルでも同じ白画面＝犯人はこちら）。透過する箱の
  // 中の顔でギザは目立たないので切る。解像度倍率も控えめにして安全側へ（低性能端末対応・README）。
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(1, 2, 2);
  scene.add(dir);

  // ---- VRM 読み込み ----
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(modelUrl);
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('not a VRM');

  if (VRMUtils.removeUnnecessaryVertices) VRMUtils.removeUnnecessaryVertices(gltf.scene);
  if (VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(gltf.scene);
  vrm.scene.rotation.y = Math.PI * turn; // three-vrm は -Z 向きに正規化。既定でカメラ（+Z 側）を向かせる
  scene.add(vrm.scene);

  // T字ポーズ → A字ポーズ（腕を下げる）。VRM に静止ポーズは無いのでこちらで整える
  const armL = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
  const armR = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
  if (armL) armL.rotation.z = arms;
  if (armR) armR.rotation.z = -arms;

  // 顔の高さを測ってフレーミング
  const head = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('head');
  const headPos = new THREE.Vector3(0, 1.35, 0);
  if (head) head.getWorldPosition(headPos);
  const target = headPos.clone();
  target.y += yOffset;
  const baseR = dist; // カメラ距離（顔〜上半身が入る）

  // 視線追従：目をカメラ（＝覗き込む視点）に向ける。覗き込むと見返してくる
  if (vrm.lookAt) vrm.lookAt.target = camera;

  // ---- 状態 ----
  let viewX = 0, viewY = 0;        // setView から（度）
  const exprTarget = {};           // 表情の目標重み（lerp で寄せる）
  let act = null;                  // 進行中の動き {kind, t, dur}
  const clock = new THREE.Clock();

  function resize() {
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- 描画ループ ----
  function placeCamera() {
    // viewY=ヨー（左右の覗き込み）, viewX=ピッチ（上下）。target の周りを小さく回る
    const yaw = THREE.MathUtils.degToRad(viewY);
    const pitch = THREE.MathUtils.degToRad(viewX);
    camera.position.set(
      target.x + baseR * Math.sin(yaw) * Math.cos(pitch),
      target.y + baseR * Math.sin(pitch),
      target.z + baseR * Math.cos(yaw) * Math.cos(pitch),
    );
    camera.lookAt(target);
  }

  function applyAct(node) {
    // head 等に動きを乗せる。node が無ければ何もしない
    if (!act) return;
    const k = act.t / act.dur;        // 0→1
    const wave = Math.sin(k * Math.PI); // 0→1→0 の山
    if (act.kind === 'nod' && node.head) node.head.rotation.x += 0.5 * Math.sin(k * Math.PI * 2);
    else if (act.kind === 'shake' && node.head) node.head.rotation.y += 0.5 * Math.sin(k * Math.PI * 3);
    else if (act.kind === 'jump') vrm.scene.position.y = 0.25 * wave;
    else if (act.kind === 'look' && node.head) node.head.rotation.x += -0.15 * wave;
  }

  function render() {
    const dt = clock.getDelta();
    placeCamera();

    // 表情を目標へ寄せる
    if (vrm.expressionManager) {
      for (const name of ALL_EXPR) {
        const cur = vrm.expressionManager.getValue(name) || 0;
        const tgt = exprTarget[name] || 0;
        vrm.expressionManager.setValue(name, cur + (tgt - cur) * Math.min(1, dt * 12));
      }
    }

    // 動きの適用（head rotation は毎フレーム 0 から積む）
    const node = { head: vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('head') };
    if (node.head) node.head.rotation.set(0, 0, 0);
    if (act) {
      act.t += dt;
      applyAct(node);
      if (act.t >= act.dur) { act = null; vrm.scene.position.y = 0; }
    }

    vrm.update(dt);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(render);
  }
  let raf = requestAnimationFrame(render);

  // ---- 吹き出し（VRM モードは画面上部に出す。CSS 顔の #balloon とは別物）----
  const balloon = document.createElement('div');
  balloon.id = 'vrm-balloon';
  balloon.style.cssText =
    'position:fixed;z-index:4;top:18px;left:50%;transform:translateX(-50%);max-width:80vw;' +
    'padding:10px 16px;background:rgba(255,255,255,.96);color:#222;border-radius:12px;' +
    'font:15px/1.6 sans-serif;transition:opacity .5s;';
  balloon.hidden = true;
  document.body.appendChild(balloon);
  let sayTimer;

  // ---- 顔インターフェース（face.js と同じ顔）----
  return {
    emote(mood) {
      const map = EXPR[mood] || {};
      for (const name of ALL_EXPR) exprTarget[name] = map[name] || 0;
    },
    act(name) {
      const M = { 'うなずく': 'nod', '首を振る': 'shake', '跳ねる': 'jump', 'こっちを見る': 'look' };
      const kind = M[name];
      if (kind) act = { kind, t: 0, dur: 0.9 };
    },
    say(text) {
      balloon.textContent = text;
      balloon.hidden = false;
      balloon.style.opacity = '1';
      clearTimeout(sayTimer);
      sayTimer = setTimeout(() => { balloon.style.opacity = '0'; }, 8000);
    },
    presence(here) {
      canvas.style.transition = 'opacity .8s';
      canvas.style.opacity = here ? '1' : '0';
      if (!here) balloon.style.opacity = '0';
    },
    setView(cx, cy) { viewX = cx; viewY = cy; },
  };
}
