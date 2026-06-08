// weather.js の契約テスト（依存ゼロ・node:test）。fetch を注入し実ネットは飛ばさない。
//   node --test server/weather.test.js
//
// 押さえる契約：
//   - 場所未設定なら createWeather は null（天気オフ＝PE）
//   - poll() は降水の遷移（降り始め/上がり・雪・雷）を検知。初回は「始まった」と言わない
//   - 気温の極端（暑/寒）は閾値帯に入った瞬間に一度だけ
//   - TZ_CITY は geocoding で解決（一度だけ）。失敗すれば天気オフに縮退
//   - 取得失敗（!ok）は null（佇かを黙らせるだけ＝フォールバックは behavior 側）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeather } from './weather.js';

const cur = (temp, code, isDay = 1) => ({ temperature_2m: temp, weather_code: code, is_day: isDay });

// forecasts を順に返す fetch スタブ。geocoding は geo を返す。url を calls に記録
function makeFetch({ geo, forecasts }) {
  let i = 0;
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (String(url).includes('geocoding')) return { ok: true, async json() { return geo; } };
    const f = forecasts[Math.min(i, forecasts.length - 1)];
    i++;
    if (f === '!ok') return { ok: false, async json() { return {}; } };
    return { ok: true, async json() { return { current: f }; } };
  };
  fn.calls = calls;
  return fn;
}

// lat/lon 直指定（geocoding を飛ばす）で天気源を作る
const withLatLon = (forecasts) =>
  createWeather({ env: { TZ_LAT: '35', TZ_LON: '139' }, fetchImpl: makeFetch({ forecasts }) });

test('場所未設定なら null（天気オフ＝PE）', () => {
  assert.equal(createWeather({ env: {} }), null);
});

test('降水の遷移：乾き→雨＝降り始め、雨→乾き＝上がり', async () => {
  const w = withLatLon([cur(20, 0), cur(18, 61), cur(18, 61), cur(19, 0)]);
  assert.equal(await w.poll(), null, '初回・乾きは無言');
  assert.equal((await w.poll()).situation, 'weather.rain.start');
  assert.equal(await w.poll(), null, '雨が続くだけなら無言');
  assert.equal((await w.poll()).situation, 'weather.rain.stop');
});

test('初回が雨でも「降り始め」とは言わない（prev が無い）', async () => {
  const w = withLatLon([cur(18, 61)]);
  assert.equal(await w.poll(), null);
});

test('雪・雷はそれぞれ専用 situation', async () => {
  const snow = withLatLon([cur(1, 0), cur(0, 71)]);
  await snow.poll();
  assert.equal((await snow.poll()).situation, 'weather.snow');

  const thunder = withLatLon([cur(20, 0), cur(20, 95)]);
  await thunder.poll();
  assert.equal((await thunder.poll()).situation, 'weather.thunder');
});

test('気温の極端は閾値帯に入った瞬間だけ一度', async () => {
  const hot = withLatLon([cur(31, 0), cur(33, 0)]);
  assert.equal((await hot.poll()).situation, 'weather.hot');
  assert.equal(await hot.poll(), null, '暑いまま続いても繰り返さない');

  const cold = withLatLon([cur(2, 3), cur(1, 3)]);
  assert.equal((await cold.poll()).situation, 'weather.cold');
  assert.equal(await cold.poll(), null);
});

test('降水イベントが気温より優先（雨かつ暑い→rain.start）', async () => {
  const w = withLatLon([cur(20, 0), cur(31, 61)]);
  await w.poll();
  assert.equal((await w.poll()).situation, 'weather.rain.start');
});

test('current() は変化に関係なく今の空模様を weather.morning で返す', async () => {
  const w = withLatLon([cur(22, 0)]);
  const r = await w.current();
  assert.equal(r.situation, 'weather.morning');
  assert.equal(r.ctx.weather.desc, '快晴');
  assert.equal(r.ctx.weather.tempC, 22);
});

test('取得失敗（!ok）は null', async () => {
  const w = withLatLon(['!ok']);
  assert.equal(await w.poll(), null);
});

test('TZ_CITY は geocoding で解決し、ctx.city に解決名が入る（一度だけ叩く）', async () => {
  const f = makeFetch({ geo: { results: [{ latitude: 35.6, longitude: 139.6, name: '東京' }] }, forecasts: [cur(20, 0), cur(21, 0)] });
  const w = createWeather({ env: { TZ_CITY: 'Tokyo' }, fetchImpl: f });
  const a = await w.current();
  const b = await w.current();
  assert.equal(a.ctx.weather.city, '東京');
  assert.equal(b.ctx.weather.city, '東京');
  assert.equal(f.calls.filter((u) => u.includes('geocoding')).length, 1, 'geocoding は一度だけ（以後キャッシュ）');
});

test('都市が解決できなければ天気オフに縮退（poll/current が null）', async () => {
  const f = makeFetch({ geo: { results: [] }, forecasts: [cur(20, 0)] });
  const w = createWeather({ env: { TZ_CITY: 'NoSuchCity' }, fetchImpl: f });
  assert.equal(await w.poll(), null);
  assert.equal(await w.current(), null);
});
