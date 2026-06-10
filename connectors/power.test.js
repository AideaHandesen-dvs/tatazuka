// power.js の契約テスト（依存ゼロ・node:test）。fetch を注入し実 HA・実センサは叩かない。
//   node --test connectors/power.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1。co2 と同型の below=false）：
//   - URL/トークン/対象 entity が欠ければ createPower は null（PE：connector オフ）
//   - 初回は基準だけ。500W 超で power.high、400W 未満で power.ok（below=false・ヒステリシス）
//   - debounce=3 なので確定には 3 連続（レンジ/ケトルの瞬間負荷は弾く）
//   - state が数値でない → null（黙る・PE）。ctx.watts に丸めた電力。TZ_POWER_HIGH で閾値変更

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPower } from './power.js';

function hassFetch(states) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const s = states[Math.min(i++, states.length - 1)];
    if (s === '!throw') throw new Error('down');
    if (s === '!ok') return { ok: false, async json() { return {}; } };
    return { ok: true, async json() { return { entity_id: 'sensor.p', state: String(s), attributes: {} }; } };
  };
  fn.calls = calls;
  return fn;
}
const ENV = { TZ_HASS_URL: 'http://ha.local:8123/', TZ_HASS_TOKEN: 'tok', TZ_HASS_POWER: 'sensor.home_power' };

test('URL/トークン/対象が欠ければ null（PE：connector オフ）', () => {
  const f = hassFetch([]);
  assert.equal(createPower({ fetch: f, env: {} }), null);
  assert.ok(createPower({ fetch: f, env: ENV }));
});

test('初回は基準だけ。500 超で high、400 未満で ok（debounce=3・ctx.watts）', async () => {
  const src = createPower({ fetch: hassFetch([200, 800, 800, 800, 300, 300, 300]), env: ENV });
  assert.equal(await src.poll(), null);  // prime（ok）
  assert.equal(await src.poll(), null);  // 800：warn 1
  assert.equal(await src.poll(), null);  // 800：warn 2
  assert.deepEqual(await src.poll(), { situation: 'power.high', ctx: { watts: 800 } }); // 3 連続 → 確定
  assert.equal(await src.poll(), null);  // 300：ok 1
  assert.equal(await src.poll(), null);  // 300：ok 2
  assert.deepEqual(await src.poll(), { situation: 'power.ok', ctx: { watts: 300 } });   // 3 連続 → 確定
});

test('瞬間負荷は弾く（debounce=3・間に低い値が挟まると数え直し）', async () => {
  const src = createPower({ fetch: hassFetch([200, 1200, 1200, 200, 1200, 1200, 1200]), env: ENV });
  assert.equal(await src.poll(), null);  // prime
  assert.equal(await src.poll(), null);  // warn 1
  assert.equal(await src.poll(), null);  // warn 2
  assert.equal(await src.poll(), null);  // 200：ok に戻る＝スパイク → カウント捨て
  assert.equal(await src.poll(), null);  // warn 数え直し 1
  assert.equal(await src.poll(), null);  // warn 2
  assert.deepEqual(await src.poll(), { situation: 'power.high', ctx: { watts: 1200 } }); // 3 連続 → 確定
});

test('state が数値でなければ黙る（PE）', async () => {
  const src = createPower({ fetch: hassFetch([200, 'unavailable', 800, 800, 800]), env: ENV });
  assert.equal(await src.poll(), null);  // prime
  assert.equal(await src.poll(), null);  // "unavailable" → NaN → 黙る
  assert.equal(await src.poll(), null);  // warn 1
  assert.equal(await src.poll(), null);  // warn 2
  assert.deepEqual(await src.poll(), { situation: 'power.high', ctx: { watts: 800 } });
});

test('fetch が !ok／例外なら null（黙る・PE）', async () => {
  const bad = createPower({ fetch: hassFetch(['!ok', '!ok']), env: ENV });
  assert.equal(await bad.poll(), null);
  const boom = createPower({ fetch: hassFetch(['!throw']), env: ENV });
  assert.equal(await boom.poll(), null);
});

test('TZ_POWER_HIGH で閾値を変えられる（10 設定なら 15 で high＝個別プラグ用途）', async () => {
  const env = { ...ENV, TZ_POWER_HIGH: '10' }; // 帯は [-90,10]（個別機器の待機↔稼働）
  const src = createPower({ fetch: hassFetch([2, 15, 15, 15]), env });
  assert.equal(await src.poll(), null);  // prime（2W＝ok）
  assert.equal(await src.poll(), null);  // 15：warn 1
  assert.equal(await src.poll(), null);  // 15：warn 2
  assert.deepEqual(await src.poll(), { situation: 'power.high', ctx: { watts: 15 } });
});

test('Authorization と URL を正しく組む（ha.js 経由）', async () => {
  const f = hassFetch([200]);
  const src = createPower({ fetch: f, env: ENV });
  await src.poll();
  assert.equal(f.calls[0].url, 'http://ha.local:8123/api/states/sensor.home_power');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer tok');
});
