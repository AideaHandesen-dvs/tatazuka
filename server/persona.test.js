// persona.js（ルールベースの台詞生成）の契約テスト（依存ゼロ・node:test）。
//   node --test server/persona.test.js
//
// 押さえる契約：
//   - 未知 situation → null（behavior 側はそれを許容＝何も喋らない）
//   - 既知 situation → { text, mood }・mood は protocol §4-3 の語彙
//   - {label}/{since} は ctx から差し込む（残骸を残さない）
//   - 連続非反復：複数行テーブルは直前と同じ行を続けて出さない（乱数値に依らない不変条件）
//   - テーブル整合：TABLES 全エントリが [非空文字列, §4-3 mood]（手書き大テーブルの typo 検出）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersona, TABLES } from './persona.js';

// protocol §4-3 の mood 語彙（persona.js ヘッダと一致）
const MOODS = new Set(['通常', '呆れ', '疑い', '喜び', '怒り', '照れ']);

test('未知 situation → null', () => {
  const p = createPersona();
  assert.equal(p.line('存在しないタグ'), null);
  assert.equal(p.line(''), null);
  assert.equal(p.line(undefined), null);
});

test('既知 situation → {text, mood}・mood は §4-3 語彙', () => {
  const p = createPersona();
  const r = p.line('idle');
  assert.ok(r && typeof r.text === 'string' && r.text.length > 0);
  assert.ok(MOODS.has(r.mood), `mood が語彙内: ${r.mood}`);
});

test('{label} を ctx.label で差し込み、残骸を残さない', () => {
  const p = createPersona();
  // greet は全行 {label} を含む。何度引いても label が入り {label} は消える
  for (let i = 0; i < 20; i++) {
    const r = p.line('greet', { label: '書斎' });
    assert.ok(r.text.includes('書斎'), `label 反映: ${r.text}`);
    assert.ok(!r.text.includes('{label}'), `残骸なし: ${r.text}`);
  }
});

test('{since} を ctx.since で差し込む（再会）', () => {
  const p = createPersona();
  for (let i = 0; i < 20; i++) {
    const r = p.line('greet.reunion', { label: '居間', since: '3日' });
    assert.ok(!r.text.includes('{since}') && !r.text.includes('{label}'), `残骸なし: ${r.text}`);
    assert.ok(r.text.includes('3日'), `since 反映: ${r.text}`);
  }
});

test('ctx 無しでも落ちない（プレースホルダは素のまま返る）', () => {
  const p = createPersona();
  const r = p.line('greet'); // ctx 無し
  assert.ok(r && typeof r.text === 'string');
});

test('連続非反復：複数行テーブルは直前と同じ台詞を続けない', () => {
  const p = createPersona();
  // 行数の多いものと少ないものの両方で。乱数に依らず成立すべき不変条件。
  for (const sit of ['idle', 'desk.back', 'home.back']) {
    let prev = null;
    for (let i = 0; i < 300; i++) {
      const cur = p.line(sit).text;
      assert.notEqual(cur, prev, `${sit}: 直前と同じ台詞を続けて出した`);
      prev = cur;
    }
  }
});

test('1行テーブルは毎回同じ（非反復ロジックが length=1 で暴発しない）', () => {
  const p = createPersona();
  // nudge.orientation は 1 行。毎回同じ text を返す（i+1 % 1 で固定）
  const first = p.line('nudge.orientation').text;
  for (let i = 0; i < 10; i++) assert.equal(p.line('nudge.orientation').text, first);
});

test('テーブル整合：全エントリが [非空文字列, §4-3 mood]', () => {
  for (const [sit, rows] of Object.entries(TABLES)) {
    assert.ok(Array.isArray(rows) && rows.length > 0, `${sit}: 空でない配列`);
    for (const row of rows) {
      assert.ok(Array.isArray(row) && row.length === 2, `${sit}: [text, mood] の形`);
      const [text, mood] = row;
      assert.ok(typeof text === 'string' && text.length > 0, `${sit}: text が非空文字列`);
      assert.ok(MOODS.has(mood), `${sit}: mood "${mood}" が §4-3 語彙外`);
    }
  }
});

test('状態は createPersona ごとに独立（last index を共有しない）', () => {
  // 2 つの persona が互いの直前 index に干渉しないこと（接続ごとに作る前提）
  const a = createPersona();
  const b = createPersona();
  // 片方を大量に回しても他方の契約（非反復）は保たれる
  for (let i = 0; i < 50; i++) a.line('idle');
  let prev = null;
  for (let i = 0; i < 100; i++) {
    const cur = b.line('idle').text;
    assert.notEqual(cur, prev);
    prev = cur;
  }
});

test('talk（受動の口）：内容が分からなくても相槌の床が喋る（protocol §5-4）', () => {
  const p = createPersona();
  // LLM 無しでも talk は黙らない。ctx.text を渡しても固定台詞（床）が返る
  const r = p.line('talk', { label: '居間', text: '今日寒くない？', history: [] });
  assert.ok(r && typeof r.text === 'string' && r.text.length > 0, '相槌が返る');
  assert.ok(MOODS.has(r.mood), `mood が語彙内: ${r.mood}`);
});
