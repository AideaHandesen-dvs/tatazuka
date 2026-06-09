// resume.js の契約テスト（依存ゼロ・node:test）。now を注入し実時計・実スリープを使わない。
//   node --test connectors/resume.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1）：
//   - TZ_RESUME が無ければ createResume は null（PE：connector オフ）
//   - 初回 poll は基準だけ（起動直後に「おかえり」は言わない）
//   - 通常の tick 間隔では黙る／閾値を超える空白で resume.back（空白の長さ分を ctx.gapMin）
//   - TZ_RESUME_GAP_S で閾値を変えられる

import test from 'node:test';
import assert from 'node:assert/strict';
import { createResume } from './resume.js';

// now スタブ：ミリ秒の列を順に返す（poll のたびに次の時刻）。
function clock(seq) {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)];
}
const ENV = { TZ_RESUME: '1' };
const S = 1000, MIN = 60000;

test('TZ_RESUME 未設定なら null（PE：connector オフ）', () => {
  assert.equal(createResume({ now: clock([0]), env: {} }), null);
  assert.ok(createResume({ now: clock([0]), env: ENV }));
});

test('初回は基準だけ。通常 tick は黙る。閾値超えの空白で resume.back（ctx.gapMin）', async () => {
  // t=0（prime）→ +30s（通常 tick）→ +2時間（寝てた）→ +30s（通常）
  const src = createResume({ now: clock([0, 30 * S, 30 * S + 120 * MIN, 30 * S + 120 * MIN + 30 * S]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime
  assert.equal(await src.poll(), null);                  // 30s ＝通常 tick
  assert.deepEqual(await src.poll(), { situation: 'resume.back', ctx: { gapMin: 120 } });
  assert.equal(await src.poll(), null);                  // 復帰後の通常 tick
});

test('閾値ちょうど近傍：180s 以下は黙る、超えたら喋る', async () => {
  const src = createResume({ now: clock([0, 180 * S, 180 * S + 181 * S]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime
  assert.equal(await src.poll(), null);                  // ちょうど 180s（<=gap なので黙る）
  assert.deepEqual(await src.poll(), { situation: 'resume.back', ctx: { gapMin: 3 } }); // 181s → 約3分
});

test('TZ_RESUME_GAP_S で閾値を変えられる（60s 空白でも gap 90s なら黙る）', async () => {
  const src = createResume({ now: clock([0, 60 * S]), env: { TZ_RESUME: '1', TZ_RESUME_GAP_S: '90' } });
  assert.equal(await src.poll(), null);                  // prime
  assert.equal(await src.poll(), null);                  // 60s < 90s ＝黙る
});
