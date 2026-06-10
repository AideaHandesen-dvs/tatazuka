// roomtemp.js の契約テスト（依存ゼロ・node:test）。fetch を注入し実 HA・実センサは叩かない。
//   node --test connectors/roomtemp.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1）：
//   - URL/トークン/対象 entity のどれかが欠ければ createRoomTemp は null（PE：connector オフ）
//   - 初回は基準だけ。快適帯[18,28]の外で roomtemp.cold/roomtemp.hot、戻れば roomtemp.ok（両側帯・debounce=2）
//   - margin=1 の再入ヒステリシス／単発スパイク弾き
//   - state が数値でない（"unavailable" 等）→ null（黙る・PE）。band 状態は壊さない
//   - ctx.tempC に小数1桁の温度。TZ_ROOMTEMP_LOW/HIGH で快適帯を変えられる

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomTemp } from './roomtemp.js';

// state（HA は数値センサも文字列で返す）を順に返す fetch スタブ。'!ok'/'!throw' で失敗を演じる。
function hassFetch(states) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const s = states[Math.min(i++, states.length - 1)];
    if (s === '!throw') throw new Error('down');
    if (s === '!ok') return { ok: false, async json() { return {}; } };
    return { ok: true, async json() { return { entity_id: 'sensor.t', state: String(s), attributes: {} }; } };
  };
  fn.calls = calls;
  return fn;
}
const ENV = { TZ_HASS_URL: 'http://ha.local:8123/', TZ_HASS_TOKEN: 'tok', TZ_HASS_TEMP: 'sensor.living_temp' };

test('URL/トークン/対象が欠ければ null（PE：connector オフ）', () => {
  const f = hassFetch([]);
  assert.equal(createRoomTemp({ fetch: f, env: {} }), null);
  assert.equal(createRoomTemp({ fetch: f, env: { TZ_HASS_URL: 'x', TZ_HASS_TOKEN: 't' } }), null); // entity 無し
  assert.ok(createRoomTemp({ fetch: f, env: ENV }));                                                // 揃えば有効
});

test('初回は基準だけ。寒い/暑い/快適の遷移（debounce=2・ctx.tempC 小数1桁）', async () => {
  // 22(基準ok) → 15,15(寒い) → 22,22(快適復帰) → 30,30(暑い)
  const src = createRoomTemp({ fetch: hassFetch([22, 15, 15, 22, 22, 30.5, 30.5]), env: ENV });
  assert.equal(await src.poll(), null);  // prime（快適帯の中）
  assert.equal(await src.poll(), null);  // 15：low 1 回目（未確定）
  assert.deepEqual(await src.poll(), { situation: 'roomtemp.cold', ctx: { tempC: 15 } });
  assert.equal(await src.poll(), null);  // 22：ok 1 回目（未確定）
  assert.deepEqual(await src.poll(), { situation: 'roomtemp.ok', ctx: { tempC: 22 } });
  assert.equal(await src.poll(), null);  // 30.5：high 1 回目
  assert.deepEqual(await src.poll(), { situation: 'roomtemp.hot', ctx: { tempC: 30.5 } });
});

test('margin=1 の再入ヒステリシス（極に入ったら 1℃ 余分に戻るまで維持・復帰も debounce=2）', async () => {
  const src = createRoomTemp({ fetch: hassFetch([22, 16, 16, 18.5, 19.5, 19.5]), env: ENV });
  assert.equal(await src.poll(), null);  // prime
  assert.equal(await src.poll(), null);  // 16：low 1
  assert.deepEqual(await src.poll(), { situation: 'roomtemp.cold', ctx: { tempC: 16 } });
  assert.equal(await src.poll(), null);  // 18.5：18〜19 の縁＝まだ戻し切らない（margin）→ cold 維持
  assert.equal(await src.poll(), null);  // 19.5：> 18+margin だが ok 復帰も debounce 1 回目（未確定）
  assert.deepEqual(await src.poll(), { situation: 'roomtemp.ok', ctx: { tempC: 19.5 } }); // 2 連続 → 復帰確定
});

test('単発スパイクは弾く（debounce=2・間に基準値が挟まると数え直し）', async () => {
  const src = createRoomTemp({ fetch: hassFetch([22, 10, 22, 10, 10]), env: ENV });
  assert.equal(await src.poll(), null);  // prime
  assert.equal(await src.poll(), null);  // 10：low 1（未確定）
  assert.equal(await src.poll(), null);  // 22：ok に戻る＝スパイク → カウント捨て
  assert.equal(await src.poll(), null);  // 10：low 数え直し 1
  assert.deepEqual(await src.poll(), { situation: 'roomtemp.cold', ctx: { tempC: 10 } }); // 2 連続 → 確定
});

test('state が数値でなければ黙る（PE）。band 状態は壊さない', async () => {
  const src = createRoomTemp({ fetch: hassFetch([22, 'unavailable', 30, 30]), env: ENV });
  assert.equal(await src.poll(), null);  // prime（ok）
  assert.equal(await src.poll(), null);  // "unavailable" → NaN → 黙る（band に流さない）
  assert.equal(await src.poll(), null);  // 30：high 1
  assert.deepEqual(await src.poll(), { situation: 'roomtemp.hot', ctx: { tempC: 30 } });
});

test('fetch が !ok／例外なら null（黙る・PE）', async () => {
  const bad = createRoomTemp({ fetch: hassFetch(['!ok', '!ok']), env: ENV });
  assert.equal(await bad.poll(), null);
  const boom = createRoomTemp({ fetch: hassFetch(['!throw']), env: ENV });
  assert.equal(await boom.poll(), null);
});

test('TZ_ROOMTEMP_LOW/HIGH で快適帯を変えられる（帯 [20,25] なら 26 は暑い）', async () => {
  const env = { ...ENV, TZ_ROOMTEMP_LOW: '20', TZ_ROOMTEMP_HIGH: '25' };
  const src = createRoomTemp({ fetch: hassFetch([22, 26, 26]), env });
  assert.equal(await src.poll(), null);  // prime（22＝[20,25]の中＝快適）
  assert.equal(await src.poll(), null);  // 26：high 1
  assert.deepEqual(await src.poll(), { situation: 'roomtemp.hot', ctx: { tempC: 26 } });
});

test('Authorization と URL を正しく組む（ha.js 経由・末尾スラッシュ正規化・entity エンコード）', async () => {
  const f = hassFetch([22]);
  const src = createRoomTemp({ fetch: f, env: ENV });
  await src.poll();
  assert.equal(f.calls[0].url, 'http://ha.local:8123/api/states/sensor.living_temp');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer tok');
});
