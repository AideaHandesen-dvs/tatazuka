// persona-llm.js の契約テスト（依存ゼロ・node:test）。
//   node --test server/persona-llm.test.js
//
// ここで裏付ける設計契約（server/README「LLM persona」）：
//   1. フォールバックは常にルール表（LLM 不在・反応系・未知・失敗・タイムアウト・壊れた出力）
//   2. 環境系の situation だけ LLM に投げる（反応系 sense.* は provider を呼ばない＝即レス死守）
//   3. mood は protocol §4-3 の語彙に丸める
//   4. parseLine は前後に散文があっても最初の {...} を拾う／空 text は捨てる
//   5. createProvider は env を見て ollama / claude / null を返す

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLLMPersona, createProvider } from './persona-llm.js';

// 固定の台詞を返す“ルール床”。フォールバックがここに落ちたか判定するための番兵。
function stubFallback() {
  return { line: (situation) => ({ text: `RULE:${situation}`, mood: '通常' }) };
}

// 任意の生テキストを返す provider。calls に呼ばれた situation 説明を記録する
function stubProvider(raw, calls) {
  return {
    async generate(system, user) {
      if (calls) calls.push(user);
      return raw;
    },
  };
}

test('LLM オフ（provider=null）は全 situation をルール表へ', async () => {
  const p = createLLMPersona({ provider: null, fallback: stubFallback() });
  for (const s of ['greet', 'idle', 'time.night', 'work.180', 'sense.poke.soft']) {
    assert.deepEqual(await p.line(s), { text: `RULE:${s}`, mood: '通常' });
  }
});

test('反応系（sense.*）は provider があっても呼ばずルール表へ＝即レス死守', async () => {
  const calls = [];
  const p = createLLMPersona({
    provider: stubProvider('{"text":"生成","mood":"喜び"}', calls),
    fallback: stubFallback(),
  });
  const r = await p.line('sense.shake');
  assert.deepEqual(r, { text: 'RULE:sense.shake', mood: '通常' });
  assert.equal(calls.length, 0, 'sense.* で LLM を呼んではいけない');
});

test('未知の situation はルール表へ（provider を呼ばない）', async () => {
  const calls = [];
  const p = createLLMPersona({ provider: stubProvider('{"text":"x"}', calls), fallback: stubFallback() });
  assert.deepEqual(await p.line('nope.unknown'), { text: 'RULE:nope.unknown', mood: '通常' });
  assert.equal(calls.length, 0);
});

test('環境系の situation は LLM 出力を採用する', async () => {
  const calls = [];
  const p = createLLMPersona({
    provider: stubProvider('{"text":"よう、また夜更かしか","mood":"呆れ"}', calls),
    fallback: stubFallback(),
  });
  const r = await p.line('time.deepnight', { label: 'リビング' });
  assert.deepEqual(r, { text: 'よう、また夜更かしか', mood: '呆れ' });
  assert.equal(calls.length, 1, '環境系は LLM を一度呼ぶ');
});

test('部屋（端末）の名前は greet 系だけプロンプトに添える（機械的な名前連呼を防ぐ）', async () => {
  const calls = [];
  const p = createLLMPersona({ provider: stubProvider('{"text":"よう"}', calls), fallback: stubFallback() });
  await p.line('greet', { label: 'リビング' });
  assert.match(calls[0], /リビング/, 'greet では label を織り込む');
  await p.line('idle', { label: 'リビング' });
  assert.doesNotMatch(calls[1], /リビング/, 'idle 等では label を渡さない');
  await p.line('greet'); // label 無しでも壊れない（部屋名の行ごと省く）
  assert.doesNotMatch(calls[2], /部屋（端末）の名前/);
});

test('天気 situation は ctx.weather をプロンプトに織り込む', async () => {
  const calls = [];
  const p = createLLMPersona({ provider: stubProvider('{"text":"傘は"}', calls), fallback: stubFallback() });
  await p.line('weather.rain.start', { label: '居間', weather: { desc: '雨', tempC: 18.4, city: '東京都' } });
  assert.match(calls[0], /東京都は雨、気温18度/, '都市・空模様・気温が入る');
});

test('再接続直後の greet.resumed も LLM 経路に乗る', async () => {
  const calls = [];
  const p = createLLMPersona({
    provider: stubProvider('{"text":"…また落ちてたぞ","mood":"怒り"}', calls),
    fallback: stubFallback(),
  });
  const r = await p.line('greet.resumed');
  assert.deepEqual(r, { text: '…また落ちてたぞ', mood: '怒り' });
  assert.equal(calls.length, 1, 'greet.resumed は LLM_SITUATIONS に含まれる');
});

test('protocol 外の mood は「通常」に丸める', async () => {
  const p = createLLMPersona({
    provider: stubProvider('{"text":"やあ","mood":"ハッピー"}'),
    fallback: stubFallback(),
  });
  assert.deepEqual(await p.line('greet'), { text: 'やあ', mood: '通常' });
});

test('前後に散文・コードブロックが混じっても最初の {...} を拾う', async () => {
  const raw = 'はい、これが出力です：\n```json\n{"text":"ふぁ…","mood":"通常"}\n```\nどうぞ。';
  const p = createLLMPersona({ provider: stubProvider(raw), fallback: stubFallback() });
  assert.deepEqual(await p.line('idle'), { text: 'ふぁ…', mood: '通常' });
});

test('寛容抽出：mood の閉じ引用符落ち（"呆れ}）でも text/mood を救済する', async () => {
  // 3B が頻発させる壊れ方。厳格 JSON.parse は失敗するが台詞は拾えるべき
  const p = createLLMPersona({
    provider: stubProvider('{"text": "お前、また寝落ちか？", "mood": "呆れ}'),
    fallback: stubFallback(),
  });
  assert.deepEqual(await p.line('desk.away'), { text: 'お前、また寝落ちか？', mood: '呆れ' });
});

