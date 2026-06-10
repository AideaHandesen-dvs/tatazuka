// mqtt.js の契約テスト（依存ゼロ・node:test）。socket を注入し実ブローカー・実 TCP は叩かない。
//   node --test connectors/mqtt.test.js
//
// 押さえる契約（自前 MQTT 3.1.1 QoS0・ws.js と同じ「割り切ったワイヤを手書き」精神）：
//   - TZ_MQTT_URL（or opts.url）が無い／壊れていれば makeMqttClient は null（PE：MQTT オフ）
//   - 'connect' で CONNECT を送る／CONNACK 受理後に購読中の topic を SUBSCRIBE
//   - 受けた PUBLISH の payload を topic ごとに buffer＝read(topic) で最新を返す（push→pull）
//   - TCP 断片化（パケットが二つの data に割れる）でも 1 パケットに連結して解釈
//   - 接続済みに subscribe したら即 SUBSCRIBE／未着 topic の read は null／同 topic は最新で上書き
//   - 切断で自動再接続（connect が再度呼ばれる）
//   - pick：生値そのまま／JSON パス／ネスト／壊れ JSON・キー無しは null

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { makeMqttClient, pick } from './mqtt.js';

// net.Socket 互換の最小フェイク（write を記録・data/connect/close をテストから emit）。
class FakeSock extends EventEmitter {
  constructor() { super(); this.written = []; this.ended = false; }
  write(b) { this.written.push(Buffer.from(b)); return true; }
  end() { this.ended = true; }
  destroy() { this.ended = true; }
}
// テスト用 connect factory：作ったフェイクを配列に溜める（再接続の検証用）。
function fakeConnect() {
  const socks = [];
  const fn = () => { const s = new FakeSock(); socks.push(s); return s; };
  fn.socks = socks;
  return fn;
}
// テスト用に PUBLISH（QoS0）パケットを組む。
function lenBytes(n) { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0); return Buffer.from(o); }
function pub(topic, payload) {
  const t = Buffer.from(topic), p = Buffer.from(payload);
  const body = Buffer.concat([Buffer.from([(t.length >> 8) & 0xff, t.length & 0xff]), t, p]);
  return Buffer.concat([Buffer.from([0x30]), lenBytes(body.length), body]);
}
const CONNACK_OK = Buffer.from([0x20, 0x02, 0x00, 0x00]); // type2・remlen2・flags0・rc0
const typeOf = (b) => b[0] >> 4;
const hasStr = (b, s) => b.includes(Buffer.from(s));

test('URL が無い／壊れていれば null（PE：MQTT オフ）', () => {
  assert.equal(makeMqttClient({ env: {} }), null);
  assert.equal(makeMqttClient({ url: 'not a url', connect: fakeConnect() }), null);
  assert.ok(makeMqttClient({ url: 'mqtt://localhost:1883', connect: fakeConnect() }));
});

test('connect で CONNECT／CONNACK 後に SUBSCRIBE／PUBLISH を read で返す', () => {
  const c = fakeConnect();
  const cli = makeMqttClient({ url: 'mqtt://localhost:1883', connect: c });
  const s = c.socks[0];
  cli.subscribe('home/living/temp');      // 接続前に購読予約
  assert.equal(cli.read('home/living/temp'), null); // まだ何も来てない

  s.emit('connect');
  assert.equal(typeOf(s.written[0]), 1);  // 1 = CONNECT
  assert.ok(hasStr(s.written[0], 'MQTT'));

  s.emit('data', CONNACK_OK);             // 受理 → 購読を送出
  const sub = s.written.find((b) => typeOf(b) === 8); // 8 = SUBSCRIBE
  assert.ok(sub && hasStr(sub, 'home/living/temp'));

  s.emit('data', pub('home/living/temp', '21.5'));
  assert.equal(cli.read('home/living/temp'), '21.5');
  cli.close();
  assert.ok(s.ended);
});

test('TCP 断片化：パケットが二つの data に割れても解釈する', () => {
  const c = fakeConnect();
  const cli = makeMqttClient({ url: 'mqtt://localhost:1883', connect: c });
  const s = c.socks[0];
  cli.subscribe('t');
  s.emit('connect'); s.emit('data', CONNACK_OK);

  const p = pub('sensor/x', '999');
  s.emit('data', p.subarray(0, 3));       // 前半だけ → まだ確定しない
  assert.equal(cli.read('sensor/x'), null);
  s.emit('data', p.subarray(3));          // 後半 → 連結して確定
  assert.equal(cli.read('sensor/x'), '999');
  cli.close();
});

test('接続後 subscribe は即送出／未着 topic は null／同 topic は最新で上書き', () => {
  const c = fakeConnect();
  const cli = makeMqttClient({ url: 'mqtt://localhost:1883', connect: c });
  const s = c.socks[0];
  s.emit('connect'); s.emit('data', CONNACK_OK);

  const before = s.written.length;
  cli.subscribe('a/b');                    // 接続済み → 即 SUBSCRIBE
  assert.ok(s.written.slice(before).some((b) => typeOf(b) === 8 && hasStr(b, 'a/b')));

  assert.equal(cli.read('nope'), null);    // 未着
  s.emit('data', pub('a/b', '1'));
  s.emit('data', pub('a/b', '2'));
  assert.equal(cli.read('a/b'), '2');      // 最新で上書き
  cli.close();
});

test('複数 data に複数パケットが詰まっていても全部処理する', () => {
  const c = fakeConnect();
  const cli = makeMqttClient({ url: 'mqtt://localhost:1883', connect: c });
  const s = c.socks[0];
  s.emit('connect'); s.emit('data', CONNACK_OK);
  s.emit('data', Buffer.concat([pub('x', '10'), pub('y', '20')])); // 一度に二本
  assert.equal(cli.read('x'), '10');
  assert.equal(cli.read('y'), '20');
  cli.close();
});

test('切断で自動再接続（connect が再度呼ばれる）', async () => {
  const c = fakeConnect();
  const cli = makeMqttClient({ url: 'mqtt://localhost:1883', connect: c, reconnectMs: 10 });
  const s = c.socks[0];
  s.emit('connect'); s.emit('data', CONNACK_OK);
  assert.equal(c.socks.length, 1);
  s.emit('close');                          // ブローカー落ちた
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.socks.length, 2);          // 新しいソケットで再接続
  cli.close();
});

test('CONNACK が拒否（rc≠0）なら SUBSCRIBE を送らない', () => {
  const c = fakeConnect();
  const cli = makeMqttClient({ url: 'mqtt://localhost:1883', connect: c });
  const s = c.socks[0];
  cli.subscribe('z');
  s.emit('connect');
  s.emit('data', Buffer.from([0x20, 0x02, 0x00, 0x05])); // rc=5（認証失敗）
  assert.ok(!s.written.some((b) => typeOf(b) === 8));
  cli.close();
});

test('pick：生値／JSON パス／ネスト／壊れ・キー無しは null', () => {
  assert.equal(pick('21.5', ''), '21.5');                       // 生値そのまま
  assert.equal(pick('{"temperature":21.5}', 'temperature'), 21.5);
  assert.equal(pick('{"ENERGY":{"Power":42}}', 'ENERGY.Power'), 42); // Tasmota ネスト
  assert.equal(pick('not json', 'a'), null);                    // 壊れ JSON
  assert.equal(pick('{"a":1}', 'b'), null);                     // キー無し
  assert.equal(pick('{"a":{"b":1}}', 'a.c'), null);             // ネスト先キー無し
  assert.equal(pick(null, ''), null);                           // payload 無し
});
