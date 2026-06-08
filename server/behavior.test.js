// behavior.js の非同期 say の安全性テスト（依存ゼロ・node:test）。
//   node --test server/behavior.test.js
//
// LLM persona 化で line() を async にしたときの「唯一の落とし穴」（server/README）：
//   生成（数秒）の await 中にセッションが切れることがある。await の後に closed を
//   再チェックしてから送らないと、切断後に say が飛ぶ。ここをコードで固定する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from './behavior.js';

// 手で解決できる deferred な persona。line() を pending のまま握って切断を割り込ませる
function deferredPersona() {
  let resolveLine;
  const pending = new Promise((res) => { resolveLine = res; });
  return {
    persona: { line: () => pending },
    resolve: (ln) => resolveLine(ln),
  };
}

test('生成の await 中に close されたら say は送らない（切断後発話の防止）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sent = [];
  const { persona, resolve } = deferredPersona();
  const s = createSession({ send: (m) => sent.push(m), persona });

  s.receive({ type: 'hello', data: { protocol: 0, label: '居間' } });
  // hello は welcome / presence を即送り、greet は later(800ms) で予約される
  assert.ok(sent.some((m) => m.type === 'welcome'));
  assert.ok(sent.some((m) => m.type === 'presence'));

  t.mock.timers.tick(800);   // greet の later が発火 → say('greet') が p.line を await（pending）
  s.close();                 // ★生成待ちの最中に切断
  resolve({ text: '遅れて来た挨拶', mood: '通常' }); // ここで生成が“返ってくる”
  await Promise.resolve();   // say 内の await 後の継続（closed 再チェック）を走らせる

  assert.ok(!sent.some((m) => m.type === 'say'), 'close 後に say が漏れてはいけない');
});

test('正常時：生成が close 前に返れば say は送られる', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sent = [];
  const { persona, resolve } = deferredPersona();
  const s = createSession({ send: (m) => sent.push(m), persona });

  s.receive({ type: 'hello', data: { protocol: 0, label: '居間' } });
  t.mock.timers.tick(800);
  resolve({ text: 'よう', mood: '通常' });
  await Promise.resolve();

  const say = sent.find((m) => m.type === 'say');
  assert.ok(say, 'close していなければ say は届く');
  assert.equal(say.data.text, 'よう');
  s.close();
});

test('protocol 不一致の hello は error を返し、人格は動かさない', () => {
  const sent = [];
  const s = createSession({ send: (m) => sent.push(m), persona: { line: () => ({ text: 'x', mood: '通常' }) } });
  s.receive({ type: 'hello', data: { protocol: 99 } });
  assert.deepEqual(sent, [{ type: 'error', data: { message: 'protocol version mismatch' } }]);
  s.close();
});
