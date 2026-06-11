// hub.js の統合テスト（依存ゼロ・node:test）。ソケットを使わず、部屋ごとの送信を配列に貯めて
// 「佇かが一度に一箇所」になることを確認する。脳・persona は本物を使う（活性の継ぎ目まで通す）。
//   node --test server/hub.test.js
//
// 押さえる契約（protocol §6-1）：
//   - 最初の部屋に居つく（welcome＋presence:true、やがて greet）
//   - 先客が居れば後の部屋は空き（welcome は来るが presence:false・喋らない）
//   - 空き部屋を つつくと そこへ移動（先客は presence:false・移動側は presence:true＋反応／挨拶はしない）
//   - 居る部屋が切れたら残った部屋へ移る
//   - broadcast=true は退化形（全部屋に居る）
//   - protocol 不一致の部屋は occupant にならない

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from './hub.js';
import { createSession } from './behavior.js';
import { createPersona } from './persona.js';

const FIXED = new Date('2026-06-09T14:00:00').getTime(); // 昼・固定（時刻帯バンド変化なし）
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function makeHub(broadcast) {
  return createHub({
    broadcast,
    // tickMs は大きく（暇つぶしの随時発話を 800ms 級のテスト中に起こさない）
    makeSession: (opts) => createSession({ persona: createPersona(), now: () => FIXED, tickMs: 100000, ...opts }),
  });
}
function room(hub, label) {
  const sent = [];
  const r = hub.connect((obj) => sent.push(obj));
  return {
    sent,
    hello: (resumed) => r.receive({ type: 'hello', data: { protocol: 0, label, resumed } }),
    helloBad: () => r.receive({ type: 'hello', data: { protocol: 99 } }),
    sense: (kind) => r.receive({ type: 'sense', data: { kind } }),
    talk: (text) => r.receive({ type: 'talk', data: { text } }),
    close: () => r.close(),
  };
}
const types = (s) => s.map((m) => m.type);
const presences = (s) => s.filter((m) => m.type === 'presence').map((m) => m.data.here);
const says = (s) => s.filter((m) => m.type === 'say').map((m) => m.data.text);

test('1部屋：hello で welcome＋presence:true、やがて greet', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const a = room(makeHub(), '居間');
  a.hello();
  assert.deepEqual(types(a.sent), ['welcome', 'presence']);
  assert.deepEqual(presences(a.sent), [true]);
  t.mock.timers.tick(800); await flush();
  assert.ok(says(a.sent).some((x) => x.includes('居間')), 'greet が部屋名込みで届く');
});

test('2部屋：先客が居れば後の部屋は空き（welcome は来るが presence:false）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const hub = makeHub();
  const a = room(hub, 'A'); a.hello();
  const b = room(hub, 'B'); b.hello();
  assert.deepEqual(presences(a.sent), [true], 'A に佇かが居る');
  assert.ok(types(b.sent).includes('welcome'), 'B にも握手の welcome は届く');
  assert.deepEqual(presences(b.sent), [false], 'B は空き部屋（presence:false）');
});

test('空き部屋を つつくと そこへ移動する（先客は空き・移動側は反応／挨拶はしない）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const hub = makeHub();
  const a = room(hub, 'A'); a.hello();
  const b = room(hub, 'B'); b.hello();
  t.mock.timers.tick(800); await flush(); // A の greet を消化
  a.sent.length = 0; b.sent.length = 0;   // ここからの差分を見る

  b.sense('つつく'); await flush();
  assert.deepEqual(presences(a.sent), [false], '先客 A は空く');
  assert.deepEqual(presences(b.sent), [true], 'B に佇かが移る');
  assert.ok(says(b.sent).length >= 1, 'B で sense の反応が喋る');
  assert.ok(!says(b.sent).some((x) => x.includes('ここが')), '移動では greet しない');
});

test('空き部屋に話しかけても そこへ移動して返事する（protocol §5-4・挨拶はしない）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const hub = makeHub();
  const a = room(hub, 'A'); a.hello();
  const b = room(hub, 'B'); b.hello();
  t.mock.timers.tick(800); await flush(); // A の greet を消化
  a.sent.length = 0; b.sent.length = 0;   // ここからの差分を見る

  b.talk('おい、こっち来いよ'); await flush();
  assert.deepEqual(presences(a.sent), [false], '先客 A は空く');
  assert.deepEqual(presences(b.sent), [true], 'B に佇かが移る');
  assert.ok(b.sent.some((m) => m.type === 'motion' && m.data.act === 'うなずく'), '移った先で頷く（間）');
  assert.ok(says(b.sent).length >= 1, 'B で返事（相槌の床）が喋る');
  assert.ok(!says(b.sent).some((x) => x.includes('ここが')), '移動では greet しない');
});

test('居る部屋が切れたら、残った部屋へ移る', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const hub = makeHub();
  const a = room(hub, 'A'); a.hello();
  const b = room(hub, 'B'); b.hello();
  t.mock.timers.tick(800); await flush();
  b.sent.length = 0;

  a.close(); // 佇かが居る A が切れる
  assert.deepEqual(presences(b.sent), [true], 'B に佇かが移る');
  t.mock.timers.tick(800); await flush();
  assert.ok(says(b.sent).some((x) => x.includes('B')), '移った先 B で greet');
});

test('broadcast：全部屋に佇かが居る（退化形・デバッグ）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const hub = makeHub(true);
  const a = room(hub, 'A'); a.hello();
  const b = room(hub, 'B'); b.hello();
  assert.deepEqual(presences(a.sent), [true]);
  assert.deepEqual(presences(b.sent), [true]);
});

test('protocol 不一致の部屋は occupant にならない（次の正しい部屋が居つく）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const hub = makeHub();
  const bad = room(hub, 'X'); bad.helloBad();
  assert.deepEqual(types(bad.sent), ['error'], '不一致は error だけ（welcome/presence 無し）');
  const a = room(hub, 'A'); a.hello();
  assert.deepEqual(presences(a.sent), [true], '正しい部屋が居つく');
});
