// humidity.js の契約テスト（依存ゼロ・node:test）。fetch を注入し実 HA は叩かない。
//   node --test connectors/humidity.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1）：
//   - URL/トークン/対象 entity のどれかが欠ければ createHumidity は null（PE：connector オフ）
//   - 初回は基準だけ（起動直後に喋らない）。快適帯の外に出たら humidity.dry/humidity.humid、戻れば humidity.ok
//   - state が数値でない（"unavailable" 等）→ null（黙る・PE）。band 状態は壊さない
//   - ctx.pct に丸めた湿度％。TZ_HUMIDITY_LOW/HIGH で快適帯を変えられる
//   - debounce=2 なので確定には 2 連続が要る（単発スパイクは弾く）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHumidity } from './humidity.js';

// state 文字列（HA は数値センサも文字列で返す）を順に返す fetch スタブ。'!ok'/'!throw' で失敗を演じる。
function hassFetch(states) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const s = states[Math.min(i++, states.length - 1)];
    if (s === '!throw') throw new Error('down');
    if (s === '!ok') return { ok: false, async json() { return {}; } };
    return { ok: true, async json() { return { entity_id: 'sensor.h', state: String(s), attributes: {} }; } };
  };
  fn.calls = calls;
  return fn;
}
const ENV = { TZ_HASS_URL: 'http://ha.local:8123/', TZ_HASS_TOKEN: 'tok', TZ_HASS_HUMIDITY: 'sensor.living_humidity' };

test('URL/トークン/対象が欠ければ null（PE：connector オフ）', () => {
  const f = hassFetch([]);
  assert.equal(createHumidity({ fetch: f, env: {} }), null);
  assert.equal(createHumidity({ fetch: f, env: { TZ_HASS_URL: 'x', TZ_HASS_TOKEN: 't' } }), null); // entity 無し
  assert.ok(createHumidity({ fetch: f, env: ENV }));                                                // 揃えば有効
});

test('初回は基準だけ。乾燥/じめじめ/快適の遷移（debounce=2・ctx.pct）', async () => {
  // 50(基準ok) → 35,35(乾燥確定) → 50,50(快適復帰) → 70,70(じめじめ)
  const src = createHumidity({ fetch: hassFetch([50, 35, 35, 50, 50, 70, 70]), env: ENV });
  assert.equal(await src.poll(), null);  // prime（快適帯の中）
  assert.equal(await src.poll(), null);  // 35：low 1 回目（未確定）
  assert.deepEqual(await src.poll(), { situation: 'humidity.dry', ctx: { pct: 35 } });
  assert.equal(await src.poll(), null);  // 50：ok 1 回目（未確定）
  assert.deepEqual(await src.poll(), { situation: 'humidity.ok', ctx: { pct: 50 } });
  assert.equal(await src.poll(), null);  // 70：high 1 回目
  assert.deepEqual(await src.poll(), { situation: 'humidity.humid', ctx: { pct: 70 } });
});

test('単発スパイクは弾く（debounce=2・間に基準値が挟まると数え直し）', async () => {
  const src = createHumidity({ fetch: hassFetch([50, 30, 50, 30, 30]), env: ENV });
  assert.equal(await src.poll(), null);  // prime
  assert.equal(await src.poll(), null);  // 30：low 1（未確定）
  assert.equal(await src.poll(), null);  // 50：ok に戻る＝スパイク → カウント捨て
  assert.equal(await src.poll(), null);  // 30：low 数え直し 1
  assert.deepEqual(await src.poll(), { situation: 'humidity.dry', ctx: { pct: 30 } }); // 2 連続 → 確定
});

test('state が数値でなければ黙る（PE）。band 状態は壊さない', async () => {
  // 50(基準) → "unavailable"(黙る・基準は維持) → 35,35(そこから乾燥が確定する)
  const src = createHumidity({ fetch: hassFetch([50, 'unavailable', 35, 35]), env: ENV });
  assert.equal(await src.poll(), null);  // prime（ok）
  assert.equal(await src.poll(), null);  // "unavailable" → NaN → 黙る（band に流さない）
  assert.equal(await src.poll(), null);  // 35：low 1
  assert.deepEqual(await src.poll(), { situation: 'humidity.dry', ctx: { pct: 35 } });
});

test('fetch が !ok／例外なら null（黙る・PE）', async () => {
  const bad = createHumidity({ fetch: hassFetch(['!ok', '!ok']), env: ENV });
  assert.equal(await bad.poll(), null);
  const boom = createHumidity({ fetch: hassFetch(['!throw']), env: ENV });
  assert.equal(await boom.poll(), null);
});

test('TZ_HUMIDITY_LOW/HIGH で快適帯を変えられる', async () => {
  // 帯を [30,50] にずらすと、45 は快適・55 はじめじめ
  const env = { ...ENV, TZ_HUMIDITY_LOW: '30', TZ_HUMIDITY_HIGH: '50' };
  const src = createHumidity({ fetch: hassFetch([40, 55, 55]), env });
  assert.equal(await src.poll(), null);  // prime（40＝[30,50]の中＝快適）
  assert.equal(await src.poll(), null);  // 55：high 1
  assert.deepEqual(await src.poll(), { situation: 'humidity.humid', ctx: { pct: 55 } });
});

test('Authorization と URL を正しく組む（ha.js 経由・末尾スラッシュ正規化・entity エンコード）', async () => {
  const f = hassFetch([50]);
  const src = createHumidity({ fetch: f, env: ENV });
  await src.poll();
  assert.equal(f.calls[0].url, 'http://ha.local:8123/api/states/sensor.living_humidity');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer tok');
});
