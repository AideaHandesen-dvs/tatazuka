// 入力コネクタの契約テスト（依存ゼロ・node:test）。read を注入し実 IO は飛ばさない。
//   node --test connectors/example-source.test.js
//
// 押さえる契約（イベント源パターン・README §6-4）：
//   - read が無ければ createExampleSource は null（＝この source はオフ＝PE）
//   - poll() は遷移だけを返す。初回は基準を取るだけで「変わった」と言わない
//   - read が null/例外 → poll は null（黙る。佇かを止めない）
//   - prev はインスタンスごと（接続ごとに作る＝端末間で独立）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createExampleSource } from './example-source.js';

// 呼ぶたびに values を順に返す read スタブ（末尾に達したら最後の値を返し続ける）
function seqRead(values) {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
}

test('read が無ければ null（PE：source オフ）', () => {
  assert.equal(createExampleSource(), null);
  assert.equal(createExampleSource({}), null);
  assert.equal(createExampleSource({ read: 123 }), null);
});

test('初回は基準を取るだけで黙る（遷移として誤検知しない）', async () => {
  const src = createExampleSource({ read: seqRead(['a', 'a', 'b']) });
  assert.equal(await src.poll(), null);                 // 初回＝基準取得
  assert.equal(await src.poll(), null);                 // 無変化
  assert.deepEqual(await src.poll(), {                  // a→b の遷移で一度だけ
    situation: 'example.changed', ctx: { from: 'a', to: 'b' },
  });
});

test('遷移後は無変化なら再び黙る', async () => {
  const src = createExampleSource({ read: seqRead(['x', 'y', 'y', 'y']) });
  await src.poll();                                     // prime（x）
  assert.equal((await src.poll()).situation, 'example.changed'); // x→y
  assert.equal(await src.poll(), null);                 // y→y
  assert.equal(await src.poll(), null);
});

test('read が null/例外なら poll は null（黙る・PE）', async () => {
  const nul = createExampleSource({ read: async () => null });
  assert.equal(await nul.poll(), null);
  assert.equal(await nul.poll(), null); // null は prime もしない＝次に読めた値が基準になる

  const boom = createExampleSource({ read: async () => { throw new Error('unreachable'); } });
  assert.equal(await boom.poll(), null);
});

test('translate を差し替えれば任意の遷移ロジックにできる', async () => {
  // しきい値跨ぎの例（activity の idle しきい値と同じ発想）
  const translate = (prev, cur) => {
    const was = prev >= 10, now = cur >= 10;
    if (!was && now) return { situation: 'over' };
    if (was && !now) return { situation: 'under' };
    return null;
  };
  const src = createExampleSource({ read: seqRead([5, 8, 12, 20, 3]), translate });
  assert.equal(await src.poll(), null);                 // prime（5）
  assert.equal(await src.poll(), null);                 // 5→8（共に閾値下）
  assert.equal((await src.poll()).situation, 'over');   // 8→12 で跨ぐ
  assert.equal(await src.poll(), null);                 // 12→20（共に閾値上）
  assert.equal((await src.poll()).situation, 'under');  // 20→3 で戻る
});

test('prev はインスタンスごと（接続ごとに独立）', async () => {
  const a = createExampleSource({ read: seqRead(['p', 'q']) });
  const b = createExampleSource({ read: seqRead(['p', 'p']) });
  await a.poll(); await b.poll();                        // それぞれ prime
  assert.equal((await a.poll()).situation, 'example.changed'); // a は p→q
  assert.equal(await b.poll(), null);                   // b は p→p（独立）
});
