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

// ===== OS 別バックエンド：macOS（ifconfig）=====（README §7-3・確定③）
// opts.platform='darwin' で readIfacesMac 経路に入り、opts.run で実 ifconfig を叩かず出力を注入する。
// 実機 macOS 10.15.7（osx-kvm）の ifconfig 形：en0 は flags に RUNNING＝up、lo0 は LOOPBACK で除外。
const IFC_UP = // en0 が UP,RUNNING（status: active）＋ lo0
  'en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500\n' +
  '\tether 52:54:00:c9:18:27 \n' +
  '\tinet 10.0.2.15 netmask 0xffffff00 broadcast 10.0.2.255\n' +
  '\tstatus: active\n' +
  'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384\n' +
  '\tinet 127.0.0.1 netmask 0xff000000 \n';
const IFC_DOWN = // en0 が RUNNING 落ち（ケーブル/Wi-Fi 断）＋ lo0
  'en0: flags=8862<BROADCAST,SMART,SIMPLEX,MULTICAST> mtu 1500\n' +
  '\tether 52:54:00:c9:18:27 \n' +
  'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384\n';
function ifconfigRun(outs) {
  let i = 0;
  return async () => {
    const o = outs[Math.min(i++, outs.length - 1)];
    if (o === '!throw') throw new Error('boom');
    return o;
  };
}

test('macOS：ifconfig の RUNNING を up に正規化＋lo0 は除外。online↔offline 遷移（§7-3）', async () => {
  // offline（prime）→ online（en0 復帰）→ offline（en0 落ち）
  const src = createNet({ run: ifconfigRun([IFC_DOWN, IFC_UP, IFC_DOWN]), platform: 'darwin', env: ENV });
  assert.equal(await src.poll(), null);                  // prime（en0 down＝オフライン。lo0 は数えない）
  assert.deepEqual(await src.poll(), { situation: 'net.online', ctx: { iface: 'en0' } });
  assert.deepEqual(await src.poll(), { situation: 'net.offline', ctx: undefined });
});

test('macOS：ifconfig 不在/例外なら null（黙る・PE）', async () => {
  const a = createNet({ run: async () => null, platform: 'darwin', env: ENV });
  assert.equal(await a.poll(), null);
  const b = createNet({ run: ifconfigRun(['!throw']), platform: 'darwin', env: ENV });
  assert.equal(await b.poll(), null);
});

// ===== OS 別バックエンド：Windows（Win32_NetworkAdapter）=====（README §7-3・確定③）
// opts.platform='win32' で readIfacesWin 経路に入り、opts.run で実 powershell を叩かず Format-List 出力を注入。
// PhysicalAdapter=True だけ採り NetConnectionStatus==2 を up に正規化＝online↔offline 遷移は無改修で再利用。
// 出力は CRLF なので fixture も \r\n で実バイト再現。WIN_NET_REAL は実機 tiny10 の verbatim（全 10 アダプタ）。
const crlf = (s) => s.replace(/\n/g, '\r\n');
const winNet = (name, id, status, phys, enabled) =>
  `Name                : ${name}\nNetConnectionID     : ${id}\nNetConnectionStatus : ${status}\nPhysicalAdapter     : ${phys}\nNetEnabled          : ${enabled}\n`;
// 実機 tiny10 verbatim：物理は Intel PRO/1000（Ethernet・接続=2）だけ。他は Kernel Debug／WAN Miniport の仮想。
const WIN_NET_REAL = crlf([
  winNet('Microsoft Kernel Debug Network Adapter', '', '', 'False', ''),
  winNet('Intel(R) PRO/1000 MT Network Connection', 'Ethernet', '2', 'True', 'True'),
  winNet('WAN Miniport (SSTP)', '', '', 'False', ''),
  winNet('WAN Miniport (IKEv2)', '', '', 'False', ''),
  winNet('WAN Miniport (L2TP)', '', '', 'False', ''),
  winNet('WAN Miniport (PPTP)', '', '', 'False', ''),
  winNet('WAN Miniport (PPPOE)', '', '', 'False', ''),
  winNet('WAN Miniport (IP)', '', '', 'False', ''),
  winNet('WAN Miniport (IPv6)', '', '', 'False', ''),
  winNet('WAN Miniport (Network Monitor)', '', '', 'False', ''),
].join('\n'));
// 同フォーマットで物理が切断（NetConnectionStatus 7=Media disconnected）。仮想は同じく無視される。
const WIN_NET_DOWN = crlf([
  winNet('Microsoft Kernel Debug Network Adapter', '', '', 'False', ''),
  winNet('Intel(R) PRO/1000 MT Network Connection', 'Ethernet', '7', 'True', 'False'),
  winNet('WAN Miniport (IP)', '', '', 'False', ''),
].join('\n'));

test('win32：実機 verbatim（全 10 アダプタ）から物理だけ拾い online↔offline（仮想は全部捨てる・§7-3）', async () => {
  const src = createNet({ run: ifconfigRun([WIN_NET_DOWN, WIN_NET_REAL, WIN_NET_DOWN]), platform: 'win32', env: ENV });
  assert.equal(await src.poll(), null);                  // prime（物理 disconnected＝オフライン）
  assert.deepEqual(await src.poll(), { situation: 'net.online', ctx: { iface: 'Ethernet' } });
  assert.deepEqual(await src.poll(), { situation: 'net.offline', ctx: undefined });
});

test('win32：powershell 不在/例外なら null（黙る・PE）', async () => {
  const a = createNet({ run: async () => null, platform: 'win32', env: ENV });
  assert.equal(await a.poll(), null);
  const b = createNet({ run: ifconfigRun(['!throw']), platform: 'win32', env: ENV });
  assert.equal(await b.poll(), null);
});
