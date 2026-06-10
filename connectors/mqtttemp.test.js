// mqtttemp.js の契約テスト（依存ゼロ・node:test）。fake client を注入し実ブローカーは叩かない。
//   node --test connectors/mqtttemp.test.js
//
// 押さえる契約（イベント源パターン・非 HA 入力源の初例。判定/persona/ctx は roomtemp と共有）：
//   - 共有クライアント未注入 or topic 未設定なら createMqttTemp は null（PE：connector オフ）
//   - 作成時に topic を購読する（subscribe が呼ばれる）
//   - 最新 payload → pick → 快適帯：18 未満で roomtemp.cold、28 超で roomtemp.hot、帯内復帰で roomtemp.ok
//   - JSON payload は TZ_MQTT_TEMP_PATH で取り出す（生値/フィールド）
//   - 未着（read=null）・非数値は黙る（PE）。ctx.tempC に小数 1 桁丸め

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMqttTemp } from './mqtttemp.js';

// fake MQTT クライアント：subscribe を記録し、read は与えた payload 列を順に吐く。
function fakeClient(payloads) {
  let i = 0;
  return {
    subscribed: [],
    subscribe(t) { this.subscribed.push(t); },
    read() { return payloads[Math.min(i++, payloads.length - 1)]; },
  };
}
const ENV = { TZ_MQTT_TEMP: 'home/living/temp' };

test('クライアント未注入／topic 未設定なら null（PE：connector オフ）', () => {
  assert.equal(createMqttTemp({ env: ENV }), null);                       // client 無し
  assert.equal(createMqttTemp({ client: fakeClient([]), env: {} }), null); // topic 無し
  assert.ok(createMqttTemp({ client: fakeClient([]), env: ENV }));
});

test('作成時に topic を購読する', () => {
  const c = fakeClient([]);
  createMqttTemp({ client: c, env: ENV });
  assert.deepEqual(c.subscribed, ['home/living/temp']);
});

test('生値の快適帯：寒い→cold、暑い→hot、戻りは ok（debounce 2・ctx.tempC）', async () => {
  // debounce 2・margin 1。18..28 が快適帯。
  const src = createMqttTemp({ client: fakeClient(['22', '15', '15', '30', '30', '24', '24']), env: ENV });
  assert.equal(await src.poll(), null); // 22：基準（快適）
  assert.equal(await src.poll(), null); // 15：cold 候補 1
  assert.deepEqual(await src.poll(), { situation: 'roomtemp.cold', ctx: { tempC: 15 } }); // 2 連続 → 確定
  assert.equal(await src.poll(), null); // 30：hot 候補 1
  assert.deepEqual(await src.poll(), { situation: 'roomtemp.hot', ctx: { tempC: 30 } });  // 2 連続 → 確定
  assert.equal(await src.poll(), null); // 24：ok 候補 1
  assert.deepEqual(await src.poll(), { situation: 'roomtemp.ok', ctx: { tempC: 24 } });   // 2 連続 → 確定
});

test('JSON payload は path で取り出す（ネスト可）', async () => {
  const src = createMqttTemp({
    client: fakeClient(['{"temperature":22.4}', '{"temperature":14.6}', '{"temperature":14.6}']),
    env: { ...ENV, TZ_MQTT_TEMP_PATH: 'temperature' },
  });
  assert.equal(await src.poll(), null); // 22.4：基準
  assert.equal(await src.poll(), null); // 14.6：cold 候補 1
  assert.deepEqual(await src.poll(), { situation: 'roomtemp.cold', ctx: { tempC: 14.6 } }); // 確定・小数保持
});

test('未着（read=null）・非数値は黙る（PE）', async () => {
  const src = createMqttTemp({ client: fakeClient([null, 'unavailable', '{"x":1}']), env: { ...ENV, TZ_MQTT_TEMP_PATH: 'temperature' } });
  assert.equal(await src.poll(), null); // null（未着）→ NaN → 黙る
  assert.equal(await src.poll(), null); // "unavailable"→ pick は path 指定で JSON.parse 失敗 → null → 黙る
  assert.equal(await src.poll(), null); // {"x":1}：temperature キー無し → null → 黙る
});
