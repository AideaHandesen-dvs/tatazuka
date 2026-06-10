// motion.js の契約テスト（依存ゼロ・node:test）。fetch と now を注入し実 HA・実時計を使わない。
//   node --test connectors/motion.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1）：
//   - URL/トークン/対象 entity が欠ければ createMotion は null（PE：connector オフ）
//   - 初回は基準だけ。空→動き検知で motion.present（ctx.what）。占有中の on/off チャタは黙る
//   - 動きが空き時間（既定 600s）止まったら motion.empty（ctx.quietMin）。再び動けば present
//   - state が文字列でない／fetch 失敗 → null（黙る・PE）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotion } from './motion.js';

// state（'on'/'off'）を順に返す fetch スタブ。'!ok'/'!throw' で失敗を演じる。
function hassFetch(states) {
  let i = 0;
  const fn = async () => {
    const s = states[Math.min(i++, states.length - 1)];
    if (s === '!throw') throw new Error('down');
    if (s === '!ok') return { ok: false, async json() { return {}; } };
    return { ok: true, async json() { return { entity_id: 'binary_sensor.m', state: s, attributes: { friendly_name: 'リビング' } }; } };
  };
  return fn;
}
// now スタブ：ミリ秒の列を順に返す（poll のたびに次の時刻）。
function clock(seq) {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)];
}
const MIN = 60000;
const ENV = { TZ_HASS_URL: 'http://ha.local:8123/', TZ_HASS_TOKEN: 'tok', TZ_HASS_MOTION: 'binary_sensor.living_motion' };

test('URL/トークン/対象が欠ければ null（PE：connector オフ）', () => {
  assert.equal(createMotion({ fetch: hassFetch([]), now: clock([0]), env: {} }), null);
  assert.ok(createMotion({ fetch: hassFetch([]), now: clock([0]), env: ENV }));
});

test('初回は基準だけ。空→動きで present（ctx.what）。占有中のチャタは黙る', async () => {
  // off(基準=empty) → on(来た) → off,on(占有中のチャタ・まだ空き時間内)
  const src = createMotion({
    fetch: hassFetch(['off', 'on', 'off', 'on']),
    now: clock([0, 1 * MIN, 2 * MIN, 3 * MIN]),
    env: ENV,
  });
  assert.equal(await src.poll(), null);  // prime（empty）
  assert.deepEqual(await src.poll(), { situation: 'motion.present', ctx: { what: 'リビング' } }); // 来た
  assert.equal(await src.poll(), null);  // off だが直前(1分前)に動き＝空き時間(10分)内 → 黙る
  assert.equal(await src.poll(), null);  // また on＝占有継続 → 黙る
});

test('空き時間（600s）動きが止まれば motion.empty（ctx.quietMin）。再び動けば present', async () => {
  // off(基準empty) → on@1分(present) → off@13分（最後の動き=1分前から12分経過>10分 → empty） → on@14分(present)
  const src = createMotion({
    fetch: hassFetch(['off', 'on', 'off', 'on']),
    now: clock([0, 1 * MIN, 13 * MIN, 14 * MIN]),
    env: ENV,
  });
  assert.equal(await src.poll(), null);                                              // prime
  assert.deepEqual(await src.poll(), { situation: 'motion.present', ctx: { what: 'リビング' } });
  assert.deepEqual(await src.poll(), { situation: 'motion.empty', ctx: { quietMin: 12 } }); // 12分静か
  assert.deepEqual(await src.poll(), { situation: 'motion.present', ctx: { what: 'リビング' } }); // 戻ってきた
});

test('空き時間ちょうど未満は黙る（境界）', async () => {
  // on(基準present・lastSeen=0) → off@9分（9分<10分 → まだ present） → off@11分（11分>=10分 → empty）
  const src = createMotion({
    fetch: hassFetch(['on', 'off', 'off']),
    now: clock([0, 9 * MIN, 11 * MIN]),
    env: ENV,
  });
  assert.equal(await src.poll(), null);  // prime（present・lastSeen=0）
  assert.equal(await src.poll(), null);  // 9分静か < 10分 → 黙る
  assert.deepEqual(await src.poll(), { situation: 'motion.empty', ctx: { quietMin: 11 } }); // 11分 → 空いた
});

test('fetch が !ok／例外／state 欠落なら null（黙る・PE）', async () => {
  const bad = createMotion({ fetch: hassFetch(['!ok', '!ok']), now: clock([0, 0]), env: ENV });
  assert.equal(await bad.poll(), null);
  const boom = createMotion({ fetch: hassFetch(['!throw']), now: clock([0]), env: ENV });
  assert.equal(await boom.poll(), null);
});