test('寛容抽出：JSON の後ろにゴミtrailingが続いても最初の正しい値を拾う', async () => {
  const p = createLLMPersona({
    provider: stubProvider('{"text":"よう","mood":"通常"}<|im_start|>ゴミ続き...'),
    fallback: stubFallback(),
  });
  assert.deepEqual(await p.line('greet'), { text: 'よう', mood: '通常' });
});

test('後処理：text に紛れた mood 語の行を落とす（mood は保つ）', async () => {
  const p = createLLMPersona({
    provider: stubProvider('{"text":"早く帰りなさいよ。\\n照れ","mood":"照れ"}'),
    fallback: stubFallback(),
  });
  assert.deepEqual(await p.line('idle'), { text: '早く帰りなさいよ。', mood: '照れ' });
});

test('後処理：同じ行に「／照れ」形式で漏れた末尾 mood タグを剥がす（mood は保つ）', async () => {
  // 3B が改行せず本文と同じ行に mood をくっつける癖（実測：おぼろの "寒いねのう／照れ"）。
  // 区切り（／）や括弧で付いた末尾 mood だけを落とし、mood フィールドは別途保つ。
  const cases = [
    ['寒いねのう／照れ', '寒いねのう'],
    ['よし /喜び', 'よし'],
    ['傘を持っていけ（怒り）', '傘を持っていけ'],
    ['まだ起きてんのか〜呆れ', 'まだ起きてんのか'],
  ];
  for (const [raw, want] of cases) {
    const p = createLLMPersona({
      provider: stubProvider(`{"text":"${raw}","mood":"照れ"}`),
      fallback: stubFallback(),
    });
    assert.deepEqual(await p.line('idle'), { text: want, mood: '照れ' }, `raw=${JSON.stringify(raw)}`);
  }
});

test('後処理：「／」で言い回しを並べ続ける run-on は最初の節で断つ', async () => {
  // 3B が敬語/古語ゴーストで頻発させる run-on（実測：おぼろの "…かや／わし、…／わし、…"）。
  // ／ は一言に本来不要なので最初の節だけ残す。残った末尾 mood タグもまとめて剥がす。
  const cases = [
    ['雨じゃな／ぬしの傘かくかや', '雨じゃな'],
    ['ぬし、楽しむかや／わし、悪くないじゃ／わし、適度じゃ／ぬし、取り直すかや', 'ぬし、楽しむかや'],
    ['ご主人様、休んでくださいませ／わたくし、お疲れ様でございます', 'ご主人様、休んでくださいませ'],
  ];
  for (const [raw, want] of cases) {
    const p = createLLMPersona({
      provider: stubProvider(`{"text":"${raw}","mood":"通常"}`),
      fallback: stubFallback(),
    });
    assert.deepEqual(await p.line('idle'), { text: want, mood: '通常' }, `raw=${JSON.stringify(raw)}`);
  }
});

test('後処理：本文が自然に mood 語で終わるとき（区切り無し）は剥がさない', async () => {
  // "今日は怒り心頭だ" のように mood 語が本文の一部なら触らない（区切り／括弧が無いので対象外）
  const p = createLLMPersona({
    provider: stubProvider('{"text":"お前にはほとほと呆れ","mood":"呆れ"}'),
    fallback: stubFallback(),
  });
  assert.deepEqual(await p.line('idle'), { text: 'お前にはほとほと呆れ', mood: '呆れ' });
});

test('後処理：改行を畳み、2文を超えたら頭2文に詰める', async () => {
  const p = createLLMPersona({
    provider: stubProvider('{"text":"一文目だ。\\n二文目だ。三文目は要らん。","mood":"通常"}'),
    fallback: stubFallback(),
  });
  assert.deepEqual(await p.line('idle'), { text: '一文目だ。二文目だ。', mood: '通常' });
});

test('壊れた出力（JSON なし・空 text）はルール表へフォールバック', async () => {
  const cases = ['ここに JSON は無い', '{"mood":"喜び"}', '{"text":"   "}', '{壊れ', ''];
  for (const raw of cases) {
    const p = createLLMPersona({ provider: stubProvider(raw), fallback: stubFallback() });
    assert.deepEqual(await p.line('greet'), { text: 'RULE:greet', mood: '通常' }, `raw=${JSON.stringify(raw)}`);
  }
});

test('provider が throw したらルール表へフォールバック', async () => {
  const p = createLLMPersona({
    provider: { async generate() { throw new Error('ollama 500'); } },
    fallback: stubFallback(),
  });
  assert.deepEqual(await p.line('work.60'), { text: 'RULE:work.60', mood: '通常' });
});

test('生成がタイムアウトしたら（signal abort）ルール表へフォールバック', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // signal が abort されたら reject する＝実装の AbortController を実際に効かせる
  const hanging = {
    generate(system, user, signal) {
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
  const p = createLLMPersona({ provider: hanging, fallback: stubFallback() });
  const pending = p.line('idle');
  t.mock.timers.tick(8000); // TIMEOUT_MS。abort が走る
  assert.deepEqual(await pending, { text: 'RULE:idle', mood: '通常' });
});

test('createProvider は env を見て provider/null を切り替える', () => {
  assert.equal(createProvider({}), null, 'TZ_LLM 未設定なら null（LLM オフ）');
  assert.equal(createProvider({ TZ_LLM: 'なにか' }), null, '未知の値も null');
  assert.ok(createProvider({ TZ_LLM: 'ollama' }), 'ollama で provider');
  assert.ok(createProvider({ TZ_LLM: 'claude' }), 'claude で provider');
});
