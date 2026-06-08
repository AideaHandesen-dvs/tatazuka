// 顔・演技まわり。protocol の意味論（mood / act / presence / say）を DOM に翻訳する層。
// このファイルを丸ごと差し替えれば顔が変わる（README §5「顔は差し替え可能」の継ぎ目）。

const tatazuka = document.getElementById('tatazuka');
const stage = document.getElementById('stage');
const puppet = tatazuka.querySelector('.puppet');
const balloon = document.getElementById('balloon');

// protocol §4-3 の語彙 → 実装の対応表。解釈できない値は黙って無視する（§4-1）
const MOODS = ['通常', '呆れ', '疑い', '喜び', '怒り', '照れ'];
const ACT_CLASS = {
  'うなずく': 'act-nod',
  '首を振る': 'act-shake',
  '跳ねる': 'act-jump',
  'こっちを見る': 'act-look',
};

export function emote(mood) {
  if (MOODS.includes(mood)) tatazuka.dataset.mood = mood;
}

export function act(name) {
  const cls = ACT_CLASS[name];
  if (!cls) return;
  puppet.classList.remove(...Object.values(ACT_CLASS));
  void puppet.offsetWidth; // 同じアニメを再始動させるためのリフロー
  puppet.classList.add(cls);
  puppet.addEventListener('animationend', () => puppet.classList.remove(cls), { once: true });
}

let sayTimer;
export function say(text) {
  balloon.textContent = text;
  balloon.hidden = false;
  balloon.classList.remove('fade');
  clearTimeout(sayTimer);
  // 暫定：protocol 上「台詞を消す」指示は無い（§4-2）。新しい say までの間、
  // 8秒で薄くするのは client の解釈の範囲とする。気になるなら protocol に clear を足す議論を。
  sayTimer = setTimeout(() => balloon.classList.add('fade'), 8000);
}

export function presence(here) {
  // here:false ＝ 誰もいない部屋。カメラ背景（透明な箱）だけが残る（protocol §6-1）
  document.body.classList.toggle('away', !here);
}

// 視点（傾き／マウス由来の角度）を見た目に反映。app.js から毎フレーム呼ばれる。
// CSS 顔では箱（#stage）ごと回す。VRM 顔（face-vrm.js）は同じ setView でカメラを動かす。
export function setView(cx, cy) {
  stage.style.transform = `rotateX(${cx.toFixed(2)}deg) rotateY(${cy.toFixed(2)}deg)`;
}
