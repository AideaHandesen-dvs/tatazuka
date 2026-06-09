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
