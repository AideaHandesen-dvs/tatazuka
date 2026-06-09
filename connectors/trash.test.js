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

// ===== OS 別バックエンド：Windows（$Recycle.Bin の $R* 再帰カウント）=====（README §7-3・確定③）
// linux/darwin は「場所だけの差」で readdir 共通だが、Windows の $Recycle.Bin は SID 別サブ＋$I/$R 構造で
// readdir 一発では数えられない＝**専用の読み口**（PowerShell で $R* を再帰カウント）に分岐する。正規化先は
// 同じ「件数」なので判定は無改修で再利用。opts.platform='win32'＋opts.run で実 powershell を叩かず注入する。
// 実機 tiny10 は空＝Measure-Object .Count が "0"（CRLF）を返す（→ ok 側・喋らない）。
const tcount = (n) => `${n}\r\n`; // Measure-Object .Count 出力（CRLF）
function winTrashRun(seq) {
  let i = 0;
  return async (cmd) => (cmd === 'powershell' ? seq[Math.min(i++, seq.length - 1)] : null);
}

test('win32：$Recycle.Bin の $R* カウントを正規化＝full↔ok（実機 verbatim=0 も解ける・§7-3）', async () => {
  // 実機の "0"（空）→ prime ok。以降は同フォーマットの件数で full↔ok（判定は readdir 経路と同一）。
  const src = createTrash({ run: winTrashRun([tcount(0), tcount(150), tcount(70)]), platform: 'win32', env: ENV });
  assert.equal(await src.poll(), null);                  // prime（実機 0＝空）
  assert.deepEqual(await src.poll(), { situation: 'trash.full', ctx: { n: 150 } });
  assert.deepEqual(await src.poll(), { situation: 'trash.ok', ctx: { n: 70 } });
});

test('win32：$Recycle.Bin を再帰し $R*（実体）を数える PowerShell を組む（§7-3）', async () => {
  const calls = [];
  const run = async (cmd, args) => { calls.push({ cmd, args }); return tcount(0); };
  const src = createTrash({ run, platform: 'win32', env: ENV });
  await src.poll();
  assert.equal(calls[0].cmd, 'powershell');
  assert.match(calls[0].args.at(-1), /\$Recycle\.Bin/);
  assert.match(calls[0].args.at(-1), /\$R\*/); // $I（メタ）でなく $R（実体）を数える
});

test('win32：powershell 不在/数字が無ければ null（黙る・PE）', async () => {
  const a = createTrash({ run: async () => null, platform: 'win32', env: ENV });
  assert.equal(await a.poll(), null);
  const b = createTrash({ run: async () => 'no number\r\n', platform: 'win32', env: ENV });
  assert.equal(await b.poll(), null); // 数字が無い → 黙る
});
