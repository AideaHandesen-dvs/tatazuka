// CHARACTER 外出し（ゴースト差し替え）の契約テスト（依存ゼロ・node:test）。
//   node --test server/persona-llm.character.test.js
//
// 押さえる契約（characters/README）：
//   - TZ_CHARACTER=<名前> で characters/<名前>.txt を読む。未設定なら tatazuka。
//   - 読めない/名前が不正（パストラバーサル）→ 組み込みの佇か(DEFAULT_CHARACTER)へ。
//   - createLLMPersona は選ばれたゴーストを system プロンプトに織り込み、出力契約は不変。

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCharacter, createLLMPersona, DEFAULT_CHARACTER } from './persona-llm.js';

// generate に渡る system / user を捕まえる provider スタブ
function captureProvider(raw) {
  const seen = {};
  return {
    seen,
    provider: { async generate(system, user) { seen.system = system; seen.user = user; return raw; } },
  };
}

test('既定（TZ_CHARACTER 未設定）は佇かを読む', () => {
  const c = loadCharacter({});
  assert.match(c, /佇か/);
  assert.match(c, /一人称：俺/);
});

test('TZ_CHARACTER=shitsuji は執事ゴーストを読む（佇かとは別人）', () => {
  const c = loadCharacter({ TZ_CHARACTER: 'shitsuji' });
  assert.match(c, /わたくし/);
  assert.match(c, /ご主人様/);
  assert.doesNotMatch(c, /一人称：俺/, '佇かの設定が混ざっていない');
});

test('TZ_CHARACTER=imouto は妹ゴーストを読む', () => {
  const c = loadCharacter({ TZ_CHARACTER: 'imouto' });
  assert.match(c, /あたし/);
  assert.match(c, /おにいちゃん/);
});

test('未知の名前は組み込みの佇か(DEFAULT_CHARACTER)へフォールバック', () => {
  assert.equal(loadCharacter({ TZ_CHARACTER: 'no_such_ghost' }), DEFAULT_CHARACTER);
});

test('パストラバーサルな名前は弾いてフォールバック（../ を解決しない）', () => {
  for (const bad of ['../persona', '../../package', 'a/b', 'foo.bar', '']) {
    assert.equal(loadCharacter({ TZ_CHARACTER: bad }), DEFAULT_CHARACTER, `name=${JSON.stringify(bad)}`);
  }
});

test('既定：system はゴースト専用、OUTPUT_RULE は user 側（生成直前）に添わる', async () => {
  const cap = captureProvider('{"text":"おはようございます","mood":"通常"}');
  const p = createLLMPersona({ provider: cap.provider, env: { TZ_CHARACTER: 'shitsuji' } });
  const r = await p.line('time.morning', { label: '書斎' });

  assert.deepEqual(r, { text: 'おはようございます', mood: '通常' });
  assert.match(cap.seen.system, /ご主人様/, 'ゴーストは system に入る');
  assert.doesNotMatch(cap.seen.system, /"text": "<台詞>"/, '既定では OUTPUT_RULE を system に置かない');
  assert.match(cap.seen.user, /"text": "<台詞>", "mood": "<気分>"/, 'JSON 契約は user 側に付く');
  assert.match(cap.seen.user, /通常 \/ 呆れ \/ 疑い \/ 喜び \/ 怒り \/ 照れ/, 'mood 語彙も user 側に');
  // 3B の照れ偏り是正：mood 選択ガイダンス（既定は通常・照れは照れ隠しだけ）が付く
  assert.match(cap.seen.user, /既定は「通常」/, 'mood の既定が通常だと示す');
  assert.match(cap.seen.user, /「照れ」は照れ隠しの時だけ/, '照れの濫用を抑えるガイダンス');
});

test('TZ_LLM_RULE_POS=system で旧挙動（契約を system 末尾）に戻せる', async () => {
  const cap = captureProvider('{"text":"よし","mood":"喜び"}');
  const p = createLLMPersona({ provider: cap.provider, env: { TZ_CHARACTER: 'shitsuji', TZ_LLM_RULE_POS: 'system' } });
  await p.line('idle');
  assert.match(cap.seen.system, /ご主人様/);
  assert.match(cap.seen.system, /"text": "<台詞>"/, '旧挙動では OUTPUT_RULE が system に戻る');
});

test('opts.character はファイルより優先（直接注入で差し替え）', async () => {
  const cap = captureProvider('{"text":"よし","mood":"喜び"}');
  const p = createLLMPersona({ provider: cap.provider, character: 'あなたはテスト用ゴースト。一人称はワタシ。' });
  await p.line('idle');
  assert.match(cap.seen.system, /テスト用ゴースト/);
  assert.match(cap.seen.user, /mood/, 'OUTPUT_RULE は user 側に添わる');
});
