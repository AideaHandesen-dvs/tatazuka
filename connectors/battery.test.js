// battery.js の契約テスト（依存ゼロ・node:test）。readPower を注入し実 /sys は読まない。
//   node --test connectors/battery.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1, §7-1）：
//   - TZ_BATTERY が無ければ createBattery は null（PE：connector オフ）
//   - poll() は残量の low↔ok のしきい値またぎだけを返す。初回は基準を取るだけで喋らない
//   - **充電ゲート**：残量が低くても放電中でなければ battery.low を出さない（充電中に「切れそう」は嘘）
//   - 繋ぎ直し（放電→充電）は安全値 100 が流れて battery.ok（「持ち直した」）になる
//   - 残量を ctx.capacity・充電状態を ctx.charging に乗せる
//   - TZ_BATTERY_MIN_PCT でしきい値を変えられる
//   - readPower が null（バッテリー無し）／例外なら null（黙る・PE）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattery } from './battery.js';

// readPower スタブ：{capacity, status} の列を順に返す（末尾に達したら最後を返し続ける）。
// null / '!throw' で「バッテリー無し」「読めない」を演じる。
function powerRun(snaps) {
  let i = 0;
  return async () => {
    const s = snaps[Math.min(i++, snaps.length - 1)];
    if (s === '!throw') throw new Error('boom');
    return s;
  };
}
const ENV = { TZ_BATTERY: '1' };
const dis = (cap) => ({ capacity: cap, status: 'Discharging', acOnline: false }); // 放電中
const chg = (cap) => ({ capacity: cap, status: 'Charging', acOnline: true });      // 充電中
const fulled = (cap) => ({ capacity: cap, status: 'Full', acOnline: true });       // 満充電で繋ぎっぱ

test('TZ_BATTERY 未設定なら null（PE：connector オフ）', () => {
  assert.equal(createBattery({ readPower: powerRun([]), env: {} }), null);
  assert.ok(createBattery({ readPower: powerRun([]), env: ENV }));
});

test('初回は基準だけ。放電中に残量が low↔ok をまたいで battery.low / battery.ok（ctx 付き）', async () => {
  // 放電で 60→60→15（割る）→15→60（戻す）
  const src = createBattery({ readPower: powerRun([dis(60), dis(60), dis(15), dis(15), dis(60)]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime（ok）
  assert.equal(await src.poll(), null);                  // 60→60：無変化
  assert.deepEqual(await src.poll(), { situation: 'battery.low', ctx: { capacity: 15, charging: false } });
  assert.equal(await src.poll(), null);                  // low→low：無変化
  assert.deepEqual(await src.poll(), { situation: 'battery.ok', ctx: { capacity: 60, charging: false } });
});

test('充電ゲート：残量 8% でも充電中なら battery.low を出さない（充電中に「切れそう」は嘘）', async () => {
  const src = createBattery({ readPower: powerRun([chg(50), chg(8), chg(8)]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime（ok）
  assert.equal(await src.poll(), null);                  // 充電中＝安全値 100 が流れる → またがない
  assert.equal(await src.poll(), null);
});

test('放電で low → 繋ぎ直すと battery.ok（持ち直した・charging:true）', async () => {
  // 放電 50（prime）→ 放電 10（low）→ 充電 10（繋いだ＝安全値 100 が流れて ok）
  const src = createBattery({ readPower: powerRun([dis(50), dis(10), chg(10)]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime（ok）
  assert.deepEqual(await src.poll(), { situation: 'battery.low', ctx: { capacity: 10, charging: false } });
  assert.deepEqual(await src.poll(), { situation: 'battery.ok', ctx: { capacity: 10, charging: true } });
});

test('TZ_BATTERY_MIN_PCT でしきい値を変えられる（放電 8% でも min 5% なら ok のまま）', async () => {
  const src = createBattery({ readPower: powerRun([dis(50), dis(8)]), env: { TZ_BATTERY: '1', TZ_BATTERY_MIN_PCT: '5' } });
  assert.equal(await src.poll(), null);                  // prime（ok）
  assert.equal(await src.poll(), null);                  // 残量 8% > min 5% ＝まだ ok（またがない）
});

test('満充電で繋ぎっぱ → battery.full は Full に入った瞬間だけ一度（外れたらリセット）', async () => {
  // 充電 80（prime）→ Full（満タン）→ Full（無変化）→ 充電 80（外れ＝黙る）→ Full（また言える）
  const src = createBattery({ readPower: powerRun([chg(80), fulled(100), fulled(100), chg(80), fulled(100)]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime
  assert.deepEqual(await src.poll(), { situation: 'battery.full', ctx: { capacity: 100, charging: true } });
  assert.equal(await src.poll(), null);                  // Full→Full：無変化
  assert.equal(await src.poll(), null);                  // Full→充電：外れたのでリセットだけ（黙る）
  assert.deepEqual(await src.poll(), { situation: 'battery.full', ctx: { capacity: 100, charging: true } });
});

test('残量警告（軸1）を満充電（軸2）より先に返す＝1 poll 1 遷移', async () => {
  // 放電 50（prime）→ 放電 10（low を先に）。Full と同時には起きないが、優先順位を固定で押さえる。
  const src = createBattery({ readPower: powerRun([dis(50), dis(10)]), env: ENV });
  assert.equal(await src.poll(), null);
  assert.equal((await src.poll()).situation, 'battery.low');
});

test('読めない（null＝バッテリー無し・例外）なら null（黙る・PE）', async () => {
  const a = createBattery({ readPower: powerRun([null, null]), env: ENV });
  assert.equal(await a.poll(), null);
  const b = createBattery({ readPower: powerRun(['!throw']), env: ENV });
  assert.equal(await b.poll(), null);
});
