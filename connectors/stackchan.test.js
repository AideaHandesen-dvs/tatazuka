// stackchan.js の契約テスト（依存ゼロ・node:test）。駆動ロジック（makeBody/handle）を log 注入で固定し、
// 実 server にも WebSocket にも繋がない（import 時に副作用ゼロ＝直接実行ガードのおかげ）。
//   node --test connectors/stackchan.test.js
//
// 押さえる契約（出力コネクタ＝v0 を喋るもう一つの client・protocol §4-1/§4-2）：
//   - 意味論型語彙が「別の身体」（サーボ/LED/口）に翻訳される（mood→LED色+目・act→サーボ・say→口パク）
//   - say＋mood はアトミック＝表情（emote）と口（say）が同時に出る（§4-2）
//   - presence here で起きる/寝る
//   - **解釈できない mood/act・未知の型は黙って無視＝何も駆動しない**（§4-1 が語彙レベルまで貫通）

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBody, handle } from './stackchan.js';

// log を配列に溜める body を作る（実機なら NeoPixel/servo の駆動に当たる）。
function rig() {
  const lines = [];
  return { lines, body: makeBody({ log: (s) => lines.push(s) }) };
}

test('emote：mood → LED 色＋目の形（意味論型を物理表現へ翻訳）', () => {
  const { lines, body } = rig();
  handle(body, { type: 'emote', data: { mood: '喜び' } });
  handle(body, { type: 'emote', data: { mood: '照れ' } });
  assert.match(lines[0], /\[emote\] 喜び → \[LED\]黄 \[目\]＾ ＾/);
  assert.match(lines[1], /照れ.*\[LED\]桃.*\[頬LED\]on/); // 照れは頬LED も点く
});

test('motion：act → サーボのジェスチャ', () => {
  const { lines, body } = rig();
  handle(body, { type: 'motion', data: { act: 'こっちを見る' } });
  assert.match(lines[0], /\[motion\] こっちを見る → \[サーボ\]pan 0°, tilt \+10°/);
});

test('say＋mood はアトミック：表情（emote）と口パク（say）が同時に出る（§4-2）', () => {
  const { lines, body } = rig();
  handle(body, { type: 'say', data: { text: 'それ3時間やってるぞ', mood: '呆れ' } });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[emote\] 呆れ → \[LED\]青白/); // 先に表情
  assert.match(lines[1], /\[say\] 「それ3時間やってるぞ」 → \[口パク\]◦+（10音）/); // 次に口
});

test('mood の無い say は口パクだけ（表情は触らない）', () => {
  const { lines, body } = rig();
  handle(body, { type: 'say', data: { text: 'ふぁ…。' } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[say\] 「ふぁ…。」 → \[口パク\]◦◦◦◦（4音）/);
});

test('presence：here=true で起きる / here=false で寝る', () => {
  const { lines, body } = rig();
  handle(body, { type: 'presence', data: { here: false } });
  handle(body, { type: 'presence', data: { here: true } });
  assert.match(lines[0], /here=false → 寝る/);
  assert.match(lines[1], /here=true → 起きる/);
});

test('解釈できない mood / act は黙って無視＝何も駆動しない（§4-1）', () => {
  const { lines, body } = rig();
  handle(body, { type: 'emote', data: { mood: '知らない気分' } });
  handle(body, { type: 'motion', data: { act: '謎の踊り' } });
  assert.deepEqual(lines, []); // サーボも LED も動かない
});

test('未知のメッセージ型は黙って無視（§4-1 が語彙レベルまで貫通）', () => {
  const { lines, body } = rig();
  handle(body, { type: 'tilt_stream', data: { x: 1 } }); // 将来追加されうる未知の型
  handle(body, { type: 'whatever', data: {} });
  assert.deepEqual(lines, []);
});

test('welcome / error も身体のログに出る（接続の儀式の可視化）', () => {
  const { lines, body } = rig();
  handle(body, { type: 'welcome', data: { protocol: 0 } });
  handle(body, { type: 'error', data: { message: 'protocol version mismatch' } });
  assert.match(lines[0], /\[welcome\] protocol 0/);
  assert.match(lines[1], /\[error\] protocol version mismatch/);
});
