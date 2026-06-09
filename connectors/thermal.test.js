// thermal.js の契約テスト（依存ゼロ・node:test）。readTemps を注入し実 /sys は読まない。
//   node --test connectors/thermal.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1, §7-1）：
//   - TZ_TEMP が無ければ createThermal は null（PE：connector オフ）
//   - poll() は温度の hot↔ok のしきい値またぎだけを返す。初回は基準を取るだけで喋らない
//   - **複数ゾーンの最大**を見る（いちばん熱いところ）
//   - デバウンス：一瞬のスパイクでは騒がず、連続して熱いとき初めて temp.hot
//   - 温度を ctx.tempC に乗せる／TZ_TEMP_HOT_C でしきい値を変えられる
//   - readTemps が null（ゾーン無し）／例外なら null（黙る・PE）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createThermal } from './thermal.js';

// readTemps スタブ：℃ 配列の列を順に返す（末尾に達したら最後を返し続ける）。null/'!throw' で失敗。
function tempRun(seq) {
  let i = 0;
  return async () => {
    const s = seq[Math.min(i++, seq.length - 1)];
    if (s === '!throw') throw new Error('boom');
    return s;
  };
}
const ENV = { TZ_TEMP: '1' };

test('TZ_TEMP 未設定なら null（PE：connector オフ）', () => {
  assert.equal(createThermal({ readTemps: tempRun([]), env: {} }), null);
  assert.ok(createThermal({ readTemps: tempRun([]), env: ENV }));
});

test('初回は基準だけ。連続して熱い→temp.hot、落ち着く→temp.ok（デバウンスは両方向に3・ctx 付き）', async () => {
  // 50（prime）→ 85 85 85（3連続で hot 確定）→ 60 60 60（3連続で ok 確定。戻し閾値 75 未満）
  const src = createThermal({ readTemps: tempRun([[50], [85], [85], [85], [60], [60], [60]]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime
  assert.equal(await src.poll(), null);                  // 85（1回目・デバウンス未確定）
  assert.equal(await src.poll(), null);                  // 85（2回目）
  assert.deepEqual(await src.poll(), { situation: 'temp.hot', ctx: { tempC: 85 } }); // 3回目で確定
  assert.equal(await src.poll(), null);                  // 60（1回目・冷却もデバウンス）
  assert.equal(await src.poll(), null);                  // 60（2回目）
  assert.deepEqual(await src.poll(), { situation: 'temp.ok', ctx: { tempC: 60 } });  // 3回目で確定
});

test('一瞬のスパイクでは騒がない（85 が1回だけなら確定しない）', async () => {
  const src = createThermal({ readTemps: tempRun([[50], [85], [50], [50]]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime
  assert.equal(await src.poll(), null);                  // 85（1回）
  assert.equal(await src.poll(), null);                  // 50 に戻った＝デバウンスリセット
  assert.equal(await src.poll(), null);
});

test('複数ゾーンの最大を見る（CPU 90・GPU 40 → 90 で熱い）', async () => {
  const src = createThermal({ readTemps: tempRun([[40, 40], [90, 40], [90, 40], [90, 40]]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime（最大 40）
  assert.equal(await src.poll(), null);
  assert.equal(await src.poll(), null);
  assert.deepEqual(await src.poll(), { situation: 'temp.hot', ctx: { tempC: 90 } });
});

test('TZ_TEMP_HOT_C でしきい値を変えられる（85℃ でも hot 90 なら ok のまま）', async () => {
  const src = createThermal({ readTemps: tempRun([[50], [85], [85], [85]]), env: { TZ_TEMP: '1', TZ_TEMP_HOT_C: '90' } });
  assert.equal(await src.poll(), null);
  assert.equal(await src.poll(), null);
  assert.equal(await src.poll(), null);
  assert.equal(await src.poll(), null);                  // 85 < 90 ＝またがない
});

test('読めない（null＝ゾーン無し・空配列・例外）なら null（黙る・PE）', async () => {
  const a = createThermal({ readTemps: tempRun([null, null]), env: ENV });
  assert.equal(await a.poll(), null);
  const b = createThermal({ readTemps: tempRun([[]]), env: ENV });
  assert.equal(await b.poll(), null);
  const c = createThermal({ readTemps: tempRun(['!throw']), env: ENV });
  assert.equal(await c.poll(), null);
});
