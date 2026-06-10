// mqtthumidity.js の契約テスト（依存ゼロ・node:test）。fake client を注入し実ブローカーは叩かない。
//   node --test connectors/mqtthumidity.test.js
//
// 押さえる契約（イベント源パターン・非 HA 入力源の三例目。判定/persona/ctx は humidity と共有・mqtttemp と同型）：
//   - 共有クライアント未注入 or topic 未設定なら createMqttHumidity は null（PE：connector オフ）
//   - 作成時に topic を購読する（subscribe が呼ばれる）
//   - 最新 payload → pick → 快適帯：40 未満で humidity.dry、60 超で humidity.humid、帯内復帰で humidity.ok
//   - JSON payload は TZ_MQTT_HUMIDITY_PATH で取り出す（Tasmota の AM2301.Humidity 等ネスト可）
//   - 未着（read=null）・非数値は黙る（PE）。ctx.pct は整数丸め

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMqttHumidity } from './mqtthumidity.js';

// fake MQTT クライアント：subscribe を記録し、read は与えた payload 列を順に吐く。
function fakeClient(payloads) {
  let i = 0;
  return {
    subscribed: [],
    subscribe(t) { this.subscribed.push(t); },
    read() { return payloads[Math.min(i++, payloads.length - 1)]; },
  };
}
const ENV = { TZ_MQTT_HUMIDITY: 'home/living/hum' };

test('クライアント未注入／topic 未設定なら null（PE：connector オフ）', () => {
  assert.equal(createMqttHumidity({ env: ENV }), null);                       // client 無し
  assert.equal(createMqttHumidity({ client: fakeClient([]), env: {} }), null); // topic 無し
  assert.ok(createMqttHumidity({ client: fakeClient([]), env: ENV }));
});

test('作成時に topic を購読する', () => {
  const c = fakeClient([]);
  createMqttHumidity({ client: c, env: ENV });
  assert.deepEqual(c.subscribed, ['home/living/hum']);
});

test('生値の快適帯：乾燥→dry、じめじめ→humid、戻りは ok（debounce 2・ctx.pct）', async () => {
  // debounce 2・margin 5。40..60 が快適帯。
  const src = createMqttHumidity({ client: fakeClient(['50', '30', '30', '70', '70', '50', '50']), env: ENV });
  assert.equal(await src.poll(), null); // 50：基準（快適）
  assert.equal(await src.poll(), null); // 30：dry 候補 1
  assert.deepEqual(await src.poll(), { situation: 'humidity.dry', ctx: { pct: 30 } });   // 2 連続 → 確定
  assert.equal(await src.poll(), null); // 70：humid 候補 1
  assert.deepEqual(await src.poll(), { situation: 'humidity.humid', ctx: { pct: 70 } }); // 2 連続 → 確定
  assert.equal(await src.poll(), null); // 50：ok 候補 1（極から戻るには margin 余分に＝45 超で ok 圏）
  assert.deepEqual(await src.poll(), { situation: 'humidity.ok', ctx: { pct: 50 } });    // 2 連続 → 確定
});

test('JSON payload は path で取り出す（Tasmota の AM2301.Humidity ＝ネスト・小数丸め）', async () => {
  const src = createMqttHumidity({
    client: fakeClient(['{"AM2301":{"Humidity":52.3}}', '{"AM2301":{"Humidity":28.6}}', '{"AM2301":{"Humidity":28.6}}']),
    env: { ...ENV, TZ_MQTT_HUMIDITY_PATH: 'AM2301.Humidity' },
  });
  assert.equal(await src.poll(), null); // 52.3：基準
  assert.equal(await src.poll(), null); // 28.6：dry 候補 1
  assert.deepEqual(await src.poll(), { situation: 'humidity.dry', ctx: { pct: 29 } }); // 確定・整数丸め
});

test('未着（read=null）・非数値は黙る（PE）', async () => {
  const src = createMqttHumidity({ client: fakeClient([null, 'unavailable', '{"x":1}']), env: { ...ENV, TZ_MQTT_HUMIDITY_PATH: 'AM2301.Humidity' } });
  assert.equal(await src.poll(), null); // null（未着）→ NaN → 黙る
  assert.equal(await src.poll(), null); // "unavailable"→ pick は path 指定で JSON.parse 失敗 → null → 黙る
  assert.equal(await src.poll(), null); // {"x":1}：AM2301 キー無し → null → 黙る
});
