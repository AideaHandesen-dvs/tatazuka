// disk.js の契約テスト（依存ゼロ・node:test）。run を注入し実 df は叩かない。
//   node --test connectors/disk.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1, §7-1）：
//   - 監視パス（TZ_DISK_PATH）が無ければ createDisk は null（PE：connector オフ）
//   - poll() は空き率の low↔ok のしきい値またぎだけを返す。初回は基準を取るだけで喋らない
//   - 空き率を ctx.freePct・空き GB を ctx.freeGb・パスを ctx.path に乗せる
//   - TZ_DISK_MIN_PCT でしきい値を変えられる
//   - run が null（df 不在/パス不正）／例外なら null（黙る・PE）
//   - `df -kP <path>` を正しく組む

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisk } from './disk.js';

// df -kP の出力を作る（usePct=使用率、availKb=空き 1K ブロック）。-P は fs ごと 1 行。
const df = (usePct, availKb) =>
  `Filesystem 1024-blocks Used Available Capacity Mounted on\n` +
  `/dev/sda1 100000000 ${100000000 - availKb} ${availKb} ${usePct}% /\n`;

// 出力を順に返す run スタブ（末尾に達したら最後を返し続ける）。null/'!throw' で失敗を演じる
function dfRun(outs) {
  let i = 0;
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    const o = outs[Math.min(i++, outs.length - 1)];
    if (o === '!throw') throw new Error('boom');
    return o;
  };
  fn.calls = calls;
  return fn;
}
const ENV = { TZ_DISK_PATH: '/mnt' };
const OK = df(40, 40000000);  // 空き 60%
const LOW = df(92, 8000000);  // 空き 8%（既定しきい値 10% 未満）

test('監視パス未設定なら null（PE：connector オフ）', () => {
  assert.equal(createDisk({ run: dfRun([]), env: {} }), null);
  assert.ok(createDisk({ run: dfRun([]), env: ENV }));
});

test('初回は基準だけ。空き率の low↔ok またぎで disk.low / disk.ok（ctx 付き）', async () => {
  const src = createDisk({ run: dfRun([OK, OK, LOW, LOW, OK]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime（ok）
  assert.equal(await src.poll(), null);                  // ok→ok：無変化
  assert.deepEqual(await src.poll(), { situation: 'disk.low', ctx: { freePct: 8, freeGb: 7.6, path: '/mnt' } });
  assert.equal(await src.poll(), null);                  // low→low：無変化
  assert.deepEqual(await src.poll(), { situation: 'disk.ok', ctx: { freePct: 60, freeGb: 38.1, path: '/mnt' } });
});

test('TZ_DISK_MIN_PCT でしきい値を変えられる（空き 8% でも min 5% なら ok のまま）', async () => {
  const src = createDisk({ run: dfRun([OK, LOW]), env: { TZ_DISK_PATH: '/mnt', TZ_DISK_MIN_PCT: '5' } });
  assert.equal(await src.poll(), null);                  // prime（ok）
  assert.equal(await src.poll(), null);                  // 空き 8% > min 5% ＝まだ ok（またがない）
});

test('読めない（null＝df 不在/パス不正・例外）なら null（黙る・PE）', async () => {
  const a = createDisk({ run: dfRun([null, null]), env: ENV });
  assert.equal(await a.poll(), null);
  const b = createDisk({ run: dfRun(['!throw']), env: ENV });
  assert.equal(await b.poll(), null);
});

test('`df -kP <path>` を組む', async () => {
  const r = dfRun([OK]);
  const src = createDisk({ run: r, env: ENV });
  await src.poll();
  assert.deepEqual(r.calls[0], { cmd: 'df', args: ['-kP', '/mnt'] });
});

// OS 別バックエンド検証（README §7-3・決定 2026-06-09）：disk は OS 固有の読みを持たず `df -kP`
// 一本で回るので、Linux の defaultRun がそのまま macOS でも効く（POSIX -P が列構造を保証）。
// 下は実機 macOS 10.15.7（osx-kvm）から採った df -kP の**実出力そのもの**。これを run に注入して、
// 既存パーサが無改修で Mac 出力を正しく食えることを実データで固定する（縮退でなく実観察に到達）。
const MAC_ROOT = // `df -kP /`（空き 70%・Available 26355868KB ≒ 25.1GB）
  'Filesystem   1024-blocks     Used Available Capacity  Mounted on\n' +
  '/dev/disk3s5    41607128 10817956  26355868    30%    /\n';
const MAC_SPACE_MOUNT = // マウント先に空白を含む行（/Volumes/macOS Base System）。空き 33%・0.6GB
  'Filesystem   1024-blocks     Used Available Capacity  Mounted on\n' +
  '/dev/disk1s1      1965416  1301760    663656    67%    /Volumes/macOS Base System\n';

test('macOS 実出力（df -kP）を無改修で食える＝OS 跨ぎで seam が保つ（§7-3）', async () => {
  // LOW で prime → 実 Mac 出力（70%）で disk.ok。実文字列が freePct 70 / freeGb 25.1 に解ける。
  const src = createDisk({ run: dfRun([LOW, MAC_ROOT]), env: ENV });
  assert.equal(await src.poll(), null); // prime（low）
  assert.deepEqual(await src.poll(), { situation: 'disk.ok', ctx: { freePct: 70, freeGb: 25.1, path: '/mnt' } });
});

test('マウント先に空白がある Mac 行でも壊れない（パーサは % 列までしか見ない・§7-3）', async () => {
  // 空き 33% < min 40 で disk.low。Capacity 列の右（"macOS Base System"）は無視される。
  const src = createDisk({ run: dfRun([OK, MAC_SPACE_MOUNT]), env: { TZ_DISK_PATH: '/mnt', TZ_DISK_MIN_PCT: '40' } });
  assert.equal(await src.poll(), null); // prime（ok・空き 60%）
  assert.deepEqual(await src.poll(), { situation: 'disk.low', ctx: { freePct: 33, freeGb: 0.6, path: '/mnt' } });
});
