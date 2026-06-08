// provider の HTTP リクエスト整形テスト（依存ゼロ・node:test）。
//   node --test server/persona-llm.provider.test.js
//
// global fetch をスタブして「どう叩くか」だけを固定する（実ネットは飛ばさない）。
// 押さえる地雷：
//   - ollama は /api/chat に stream:false / format:"json"（JSON 強制）で投げる
//   - claude は /v1/messages に x-api-key と anthropic-version、temperature 等は送らない
//     （Opus 4.8 は temperature/top_p を送ると 400。README「LLM persona」）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from './persona-llm.js';

// fetch を差し替えて、最後の呼び出し(url, init)を捕まえる。body は JSON.parse して返す
function stubFetch(responseJson) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, async json() { return responseJson; } };
  };
  return { calls, restore() { globalThis.fetch = orig; } };
}

test('ollama: /api/chat に stream:false・生成長/温度/stop を絞って投げ、message.content を返す', async (t) => {
  const f = stubFetch({ message: { content: '{"text":"よう","mood":"通常"}' } });
  t.after(f.restore);

  const p = createProvider({ TZ_LLM: 'ollama', TZ_LLM_MODEL: 'qwen2.5:3b', OLLAMA_HOST: 'http://localhost:11434' });
  const raw = await p.generate('SYS', 'USER');

  assert.equal(raw, '{"text":"よう","mood":"通常"}');
  const { url, body } = f.calls[0];
  assert.equal(url, 'http://localhost:11434/api/chat');
  assert.equal(body.stream, false);
  assert.equal(body.model, 'qwen2.5:3b');
  // 小型モデルの暴走対策：生成長を絞り・温度を下げ・特殊トークンで止める
  assert.equal(typeof body.options.num_predict, 'number');
  assert.ok(body.options.temperature <= 0.7);
  assert.ok(body.options.stop.includes('<|im_start|>'), '脱線トークンで停止');
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(body.messages[0].content, 'SYS');
});

test('claude: /v1/messages に x-api-key・anthropic-version、temperature は送らない', async (t) => {
  const f = stubFetch({ content: [{ type: 'text', text: '{"text":"やあ","mood":"喜び"}' }] });
  t.after(f.restore);

  const p = createProvider({ TZ_LLM: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test' });
  const raw = await p.generate('SYS', 'USER');

  assert.equal(raw, '{"text":"やあ","mood":"喜び"}');
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], 'sk-ant-test');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(body.model, 'claude-opus-4-8', '既定モデル');
  assert.equal(body.system, 'SYS', 'system はトップレベル（messages に混ぜない）');
  // ★Opus 4.8 で 400 になるパラメータが紛れ込んでいないこと
  for (const banned of ['temperature', 'top_p', 'top_k', 'budget_tokens']) {
    assert.ok(!(banned in body), `${banned} を送ってはいけない`);
  }
});

test('claude: ANTHROPIC_API_KEY 未設定なら generate は throw（→ 上位でルール表へ）', async () => {
  const p = createProvider({ TZ_LLM: 'claude' });
  await assert.rejects(() => p.generate('SYS', 'USER'), /ANTHROPIC_API_KEY/);
});

test('provider: HTTP エラー（!ok）は throw して上位のフォールバックに繋ぐ', async (t) => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, async json() { return {}; } });
  t.after(() => { globalThis.fetch = orig; });

  const p = createProvider({ TZ_LLM: 'ollama' });
  await assert.rejects(() => p.generate('SYS', 'USER'), /ollama 500/);
});
