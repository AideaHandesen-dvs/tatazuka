// net.js の契約テスト（依存ゼロ・node:test）。readIfaces を注入し実 /sys は読まない。
//   node --test connectors/net.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1, §7-1）：
//   - TZ_NET が無ければ createNet は null（PE：connector オフ）
//   - poll() は online↔offline の遷移だけを返す。初回は基準だけ。lo は数えない
//   - online のとき ctx.iface に up な if 名を乗せる
//   - readIfaces が null／例外なら null（黙る・PE）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createNet } from './net.js';

// if 配列を順に返す readIfaces スタブ（末尾に達したら最後を返し続ける）。null/'!throw' で失敗
function ifaceReader(states) {
  let i = 0;
  return async () => {
    const s = states[Math.min(i++, states.length - 1)];
    if (s === '!throw') throw new Error('boom');
    return s;
  };
}
const ENV = { TZ_NET: '1' };
const UP = [{ name: 'lo', operstate: 'unknown' }, { name: 'eth0', operstate: 'up' }];
const DOWN = [{ name: 'lo', operstate: 'unknown' }, { name: 'eth0', operstate: 'down' }];

test('TZ_NET 未設定なら null（PE：connector オフ）', () => {
  assert.equal(createNet({ readIfaces: ifaceReader([]), env: {} }), null);
  assert.ok(createNet({ readIfaces: ifaceReader([]), env: ENV }));
});

test('初回は基準だけ。online↔offline の遷移で net.offline / net.online（ctx.iface 付き）', async () => {
  const src = createNet({ readIfaces: ifaceReader([UP, UP, DOWN, DOWN, UP]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime（online）
  assert.equal(await src.poll(), null);                  // online→online：無変化
  assert.deepEqual(await src.poll(), { situation: 'net.offline', ctx: undefined }); // 切れた
  assert.equal(await src.poll(), null);                  // offline→offline：無変化
  assert.deepEqual(await src.poll(), { situation: 'net.online', ctx: { iface: 'eth0' } }); // 復活
});

test('lo だけが up でもオフライン扱い（lo は数えない）', async () => {
  const loOnly = [{ name: 'lo', operstate: 'up' }, { name: 'eth0', operstate: 'down' }];
  const src = createNet({ readIfaces: ifaceReader([loOnly, UP]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime（lo だけ up＝オフライン）
  assert.deepEqual(await src.poll(), { situation: 'net.online', ctx: { iface: 'eth0' } }); // eth0 が上がってオンライン
});

test('readIfaces が null／例外なら null（黙る・PE）', async () => {
  assert.equal(await createNet({ readIfaces: ifaceReader([null]), env: ENV }).poll(), null);
  const boom = createNet({ readIfaces: ifaceReader(['!throw']), env: ENV });
  assert.equal(await boom.poll(), null);
});
