// trash.js の契約テスト（依存ゼロ・node:test）。readCount を注入し実 FS は読まない。
//   node --test connectors/trash.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1, §7-1）：
//   - TZ_TRASH が無ければ createTrash は null（PE：connector オフ）
//   - poll() は件数の full↔ok のしきい値またぎだけを返す。初回は基準を取るだけで喋らない
//   - 件数を ctx.n に乗せる／TZ_TRASH_MAX でしきい値を変えられる
//   - readCount が null（ゴミ箱無し）／例外なら null（黙る・PE）

import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { createTrash, trashDir } from './trash.js';

// readCount スタブ：件数の列を順に返す。null/'!throw' で失敗を演じる。
function countRun(seq) {
  let i = 0;
  return async () => {
    const s = seq[Math.min(i++, seq.length - 1)];
    if (s === '!throw') throw new Error('boom');
    return s;
  };
}
const ENV = { TZ_TRASH: '1' };

test('TZ_TRASH 未設定なら null（PE：connector オフ）', () => {
  assert.equal(createTrash({ readCount: countRun([]), env: {} }), null);
  assert.ok(createTrash({ readCount: countRun([]), env: ENV }));
});

test('初回は基準だけ。件数の full↔ok またぎで trash.full / trash.ok（ctx 付き）', async () => {
  // 10（prime）→ 10 → 150（max 100 超）→ 150 → 70（戻し閾値 80 未満で ok）
  const src = createTrash({ readCount: countRun([10, 10, 150, 150, 70]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime
  assert.equal(await src.poll(), null);                  // 無変化
  assert.deepEqual(await src.poll(), { situation: 'trash.full', ctx: { n: 150 } });
  assert.equal(await src.poll(), null);                  // full→full：無変化
  assert.deepEqual(await src.poll(), { situation: 'trash.ok', ctx: { n: 70 } });
});

test('TZ_TRASH_MAX でしきい値を変えられる（120 件でも max 200 なら ok のまま）', async () => {
  const src = createTrash({ readCount: countRun([10, 120]), env: { TZ_TRASH: '1', TZ_TRASH_MAX: '200' } });
  assert.equal(await src.poll(), null);                  // prime
  assert.equal(await src.poll(), null);                  // 120 < 200 ＝またがない
});

test('読めない（null＝ゴミ箱無し・例外）なら null（黙る・PE）', async () => {
  const a = createTrash({ readCount: countRun([null, null]), env: ENV });
  assert.equal(await a.poll(), null);
  const b = createTrash({ readCount: countRun(['!throw']), env: ENV });
  assert.equal(await b.poll(), null);
});

// ===== OS 別バックエンド：macOS（ゴミ箱の場所）=====（README §7-3・確定③）
// OS 差はディレクトリだけ＝readdir で件数を数える作りは不変。trashDir を platform で直接確かめる。
test('trashDir：OS でゴミ箱の場所を選ぶ（darwin=~/.Trash／linux=freedesktop／TZ_TRASH_DIR 上書き）', () => {
  assert.equal(trashDir({}, 'darwin'), `${homedir()}/.Trash`);
  assert.equal(trashDir({}, 'linux'), `${homedir()}/.local/share/Trash/files`);
  assert.equal(trashDir({ TZ_TRASH_DIR: '/tmp/t' }, 'darwin'), '/tmp/t'); // 明示が最優先（OS 不問）
});

test('件数の判定は OS 非依存（darwin でも full↔ok は同じ・readCount 注入）', async () => {
  // ゴミ箱の場所が変わるだけで、件数しきい値の挙動は Linux と同一。
  const src = createTrash({ readCount: countRun([10, 150, 70]), platform: 'darwin', env: ENV });
  assert.equal(await src.poll(), null);                  // prime
  assert.deepEqual(await src.poll(), { situation: 'trash.full', ctx: { n: 150 } });
  assert.deepEqual(await src.poll(), { situation: 'trash.ok', ctx: { n: 70 } });
});
