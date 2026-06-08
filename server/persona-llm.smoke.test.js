// 実 LLM スモーク（依存ゼロ・node:test）。ローカル ollama に実際に 1 回投げ、
// 出力契約（JSON {text, mood}・mood が protocol §4-3 の語彙）が通ることを確かめる。
//   node --test server/persona-llm.smoke.test.js
//
// ollama が無い環境（CI 等）では skip する＝テストを汚さない。モデルは README が
// 標準化した qwen2.5:3b。別モデルで回したいときは TZ_SMOKE_MODEL で上書き。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLLMPersona, createProvider } from './persona-llm.js';

const HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL = process.env.TZ_SMOKE_MODEL || 'qwen2.5:3b';
const MOODS = new Set(['通常', '呆れ', '疑い', '喜び', '怒り', '照れ']);

// ollama が起動していて目的のモデルがあるか（短いタイムアウトで）。無ければ skip 理由を返す
async function probe() {
  try {
    const r = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return `ollama ${r.status}`;
    const j = await r.json();
    const has = Array.isArray(j.models) && j.models.some((m) => m.name === MODEL || m.model === MODEL);
    return has ? null : `model ${MODEL} 未取得（ollama pull ${MODEL}）`;
  } catch (e) {
    return `ollama 未起動（${HOST}）`;
  }
}

const skip = await probe();
// node:test は { skip } の“キーの存在”だけで skip 扱いにする（値が null でも）。
// だから理由がある時だけ skip オプションを載せる。
const opts = skip ? { skip } : {};

test('ollama 実生成：環境系 situation が JSON 契約を満たす台詞を返す', opts, async (t) => {
  // フォールバックは番兵。これが返ってきたら「LLM が JSON を出せなかった」と分かる
  const SENTINEL = { text: '__fallback__', mood: '通常' };
  const p = createLLMPersona({
    provider: createProvider({ TZ_LLM: 'ollama', TZ_LLM_MODEL: MODEL, OLLAMA_HOST: HOST }),
    fallback: { line: () => SENTINEL },
  });

  // 初回はモデルのコールド起動で 8s を超えがち（特にテスト並列実行時）。
  // フォールバックに落ちたら一度だけ温まった状態で再挑戦する（一過性のフレーク対策）。
  let r = await p.line('time.deepnight', { label: '仕事部屋' });
  if (JSON.stringify(r) === JSON.stringify(SENTINEL)) r = await p.line('time.deepnight', { label: '仕事部屋' });
  t.diagnostic(`生成: ${JSON.stringify(r)}`);

  assert.notDeepEqual(r, SENTINEL, 'LLM が 8s 内に有効な JSON を返せていない（フォールバックに落ちた）');
  assert.equal(typeof r.text, 'string');
  assert.ok(r.text.trim().length > 0, 'text が空でない');
  assert.ok(MOODS.has(r.mood), `mood が語彙内（got: ${r.mood}）`);
});
