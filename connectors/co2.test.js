// co2.js の契約テスト（依存ゼロ・node:test）。fetch を注入し実 HA・実センサは叩かない。
//   node --test connectors/co2.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1）：
//   - URL/トークン/対象 entity のどれかが欠ければ createCo2 は null（PE：connector オフ）
//   - 初回は基準だけ。1000ppm 超で co2.stuffy、800ppm 未満で co2.ok（below=false・ヒステリシス）
//   - debounce=2 なので確定には 2 連続が要る（息がかかった単発スパイクは弾く）
//   - state が数値でない（"unavailable" 等）→ null（黙る・PE）。しきい値状態は壊さない
//   - ctx.ppm に丸めた濃度。TZ_CO2_HIGH で閾値を変えられる

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCo2 } from './co2.js';

// state（HA は数値センサも文字列で返す）を順に返す fetch スタブ。'!ok'/'!throw' で失敗を演じる。
function hassFetch(states) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const s = states[Math.min(i++, states.length - 1)];
    if (s === '!throw') throw new Error('down');
    if (s === '!ok') return { ok: false, async json() { return {}; } };
    return { ok: true, async json() { return { entity_id: 'sensor.c', state: String(s), attributes: {} }; } };
  };
  fn.calls = calls;
  return fn;
}
const ENV = { TZ_HASS_URL: 'http://ha.local:8123/', TZ_HASS_TOKEN: 'tok', TZ_HASS_CO2: 'sensor.living_co2' };

test('URL/トークン/対象が欠ければ null（PE：connector オフ）', () => {
  const f = hassFetch([]);
  assert.equal(createCo2({ fetch: f, env: {} }), null);
  assert.equal(createCo2({ fetch: f, env: { TZ_HASS_URL: 'x', TZ_HASS_TOKEN: 't' } }), null); // entity 無し
  assert.ok(createCo2({ fetch: f, env: ENV }));                                                // 揃えば有効
});

test('初回は基準だけ。1000 超で stuffy、800 未満で ok（debounce=2・ctx.ppm）', async () => {
  // 600(基準ok) → 1200,1200(こもった) → 700,700(換気できた)
  const src = createCo2({ fetch: hassFetch([600, 1200, 1200, 700, 700]), env: ENV });
  assert.equal(await src.poll(), null);  // prime（ok）
  assert.equal(await src.poll(), null);  // 1200：warn 1 回目（未確定）
  assert.deepEqual(await src.poll(), { situation: 'co2.stuffy', ctx: { ppm: 1200 } });
  assert.equal(await src.poll(), null);  // 700：ok 1 回目（未確定）
  assert.deepEqual(await src.poll(), { situation: 'co2.ok', ctx: { ppm: 700 } });
});

test('ヒステリシス帯（800〜1000）の中は維持＝チャタを吸収', async () => {
  // 600(基準ok) → 1200,1200(stuffy確定) → 900,900(帯の中＝戻さない)
  const src = createCo2({ fetch: hassFetch([600, 1200, 1200, 900, 900]), env: ENV });
  assert.equal(await src.poll(), null);  // prime
  assert.equal(await src.poll(), null);  // warn 1
  assert.deepEqual(await src.poll(), { situation: 'co2.stuffy', ctx: { ppm: 1200 } });
  assert.equal(await src.poll(), null);  // 900：帯 [800,1000] の中 → 維持
  assert.equal(await src.poll(), null);  // 900：まだ帯の中
});

test('単発スパイクは弾く（debounce=2・間に基準値が挟まると数え直し）', async () => {
  const src = createCo2({ fetch: hassFetch([600, 1500, 600, 1500, 1500]), env: ENV });
  assert.equal(await src.poll(), null);  // prime
  assert.equal(await src.poll(), null);  // 1500：warn 1（未確定）
  assert.equal(await src.poll(), null);  // 600：ok に戻る＝スパイク → カウント捨て
  assert.equal(await src.poll(), null);  // 1500：warn 数え直し 1
  assert.deepEqual(await src.poll(), { situation: 'co2.stuffy', ctx: { ppm: 1500 } }); // 2 連続 → 確定
});

test('state が数値でなければ黙る（PE）。しきい値状態は壊さない', async () => {
  const src = createCo2({ fetch: hassFetch([600, 'unavailable', 1200, 1200]), env: ENV });
  assert.equal(await src.poll(), null);  // prime（ok）
  assert.equal(await src.poll(), null);  // "unavailable" → NaN → 黙る（threshold に流さない）
  assert.equal(await src.poll(), null);  // 1200：warn 1
  assert.deepEqual(await src.poll(), { situation: 'co2.stuffy', ctx: { ppm: 1200 } });
});

test('fetch が !ok／例外なら null（黙る・PE）', async () => {
  const bad = createCo2({ fetch: hassFetch(['!ok', '!ok']), env: ENV });
  assert.equal(await bad.poll(), null);
  const boom = createCo2({ fetch: hassFetch(['!throw']), env: ENV });
  assert.equal(await boom.poll(), null);
});

test('TZ_CO2_HIGH で閾値を変えられる（800 設定なら 850 で stuffy）', async () => {
  const env = { ...ENV, TZ_CO2_HIGH: '800' }; // 帯は [600,800]
  const src = createCo2({ fetch: hassFetch([500, 850, 850]), env });
  assert.equal(await src.poll(), null);  // prime（500＝ok）
  assert.equal(await src.poll(), null);  // 850：warn 1
  assert.deepEqual(await src.poll(), { situation: 'co2.stuffy', ctx: { ppm: 850 } });
});

test('Authorization と URL を正しく組む（ha.js 経由・末尾スラッシュ正規化・entity エンコード）', async () => {
  const f = hassFetch([600]);
  const src = createCo2({ fetch: f, env: ENV });
  await src.poll();
  assert.equal(f.calls[0].url, 'http://ha.local:8123/api/states/sensor.living_co2');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer tok');
});
