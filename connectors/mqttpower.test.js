// mqttpower.js の契約テスト（依存ゼロ・node:test）。fake client を注入し実ブローカーは叩かない。
//   node --test connectors/mqttpower.test.js
//
// 押さえる契約（イベント源パターン・非 HA 入力源の二例目。判定/persona/ctx は power と共有・mqtttemp と同型）：
//   - 共有クライアント未注入 or topic 未設定なら createMqttPower は null（PE：connector オフ）
//   - 作成時に topic を購読する（subscribe が呼ばれる）
//   - 最新 payload → pick → しきい値：high(500) 超が debounce 3 連続で power.high、戻し(400)割れが 3 連続で power.ok
//   - JSON payload は TZ_MQTT_POWER_PATH で取り出す（Tasmota の ENERGY.Power 等ネスト可）
//   - 未着（read=null）・非数値は黙る（PE）。ctx.watts は整数丸め

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMqttPower } from './mqttpower.js';

// fake MQTT クライアント：subscribe を記録し、read は与えた payload 列を順に吐く。
function fakeClient(payloads) {
  let i = 0;
  return {
    subscribed: [],
    subscribe(t) { this.subscribed.push(t); },
    read() { return payloads[Math.min(i++, payloads.length - 1)]; },
  };
}
const ENV = { TZ_MQTT_POWER: 'tele/plug/SENSOR' };

test('クライアント未注入／topic 未設定なら null（PE：connector オフ）', () => {
  assert.equal(createMqttPower({ env: ENV }), null);                       // client 無し
  assert.equal(createMqttPower({ client: fakeClient([]), env: {} }), null); // topic 無し
  assert.ok(createMqttPower({ client: fakeClient([]), env: ENV }));
});

test('作成時に topic を購読する', () => {
  const c = fakeClient([]);
  createMqttPower({ client: c, env: ENV });
  assert.deepEqual(c.subscribed, ['tele/plug/SENSOR']);
});

test('生値のしきい値：高い→power.high、落ち着き→power.ok（debounce 3・ctx.watts）', async () => {
  // high 500・margin 100（戻し 400）・debounce 3。
  const src = createMqttPower({ client: fakeClient(['100', '700', '700', '700', '300', '300', '300']), env: ENV });
  assert.equal(await src.poll(), null); // 100：基準（ok）
  assert.equal(await src.poll(), null); // 700：high 候補 1
  assert.equal(await src.poll(), null); // 700：high 候補 2
  assert.deepEqual(await src.poll(), { situation: 'power.high', ctx: { watts: 700 } }); // 3 連続 → 確定
  assert.equal(await src.poll(), null); // 300：ok 候補 1
  assert.equal(await src.poll(), null); // 300：ok 候補 2
  assert.deepEqual(await src.poll(), { situation: 'power.ok', ctx: { watts: 300 } });   // 3 連続 → 確定
});

test('JSON payload は path で取り出す（Tasmota の ENERGY.Power ＝ネスト）', async () => {
  const lo = '{"ENERGY":{"Power":4.8}}', hi = '{"ENERGY":{"Power":612.5}}';
  const src = createMqttPower({
    client: fakeClient([lo, hi, hi, hi]),
    env: { ...ENV, TZ_MQTT_POWER_PATH: 'ENERGY.Power' },
  });
  assert.equal(await src.poll(), null); // 4.8：基準（ok）
  assert.equal(await src.poll(), null); // 612.5：high 候補 1
  assert.equal(await src.poll(), null); // 候補 2
  assert.deepEqual(await src.poll(), { situation: 'power.high', ctx: { watts: 613 } }); // 3 連続 → 確定・整数丸め
});

test('未着（read=null）・非数値は黙る（PE）', async () => {
  const src = createMqttPower({ client: fakeClient([null, 'unavailable', '{"x":1}']), env: { ...ENV, TZ_MQTT_POWER_PATH: 'ENERGY.Power' } });
  assert.equal(await src.poll(), null); // null（未着）→ NaN → 黙る
  assert.equal(await src.poll(), null); // "unavailable"→ pick は path 指定で JSON.parse 失敗 → null → 黙る
  assert.equal(await src.poll(), null); // {"x":1}：ENERGY キー無し → null → 黙る
});
