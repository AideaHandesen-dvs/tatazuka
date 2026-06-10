// illuminance.js の契約テスト（依存ゼロ・node:test）。fetch を注入し実 HA・実センサは叩かない。
//   node --test connectors/illuminance.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1）：
//   - URL/トークン/対象 entity のどれかが欠ければ createIlluminance は null（PE：connector オフ）
//   - 初回は基準だけ。50lux 未満で illuminance.dark、80lux 超で illuminance.ok（below=true・ヒステリシス）
//   - debounce=3 なので確定には 3 連続（雲の通過・人影の一瞬の翳りは弾く）
//   - state が数値でない（"unavailable" 等）→ null（黙る・PE）。しきい値状態は壊さない
//   - ctx.lux に丸めた照度。TZ_LUX_MIN で閾値を変えられる

import test from 'node:test';
import assert from 'node:assert/strict';
import { createIlluminance } from './illuminance.js';

function hassFetch(states) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const s = states[Math.min(i++, states.length - 1)];
    if (s === '!throw') throw new Error('down');
    if (s === '!ok') return { ok: false, async json() { return {}; } };
    return { ok: true, async json() { return { entity_id: 'sensor.l', state: String(s), attributes: {} }; } };
  };
  fn.calls = calls;
  return fn;
}
const ENV = { TZ_HASS_URL: 'http://ha.local:8123/', TZ_HASS_TOKEN: 'tok', TZ_HASS_LUX: 'sensor.living_illuminance' };

test('URL/トークン/対象が欠ければ null（PE：connector オフ）', () => {
  const f = hassFetch([]);
  assert.equal(createIlluminance({ fetch: f, env: {} }), null);
  assert.equal(createIlluminance({ fetch: f, env: { TZ_HASS_URL: 'x', TZ_HASS_TOKEN: 't' } }), null); // entity 無し
  assert.ok(createIlluminance({ fetch: f, env: ENV }));                                                // 揃えば有効
});

test('初回は基準だけ。暗くなって dark、明るくなって ok（debounce=3・ctx.lux）', async () => {
  // 300(基準ok) → 20×3(暗い確定) → 200×3(明るい確定)
  const src = createIlluminance({ fetch: hassFetch([300, 20, 20, 20, 200, 200, 200]), env: ENV });
  assert.equal(await src.poll(), null);  // prime（ok）
  assert.equal(await src.poll(), null);  // 20：warn 1
  assert.equal(await src.poll(), null);  // 20：warn 2
  assert.deepEqual(await src.poll(), { situation: 'illuminance.dark', ctx: { lux: 20 } }); // 3 連続 → 確定
  assert.equal(await src.poll(), null);  // 200：ok 1
  assert.equal(await src.poll(), null);  // 200：ok 2
  assert.deepEqual(await src.poll(), { situation: 'illuminance.ok', ctx: { lux: 200 } }); // 3 連続 → 確定
});

test('ヒステリシス帯（50〜80）の中は維持＝チャタ吸収', async () => {
  const src = createIlluminance({ fetch: hassFetch([300, 20, 20, 20, 65, 65]), env: ENV });
  assert.equal(await src.poll(), null);  // prime
  assert.equal(await src.poll(), null);  // warn 1
  assert.equal(await src.poll(), null);  // warn 2
  assert.deepEqual(await src.poll(), { situation: 'illuminance.dark', ctx: { lux: 20 } });
  assert.equal(await src.poll(), null);  // 65：帯 [50,80] の中 → 維持
  assert.equal(await src.poll(), null);  // 65：まだ帯の中
});

test('一瞬の翳りは弾く（debounce=3・間に明るい値が挟まると数え直し）', async () => {
  const src = createIlluminance({ fetch: hassFetch([300, 20, 20, 300, 20, 20, 20]), env: ENV });
  assert.equal(await src.poll(), null);  // prime
  assert.equal(await src.poll(), null);  // warn 1
  assert.equal(await src.poll(), null);  // warn 2
  assert.equal(await src.poll(), null);  // 300：ok に戻る＝スパイク → カウント捨て
  assert.equal(await src.poll(), null);  // warn 数え直し 1
  assert.equal(await src.poll(), null);  // warn 2
  assert.deepEqual(await src.poll(), { situation: 'illuminance.dark', ctx: { lux: 20 } }); // 3 連続 → 確定
});

test('state が数値でなければ黙る（PE）。しきい値状態は壊さない', async () => {
  const src = createIlluminance({ fetch: hassFetch([300, 'unavailable', 20, 20, 20]), env: ENV });
  assert.equal(await src.poll(), null);  // prime（ok）
  assert.equal(await src.poll(), null);  // "unavailable" → NaN → 黙る
  assert.equal(await src.poll(), null);  // 20：warn 1
  assert.equal(await src.poll(), null);  // 20：warn 2
  assert.deepEqual(await src.poll(), { situation: 'illuminance.dark', ctx: { lux: 20 } });
});

test('fetch が !ok／例外なら null（黙る・PE）', async () => {
  const bad = createIlluminance({ fetch: hassFetch(['!ok', '!ok']), env: ENV });
  assert.equal(await bad.poll(), null);
  const boom = createIlluminance({ fetch: hassFetch(['!throw']), env: ENV });
  assert.equal(await boom.poll(), null);
});

test('TZ_LUX_MIN で閾値を変えられる（200 設定なら 150 は暗い）', async () => {
  const env = { ...ENV, TZ_LUX_MIN: '200' }; // 帯は [200,230]
  const src = createIlluminance({ fetch: hassFetch([300, 150, 150, 150]), env });
  assert.equal(await src.poll(), null);  // prime（300＝ok）
  assert.equal(await src.poll(), null);  // 150：warn 1
  assert.equal(await src.poll(), null);  // 150：warn 2
  assert.deepEqual(await src.poll(), { situation: 'illuminance.dark', ctx: { lux: 150 } });
});

test('Authorization と URL を正しく組む（ha.js 経由）', async () => {
  const f = hassFetch([300]);
  const src = createIlluminance({ fetch: f, env: ENV });
  await src.poll();
  assert.equal(f.calls[0].url, 'http://ha.local:8123/api/states/sensor.living_illuminance');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer tok');
});
