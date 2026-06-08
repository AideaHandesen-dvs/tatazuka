// home-assistant.js の契約テスト（依存ゼロ・node:test）。fetch を注入し実 HA は叩かない。
//   node --test connectors/home-assistant.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1）：
//   - URL/トークン/対象 entity のどれかが欠ければ createHomeAssistant は null（PE：connector オフ）
//   - poll() は在宅/外出の遷移だけを返す。初回は基準を取るだけで喋らない
//   - home 以外はすべて外出扱い＝ゾーン間移動（not_home→Work）では発話しない
//   - friendly_name があれば ctx.who に乗せる
//   - fetch が !ok／例外なら null（黙る・PE）。Authorization と URL を正しく組む

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomeAssistant } from './home-assistant.js';

// states を順に返す fetch スタブ（末尾に達したら最後を返し続ける）。'!ok'/'!throw' で失敗を演じる
function hassFetch(states) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const st = states[Math.min(i++, states.length - 1)];
    if (st === '!throw') throw new Error('down');
    if (st === '!ok') return { ok: false, async json() { return {}; } };
    return { ok: true, async json() { return st; } };
  };
  fn.calls = calls;
  return fn;
}
const st = (state, who) => ({ entity_id: 'person.john', state, attributes: who ? { friendly_name: who } : {} });
const ENV = { TZ_HASS_URL: 'http://ha.local:8123/', TZ_HASS_TOKEN: 'tok', TZ_HASS_PERSON: 'person.john' };

test('URL/トークン/対象が欠ければ null（PE：connector オフ）', () => {
  const f = hassFetch([]);
  assert.equal(createHomeAssistant({ fetch: f, env: {} }), null);
  assert.equal(createHomeAssistant({ fetch: f, env: { TZ_HASS_URL: 'x', TZ_HASS_TOKEN: 't' } }), null); // entity 無し
  assert.equal(createHomeAssistant({ fetch: f, env: { TZ_HASS_URL: 'x', TZ_HASS_PERSON: 'p' } }), null); // token 無し
  assert.ok(createHomeAssistant({ fetch: f, env: ENV }));                                                 // 揃えば有効
});

test('初回は基準だけ。home↔not_home の遷移で出迎え/見送り', async () => {
  const src = createHomeAssistant({ fetch: hassFetch([st('home'), st('home'), st('not_home'), st('not_home'), st('home')]), env: ENV });
  assert.equal(await src.poll(), null);                          // prime（在宅）
  assert.equal(await src.poll(), null);                          // home→home：無変化
  assert.deepEqual(await src.poll(), { situation: 'home.away', ctx: undefined }); // 出かけた
  assert.equal(await src.poll(), null);                          // not_home→not_home：無変化
  assert.deepEqual(await src.poll(), { situation: 'home.back', ctx: undefined }); // 帰宅
});

test('home 以外は外出扱い＝ゾーン間移動では発話しない', async () => {
  const src = createHomeAssistant({ fetch: hassFetch([st('home'), st('not_home'), st('Work'), st('Gym')]), env: ENV });
  assert.equal(await src.poll(), null);                          // prime（在宅）
  assert.equal((await src.poll()).situation, 'home.away');       // 在宅→外出
  assert.equal(await src.poll(), null);                          // not_home→Work：外出のまま
  assert.equal(await src.poll(), null);                          // Work→Gym：外出のまま
});

test('friendly_name があれば ctx.who に乗る', async () => {
  const src = createHomeAssistant({ fetch: hassFetch([st('not_home', 'John'), st('home', 'John')]), env: ENV });
  assert.equal(await src.poll(), null);                          // prime（外出）
  assert.deepEqual(await src.poll(), { situation: 'home.back', ctx: { who: 'John' } });
});

test('fetch が !ok／例外なら null（黙る・PE）', async () => {
  const bad = createHomeAssistant({ fetch: hassFetch(['!ok', '!ok']), env: ENV });
  assert.equal(await bad.poll(), null);
  const boom = createHomeAssistant({ fetch: hassFetch(['!throw']), env: ENV });
  assert.equal(await boom.poll(), null);
});

test('Authorization と URL を正しく組む（末尾スラッシュ正規化・entity エンコード）', async () => {
  const f = hassFetch([st('home')]);
  const src = createHomeAssistant({ fetch: f, env: ENV });
  await src.poll();
  assert.equal(f.calls[0].url, 'http://ha.local:8123/api/states/person.john'); // 末尾 / は剥がれる
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer tok');
});
