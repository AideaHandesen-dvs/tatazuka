// talkmemory.js の契約テスト（依存ゼロ・node:test）。
//   node --test server/talkmemory.test.js
//
// 押さえる契約（protocol §5-4）：
//   - push した往復を古い順に recent() で返す
//   - 上限（既定 6 往復）を超えたら古いものから捨てる
//   - recent() はコピーを返す（外で壊しても記憶は無傷）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTalkMemory } from './talkmemory.js';

test('push した往復を古い順に返す', () => {
  const m = createTalkMemory();
  assert.deepEqual(m.recent(), []);
  m.push('寒くない？', '外9度だぞ');
  m.push('じゃあ暖房つけるか', 'さっき寒いって言ってたもんな');
  assert.deepEqual(m.recent(), [
    { user: '寒くない？', reply: '外9度だぞ' },
    { user: 'じゃあ暖房つけるか', reply: 'さっき寒いって言ってたもんな' },
  ]);
});

test('上限（既定 6）を超えたら古いものから捨てる', () => {
  const m = createTalkMemory();
  for (let i = 1; i <= 8; i++) m.push(`u${i}`, `r${i}`);
  const turns = m.recent();
  assert.equal(turns.length, 6);
  assert.equal(turns[0].user, 'u3'); // u1, u2 は忘れた
  assert.equal(turns[5].user, 'u8');
});

test('上限は opts.max で変えられる', () => {
  const m = createTalkMemory({ max: 2 });
  m.push('a', '1'); m.push('b', '2'); m.push('c', '3');
  assert.deepEqual(m.recent().map((t) => t.user), ['b', 'c']);
});

test('recent() はコピーを返す（外で壊しても記憶は無傷）', () => {
  const m = createTalkMemory();
  m.push('a', '1');
  const got = m.recent();
  got.pop();
  got.push({ user: 'x', reply: 'y' });
  assert.deepEqual(m.recent(), [{ user: 'a', reply: '1' }]);
});
