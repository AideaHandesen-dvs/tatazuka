// opening.js の契約テスト（依存ゼロ・node:test）。fetch を注入し実 HA は叩かない。
//   node --test connectors/opening.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1。home-assistant と同型の二値遷移）：
//   - URL/トークン/対象 entity のどれかが欠ければ createOpening は null（PE：connector オフ）
//   - 初回は基準だけ。on↔off の遷移だけ opening.open / opening.closed を返す（無変化は黙る）
//   - friendly_name があれば ctx.what に乗せる
//   - state が文字列でない／fetch 失敗 → null（黙る・PE）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpening } from './opening.js';

function hassFetch(states) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const s = states[Math.min(i++, states.length - 1)];
    if (s === '!throw') throw new Error('down');
    if (s === '!ok') return { ok: false, async json() { return {}; } };
    return { ok: true, async json() { return s; } };
  };
  fn.calls = calls;
  return fn;
}
const st = (state, what) => ({ entity_id: 'binary_sensor.window', state, attributes: what ? { friendly_name: what } : {} });
const ENV = { TZ_HASS_URL: 'http://ha.local:8123/', TZ_HASS_TOKEN: 'tok', TZ_HASS_OPENING: 'binary_sensor.living_window' };

test('URL/トークン/対象が欠ければ null（PE：connector オフ）', () => {
  const f = hassFetch([]);
  assert.equal(createOpening({ fetch: f, env: {} }), null);
  assert.equal(createOpening({ fetch: f, env: { TZ_HASS_URL: 'x', TZ_HASS_TOKEN: 't' } }), null); // entity 無し
  assert.ok(createOpening({ fetch: f, env: ENV }));                                                // 揃えば有効
});

test('初回は基準だけ。off↔on の遷移で open/closed（無変化は黙る）', async () => {
  const src = createOpening({ fetch: hassFetch([st('off'), st('off'), st('on'), st('on'), st('off')]), env: ENV });
  assert.equal(await src.poll(), null);                              // prime（閉）
  assert.equal(await src.poll(), null);                              // off→off：無変化
  assert.deepEqual(await src.poll(), { situation: 'opening.open', ctx: undefined });   // 開いた
  assert.equal(await src.poll(), null);                              // on→on：無変化
  assert.deepEqual(await src.poll(), { situation: 'opening.closed', ctx: undefined }); // 閉めた
});

test('friendly_name があれば ctx.what に乗る', async () => {
  const src = createOpening({ fetch: hassFetch([st('off', 'リビングの窓'), st('on', 'リビングの窓')]), env: ENV });
  assert.equal(await src.poll(), null);                              // prime（閉）
  assert.deepEqual(await src.poll(), { situation: 'opening.open', ctx: { what: 'リビングの窓' } });
});

test('state が文字列でなければ黙る（PE）', async () => {
  // state が無い（数値や欠落）→ ha.js が null を返す → 黙る
  const src = createOpening({ fetch: hassFetch([{ entity_id: 'x', attributes: {} }]), env: ENV });
  assert.equal(await src.poll(), null);
});

test('fetch が !ok／例外なら null（黙る・PE）', async () => {
  const bad = createOpening({ fetch: hassFetch(['!ok', '!ok']), env: ENV });
  assert.equal(await bad.poll(), null);
  const boom = createOpening({ fetch: hassFetch(['!throw']), env: ENV });
  assert.equal(await boom.poll(), null);
});

test('Authorization と URL を正しく組む（ha.js 経由）', async () => {
  const f = hassFetch([st('off')]);
  const src = createOpening({ fetch: f, env: ENV });
  await src.poll();
  assert.equal(f.calls[0].url, 'http://ha.local:8123/api/states/binary_sensor.living_window');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer tok');
});
