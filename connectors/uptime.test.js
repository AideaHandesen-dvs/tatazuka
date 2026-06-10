// uptime.js の契約テスト（依存ゼロ・node:test）。uptime（秒を返す関数）を注入し実時計を進めない。
//   node --test connectors/uptime.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1）：
//   - TZ_UPTIME が無ければ createUptime は null（PE：connector オフ）
//   - 初回 poll は基準だけ（起動直後に説教しない）
//   - 閾値（既定 168h）を**跨いだ瞬間に一度だけ** uptime.long（ctx.days / ctx.hours）。以後は黙る
//   - 既に長稼働のマシンで起動したら基準が warn＝**再起動直後に nag しない**（単方向ナッジ）
//   - exit（回復）は捨てる＝同一プロセス内で uptime は単調増加・再起動＝佇か自身も再起動
//   - TZ_UPTIME_MAX_H で閾値を変えられる

import test from 'node:test';
import assert from 'node:assert/strict';
import { createUptime } from './uptime.js';

const H = 3600; // 秒/時
// uptime スタブ：秒の列を順に返す（poll のたびに次の値）。
function ups(seq) {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)];
}
const ENV = { TZ_UPTIME: '1' };

test('TZ_UPTIME 未設定なら null（PE：connector オフ）', () => {
  assert.equal(createUptime({ uptime: ups([0]), env: {} }), null);
  assert.ok(createUptime({ uptime: ups([0]), env: ENV }));
});

test('初回は基準だけ。閾値を跨いだ瞬間に一度だけ uptime.long（ctx）。以後は黙る', async () => {
  // 1h（prime・短い）→ 100h（帯内 or まだ ok 側）→ 169h（閾値超え）→ 200h（さらに伸びた）
  const src = createUptime({ uptime: ups([1 * H, 100 * H, 169 * H, 200 * H]), env: ENV });
  assert.equal(await src.poll(), null);  // prime（基準 ok）
  assert.equal(await src.poll(), null);  // 100h ＝戻し閾値(156h)未満で ok 維持
  assert.deepEqual(await src.poll(), { situation: 'uptime.long', ctx: { days: 7, hours: 169 } });
  assert.equal(await src.poll(), null);  // 200h ＝既に warn なので黙る（再 nag しない）
});

test('既に長稼働で起動したら基準が warn＝再起動直後に説教しない（単方向ナッジ）', async () => {
  // 佇かが「もう 300h 稼働中」のマシンで起動し直した想定：初回で warn を基準に取り、その後も黙る。
  const src = createUptime({ uptime: ups([300 * H, 310 * H]), env: ENV });
  assert.equal(await src.poll(), null);  // prime（基準 warn・でも初回は出さない）
  assert.equal(await src.poll(), null);  // 伸びても warn 維持＝黙る
});

test('exit（回復）は捨てる：uptime が縮んでも uptime.ok は出さない', async () => {
  // 169h で warn → 1h に縮む（再起動相当・ふつうはプロセスごと作り直されるが、念のため捨てを確認）
  const src = createUptime({ uptime: ups([1 * H, 169 * H, 1 * H]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime（ok）
  assert.deepEqual(await src.poll(), { situation: 'uptime.long', ctx: { days: 7, hours: 169 } });
  assert.equal(await src.poll(), null);                  // 縮んだ → exit を捨てて黙る
});

test('TZ_UPTIME_MAX_H で閾値を変えられる（12h 設定なら 13h で喋る）', async () => {
  const src = createUptime({ uptime: ups([1 * H, 13 * H]), env: { TZ_UPTIME: '1', TZ_UPTIME_MAX_H: '12' } });
  assert.equal(await src.poll(), null);  // prime
  assert.deepEqual(await src.poll(), { situation: 'uptime.long', ctx: { days: 0, hours: 13 } });
});
