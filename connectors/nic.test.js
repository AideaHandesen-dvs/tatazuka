// nic.js の契約テスト（依存ゼロ・node:test）。read（/proc/net/dev）と now を注入し、実 /proc・実時計を使わない。
//   node --test connectors/nic.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1, §7-1）：
//   - TZ_NIC が無ければ createNic は null（PE：connector オフ）
//   - 初回は基準（バイト累計）だけ。2 点目から差分÷経過時間でレート（MB/s）
//   - レートが busy を超える状態が続く（debounce=2）と nic.busy、1/4 を割ると nic.idle。lo は除外
//   - ctx.mbps にレート。read が null／例外、カウンタ巻き戻り（db<0）なら null（黙る・PE）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createNic } from './nic.js';

// /proc/net/dev 風テキスト（eth0 の rx=bytes・tx=0、lo は除外対象）
const dev = (bytes) =>
  `Inter-|   Receive                    |  Transmit\n` +
  ` face |bytes packets ...             |bytes packets ...\n` +
  `    lo: 500 1 0 0 0 0 0 0 500 1 0 0 0 0 0 0\n` +
  `  eth0: ${bytes} 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0\n`;

// 値を順に返すスタブ（末尾に達したら最後を返し続ける）
function seq(vals, onThrow) {
  let i = 0;
  return () => {
    const v = vals[Math.min(i++, vals.length - 1)];
    if (v === '!throw') return onThrow();
    return v;
  };
}
const reader = (outs) => { const f = seq(outs, () => { throw new Error('boom'); }); return async () => f(); };
const clock = (ts) => seq(ts);
const ENV = { TZ_NIC: '1' };

test('TZ_NIC 未設定なら null（PE：connector オフ）', () => {
  assert.equal(createNic({ read: reader([]), now: clock([0]), env: {} }), null);
  assert.ok(createNic({ read: reader([]), now: clock([0]), env: ENV }));
});

test('差分÷経過時間でレート。busy が続く（debounce=2）と nic.busy、落ち着くと nic.idle', async () => {
  const bytes = [0, 100000, 3100000, 6100000, 6100000, 6100000]; // 0.1 → 3 → 3 → 0 → 0 MB/s
  const times = [0, 1000, 2000, 3000, 4000, 5000];               // 1 秒間隔
  const src = createNic({ read: reader(bytes.map(dev)), now: clock(times), env: ENV });
  assert.equal(await src.poll(), null);   // prime（バイト基準）
  assert.equal(await src.poll(), null);   // 0.1 MB/s → th 基準（ok）
  assert.equal(await src.poll(), null);   // 3 MB/s（busy 1 回目・未確定）
  assert.deepEqual(await src.poll(), { situation: 'nic.busy', ctx: { mbps: 3 } }); // busy 2 回目 → 確定
  assert.equal(await src.poll(), null);   // 0 MB/s（idle 1 回目・未確定）
  assert.deepEqual(await src.poll(), { situation: 'nic.idle', ctx: { mbps: 0 } });  // idle 2 回目 → 確定
});

test('read が null／例外なら null（黙る・PE）', async () => {
  assert.equal(await createNic({ read: reader([null]), now: clock([0]), env: ENV }).poll(), null);
  const boom = createNic({ read: reader(['!throw']), now: clock([0]), env: ENV });
  assert.equal(await boom.poll(), null);
});

test('カウンタ巻き戻り（db<0）は無視して null（再起動・if 入れ替え対策）', async () => {
  const src = createNic({ read: reader([dev(1000000000), dev(100)]), now: clock([0, 1000]), env: ENV });
  assert.equal(await src.poll(), null);   // prime（大きい値）
  assert.equal(await src.poll(), null);   // 小さい値＝db<0 → 黙る（クラッシュしない）
});

// ===== OS 別バックエンド：macOS（netstat -ibn）=====（README §7-3・確定③）
// opts.platform='darwin' で readBytesMac 経路に入り、opts.run で実 netstat を叩かず出力を注入する。
// <Link# 行だけ採って二重計上を避ける／末尾 7 列から Ibytes(2)+Obytes(5) を合算／lo* 除外。
// nsMac は en0（MAC 付き Link 行）＋ lo0 で実機の列レイアウトを再現（Ibytes=bytes・Obytes=0）。
const nsMac = (bytes) =>
  'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll\n' +
  'lo0   16384 <Link#1>                          5815     0    1308457     5815     0    1308457     0\n' +
  `en0   1500  <Link#4>    52:54:00:c9:18:27      100     0    ${bytes}      100     0          0     0\n`;
function macNetRun(byteSeq) {
  let i = 0;
  return async () => nsMac(byteSeq[Math.min(i++, byteSeq.length - 1)]);
}

test('macOS：netstat -ibn の Ibytes+Obytes でレート。busy↔idle（§7-3・判定は無改修で再利用）', async () => {
  const bytes = [0, 100000, 3100000, 6100000, 6100000, 6100000]; // 0.1 → 3 → 3 → 0 → 0 MB/s
  const times = [0, 1000, 2000, 3000, 4000, 5000];
  const src = createNic({ run: macNetRun(bytes), platform: 'darwin', now: clock(times), env: ENV });
  assert.equal(await src.poll(), null);   // prime
  assert.equal(await src.poll(), null);   // 0.1 MB/s（ok）
  assert.equal(await src.poll(), null);   // 3 MB/s（busy 1・未確定）
  assert.deepEqual(await src.poll(), { situation: 'nic.busy', ctx: { mbps: 3 } }); // busy 2 → 確定
  assert.equal(await src.poll(), null);   // 0 MB/s（idle 1・未確定）
  assert.deepEqual(await src.poll(), { situation: 'nic.idle', ctx: { mbps: 0 } });  // idle 2 → 確定
});

test('macOS：実機 netstat verbatim（複数 if）を二重計上せず parse できる（§7-3）', async () => {
  // gif/stf/utun を含む実機出力。<Link# 行だけ＝en0 と utun のみ計上、lo0 は除外。同値2回で rate 0 → 黙る。
  const REAL =
    'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll\n' +
    'lo0   16384 <Link#1>                          5815     0    1308457     5815     0    1308457     0\n' +
    'gif0* 1280  <Link#2>                             0     0          0        0     0          0     0\n' +
    'stf0* 1280  <Link#3>                             0     0          0        0     0          0     0\n' +
    'en0   1500  <Link#4>    52:54:00:c9:18:27   225769     0  157931262   159002     0   15884272     0\n' +
    'utun0 1380  <Link#5>                             0     0          0        2     0        200     0\n' +
    'utun1 2000  <Link#6>                             0     0          0        2     0        200     0\n';
  const src = createNic({ run: async () => REAL, platform: 'darwin', now: clock([0, 1000]), env: ENV });
  assert.equal(await src.poll(), null);   // prime（バイト基準を採れた＝parse 成功）
  assert.equal(await src.poll(), null);   // 同値＝rate 0 → 黙る（クラッシュしない）
});

test('macOS：netstat 不在/例外なら null（黙る・PE）', async () => {
  const a = createNic({ run: async () => null, platform: 'darwin', now: clock([0, 1000]), env: ENV });
  assert.equal(await a.poll(), null);
  const b = createNic({ run: async () => { throw new Error('boom'); }, platform: 'darwin', now: clock([0, 1000]), env: ENV });
  assert.equal(await b.poll(), null);
});
