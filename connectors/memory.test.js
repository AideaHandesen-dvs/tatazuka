// memory.js の契約テスト（依存ゼロ・node:test）。read を注入し実 /proc は読まない。
//   node --test connectors/memory.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1, §7-1）：
//   - TZ_MEM が無ければ createMemory は null（PE：connector オフ）
//   - poll() は空き率の low↔ok のしきい値またぎだけを返す。初回は基準だけ
//   - デバウンス（既定 3 連続）：瞬間的な逼迫スパイクでは喋らない
//   - ctx.availPct（空き率）・ctx.availGb（空き GB）を乗せる
//   - MemTotal/MemAvailable が読めない／例外なら null（黙る・PE）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from './memory.js';

// /proc/meminfo 風テキストを作る（availKb／totalKb は kB）
const meminfo = (availKb, totalKb = 16000000) =>
  `MemTotal:       ${totalKb} kB\nMemFree:         1000000 kB\nMemAvailable:    ${availKb} kB\nBuffers:          200000 kB\n`;
const OK = meminfo(8000000);   // 空き 50%
const LOW = meminfo(800000);   // 空き 5%（既定しきい値 10% 未満）

// テキストを順に返す read スタブ（末尾に達したら最後を返し続ける）。null/'!throw' で失敗を演じる
function memRead(outs) {
  let i = 0;
  return async () => {
    const o = outs[Math.min(i++, outs.length - 1)];
    if (o === '!throw') throw new Error('boom');
    return o;
  };
}
const ENV = { TZ_MEM: '1' };

test('TZ_MEM 未設定なら null（PE：connector オフ）', () => {
  assert.equal(createMemory({ read: memRead([]), env: {} }), null);
  assert.ok(createMemory({ read: memRead([]), env: ENV }));
});

test('デバウンス：3 連続の逼迫で初めて mem.low（ctx 付き）', async () => {
  const src = createMemory({ read: memRead([OK, LOW, LOW, LOW, OK, OK, OK]), env: ENV });
  assert.equal(await src.poll(), null);   // prime（ok）
  assert.equal(await src.poll(), null);   // low 1
  assert.equal(await src.poll(), null);   // low 2
  assert.deepEqual(await src.poll(), { situation: 'mem.low', ctx: { availPct: 5, availGb: 0.8 } }); // low 3 → 確定
  assert.equal(await src.poll(), null);   // ok 1
  assert.equal(await src.poll(), null);   // ok 2
  assert.deepEqual(await src.poll(), { situation: 'mem.ok', ctx: { availPct: 50, availGb: 7.6 } });  // ok 3 → 回復
});

test('単発スパイク（3 連続未満）では喋らない', async () => {
  const src = createMemory({ read: memRead([OK, LOW, LOW, OK]), env: ENV });
  assert.equal(await src.poll(), null);   // prime（ok）
  assert.equal(await src.poll(), null);   // low 1
  assert.equal(await src.poll(), null);   // low 2（まだ確定しない）
  assert.equal(await src.poll(), null);   // ok に戻る＝スパイク扱い（mem.low を出さない）
});

test('読めない（null／MemAvailable 欠落／例外）なら null（黙る・PE）', async () => {
  assert.equal(await createMemory({ read: memRead([null]), env: ENV }).poll(), null);
  const noAvail = createMemory({ read: memRead(['MemTotal: 16000000 kB\n']), env: ENV });
  assert.equal(await noAvail.poll(), null);
  const boom = createMemory({ read: memRead(['!throw']), env: ENV });
  assert.equal(await boom.poll(), null);
});

test('TZ_MEM_MIN_PCT でしきい値を変えられる（空き 5% でも min 3% なら逼迫扱いしない）', async () => {
  const src = createMemory({ read: memRead([OK, LOW, LOW, LOW]), env: { TZ_MEM: '1', TZ_MEM_MIN_PCT: '3' } });
  assert.equal(await src.poll(), null);   // prime（ok）
  assert.equal(await src.poll(), null);   // 5% は min 3% を割ってない＝帯の外でない→維持
  assert.equal(await src.poll(), null);
  assert.equal(await src.poll(), null);   // ずっと ok のまま
});

// ===== OS 別バックエンド：macOS（vm_stat ＋ sysctl hw.memsize）=====（README §7-3・確定③）
// opts.platform='darwin' で readMemMac 経路に入り、opts.run で実コマンドを叩かず出力を注入する。
// VM_REAL は実機 macOS 10.15.7（osx-kvm）の vm_stat verbatim、MEMSIZE は同機の hw.memsize（3GiB）。
// available ≒ free+inactive+speculative+purgeable＝6268+306646+9380+88123=410417 ページ × 4096
//   = 1,681,068,032 バイト / 3,221,225,472 = 52.2%（1.6GiB）。判定（ヒステリシス＋デバウンス）は無改修。
const VM_REAL =
  'Mach Virtual Memory Statistics: (page size of 4096 bytes)\n' +
  'Pages free:                                6268.\n' +
  'Pages active:                            316553.\n' +
  'Pages inactive:                          306646.\n' +
  'Pages speculative:                         9380.\n' +
  'Pages throttled:                              0.\n' +
  'Pages wired down:                        129264.\n' +
  'Pages purgeable:                          88123.\n';
const VM_HIGH = // 空き潤沢（prime ok 用・free だけ大きく）
  'Mach Virtual Memory Statistics: (page size of 4096 bytes)\n' +
  'Pages free:                               700000.\n' +
  'Pages inactive:                                0.\n' +
  'Pages speculative:                             0.\n' +
  'Pages purgeable:                               0.\n';
const MEMSIZE = '3221225472\n';
// run スタブ：vm_stat は列を順に、sysctl は固定で返す。
function macMemRun(vms) {
  let i = 0;
  return async (cmd) => {
    if (cmd === 'sysctl') return MEMSIZE;
    if (cmd === 'vm_stat') return vms[Math.min(i++, vms.length - 1)];
    return null;
  };
}

test('macOS：vm_stat＋hw.memsize（実機 verbatim）を正規化し mem.low（§7-3・判定は無改修で再利用）', async () => {
  // VM_HIGH（~89%・prime ok）→ VM_REAL（52.2%）×3 で min 60 を割って確定。
  const src = createMemory({ run: macMemRun([VM_HIGH, VM_REAL, VM_REAL, VM_REAL]), platform: 'darwin', env: { TZ_MEM: '1', TZ_MEM_MIN_PCT: '60' } });
  assert.equal(await src.poll(), null); // prime（ok）
  assert.equal(await src.poll(), null); // low 1
  assert.equal(await src.poll(), null); // low 2
  assert.deepEqual(await src.poll(), { situation: 'mem.low', ctx: { availPct: 52.2, availGb: 1.6 } }); // low 3 → 確定
});

test('macOS：vm_stat 不在/壊れ → null（黙る・PE）', async () => {
  const a = createMemory({ run: async () => null, platform: 'darwin', env: ENV });
  assert.equal(await a.poll(), null);
  const b = createMemory({ run: async (cmd) => (cmd === 'sysctl' ? MEMSIZE : 'garbage'), platform: 'darwin', env: ENV });
  assert.equal(await b.poll(), null); // Pages free 行が無い → 黙る
});
