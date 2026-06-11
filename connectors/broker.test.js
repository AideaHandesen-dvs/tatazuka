// broker.js の契約テスト（依存ゼロ・node:test）。
//   node --test connectors/broker.test.js
//
// matchTopic は純関数で直接。配り直しは 127.0.0.1 の空きポートに実 listen し、対向は**自前の
// mqtt.js クライアント**で叩く＝クライアントとブローカーの相互運用そのものが契約
// （実機ファーム（PubSubClient）も同じ 3.1.1 QoS0 サブセットを喋る）。
//
// 押さえる契約：
//   - matchTopic：完全一致・+（一階層）・#（以降全部・親自身も）・不一致
//   - CONNECT → CONNACK／SUBSCRIBE → SUBACK（mqtt.js が connected になり購読が立つ）
//   - A が購読する topic に B が publish → A に届く（read で見える）
//   - filter 違いには届かない／ワイルドカード購読にも届く
//   - 切断したクライアントは配布先から消える（ブローカーが死なない）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBroker, matchTopic } from './broker.js';
import { makeMqttClient } from './mqtt.js';

test('matchTopic：完全一致・+・#・不一致', () => {
  assert.ok(matchTopic('a/b/c', 'a/b/c'));
  assert.ok(!matchTopic('a/b/c', 'a/b/x'));
  assert.ok(!matchTopic('a/b', 'a/b/c'));        // filter が浅い（# なし）
  assert.ok(!matchTopic('a/b/c', 'a/b'));        // filter が深い
  assert.ok(matchTopic('a/+/c', 'a/b/c'));       // + は一階層任意
  assert.ok(!matchTopic('a/+', 'a/b/c'));
  assert.ok(matchTopic('a/#', 'a/b/c'));         // # は以降全部
  assert.ok(matchTopic('a/#', 'a'));             // 親階層自身にも一致（3.1.1 仕様）
  assert.ok(matchTopic('#', 'anything/at/all'));
});

// 実ブローカー（空きポート）＋自前クライアント 2 本で publish → subscribe の往復を見る。
async function withBroker(fn) {
  const b = createBroker({ port: 0, host: '127.0.0.1' });
  await b.ready;
  const url = `mqtt://127.0.0.1:${b.port()}`;
  try { await fn(url); } finally { b.close(); }
}
const until = async (cond, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('購読した topic への publish が届く（自前クライアント同士の相互運用）', async () => {
  await withBroker(async (url) => {
    const got = [];
    const a = makeMqttClient({ url, onMessage: (t, p) => got.push([t, p]) });
    const bcli = makeMqttClient({ url });
    a.subscribe('tatazuka/body/stackchan/cmd/face');
    bcli.publish('tatazuka/body/stackchan/cmd/face', '{"eyes":"happy"}');
    await until(() => got.length >= 1);
    assert.deepEqual(got[0], ['tatazuka/body/stackchan/cmd/face', '{"eyes":"happy"}']);
    assert.equal(a.read('tatazuka/body/stackchan/cmd/face'), '{"eyes":"happy"}'); // pull でも見える
    a.close(); bcli.close();
  });
});

test('filter 違いには届かない／ワイルドカード（#）購読には届く', async () => {
  await withBroker(async (url) => {
    const plain = [], wild = [];
    const a = makeMqttClient({ url, onMessage: (t) => plain.push(t) });
    const w = makeMqttClient({ url, onMessage: (t) => wild.push(t) });
    const pub = makeMqttClient({ url });
    a.subscribe('body/x/cmd/face');
    w.subscribe('body/#');
    pub.publish('body/y/cmd/neck', '{"gesture":"nod"}');
    await until(() => wild.length >= 1);
    assert.deepEqual(wild, ['body/y/cmd/neck'], '# 購読には届く');
    assert.deepEqual(plain, [], '関係ない filter には届かない');
    a.close(); w.close(); pub.close();
  });
});

test('切断したクライアントが居ても配り直しは生きている', async () => {
  await withBroker(async (url) => {
    const got = [];
    const a = makeMqttClient({ url, onMessage: (t, p) => got.push(p) });
    const dead = makeMqttClient({ url });
    const pub = makeMqttClient({ url });
    a.subscribe('t/ev');
    dead.subscribe('t/ev');
    pub.publish('t/ev', '1');
    await until(() => got.length >= 1);
    dead.close();                                   // 片方が黙って切れる
    await new Promise((r) => setTimeout(r, 50));
    pub.publish('t/ev', '2');
    await until(() => got.length >= 2);
    assert.deepEqual(got, ['1', '2'], '残ったクライアントには届き続ける');
    a.close(); pub.close();
  });
});
