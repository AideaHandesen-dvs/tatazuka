// git.js の契約テスト（依存ゼロ・node:test）。run を注入し実 git は叩かない。
//   node --test connectors/git.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1, §7-1）：
//   - 監視リポ（TZ_GIT_REPO）が無ければ createGit は null（PE：connector オフ）
//   - poll() は clean↔dirty（未コミット）と unpushed↔pushed（未 push）の遷移だけを返す。初回は基準だけ
//   - 未コミット数を ctx.n に、未 push 数を ctx.ahead に、リポ名を ctx.repo に乗せる
//   - コミット（dirty→clean ＋ ahead 0→N が同時）は clean を先に・unpushed を次の poll に繰り越す
//   - run が null（git 不在/リポでない）／例外なら null（黙る・PE）
//   - `git -C <repo> status --porcelain=v2 --branch` を正しく組む

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGit } from './git.js';

// porcelain=v2 --branch の出力を組む（ab='+A -B'＝ahead/behind、files＝変更エントリ行の配列）
const out = (ab, files = []) =>
  `# branch.oid abc123\n# branch.head main\n# branch.upstream origin/main\n# branch.ab ${ab}\n` +
  files.map((f) => `${f}\n`).join('');
const CLEAN = out('+0 -0');                                          // 未コミットなし・同期済み
const DIRTY = out('+0 -0', ['1 .M N... 100644 100644 100644 a a a.js', '? b.js']); // 未コミット 2 件
const AHEAD = out('+2 -0');                                          // clean だが未 push 2 件
const CLEAN_AHEAD = out('+2 -0');                                    // コミット直後（clean ＋ 未 push 2）

// 出力を順に返す run スタブ（末尾に達したら最後を返し続ける）。null/'!throw' で失敗を演じる
function gitRun(outs) {
  let i = 0;
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    const o = outs[Math.min(i++, outs.length - 1)];
    if (o === '!throw') throw new Error('boom');
    return o; // 文字列 or null（git 不在・リポでない）
  };
  fn.calls = calls;
  return fn;
}
const ENV = { TZ_GIT_REPO: '/repo/foo' };

test('監視リポ未設定なら null（PE：connector オフ）', () => {
  assert.equal(createGit({ run: gitRun([]), env: {} }), null);
  assert.ok(createGit({ run: gitRun([]), env: ENV })); // TZ_GIT_REPO があれば有効
});

test('初回は基準だけ。clean↔dirty の遷移で git.dirty / git.clean（ctx.n・ctx.repo 付き）', async () => {
  const src = createGit({ run: gitRun([CLEAN, CLEAN, DIRTY, DIRTY, CLEAN]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime（clean）
  assert.equal(await src.poll(), null);                  // clean→clean：無変化
  assert.deepEqual(await src.poll(), { situation: 'git.dirty', ctx: { n: 2, repo: 'foo' } }); // 変更が出た
  assert.equal(await src.poll(), null);                  // dirty→dirty：無変化
  assert.deepEqual(await src.poll(), { situation: 'git.clean', ctx: { n: 0, repo: 'foo' } }); // 片付いた
});

test('未 push の遷移で git.unpushed / git.pushed（ctx.ahead・ctx.repo 付き）', async () => {
  const src = createGit({ run: gitRun([CLEAN, AHEAD, AHEAD, CLEAN]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime（同期済み）
  assert.deepEqual(await src.poll(), { situation: 'git.unpushed', ctx: { ahead: 2, repo: 'foo' } }); // 未 push が出た
  assert.equal(await src.poll(), null);                  // 無変化
  assert.deepEqual(await src.poll(), { situation: 'git.pushed', ctx: { ahead: 0, repo: 'foo' } });   // push した
});

test('コミットは clean を先に・unpushed を次の poll に繰り越す（1 poll に 1 遷移）', async () => {
  // prime=dirty/ahead0 → コミットで clean かつ ahead2 が同時。clean を先、unpushed は次へ。
  const src = createGit({ run: gitRun([DIRTY, CLEAN_AHEAD, CLEAN_AHEAD]), env: ENV });
  assert.equal(await src.poll(), null);                                 // prime（dirty・同期）
  assert.deepEqual(await src.poll(), { situation: 'git.clean', ctx: { n: 0, repo: 'foo' } });        // まず片付き
  assert.deepEqual(await src.poll(), { situation: 'git.unpushed', ctx: { ahead: 2, repo: 'foo' } }); // 次に未 push
});

test('読めない（null＝git 不在/リポでない・例外）なら null（黙る・PE）', async () => {
  const a = createGit({ run: gitRun([null, null]), env: ENV });
  assert.equal(await a.poll(), null);
  const b = createGit({ run: gitRun(['!throw']), env: ENV });
  assert.equal(await b.poll(), null);
});

test('`git -C <repo> status --porcelain=v2 --branch` を組む', async () => {
  const r = gitRun([CLEAN]);
  const src = createGit({ run: r, env: { TZ_GIT_REPO: '/repo/foo/' } });
  await src.poll();
  assert.deepEqual(r.calls[0], { cmd: 'git', args: ['-C', '/repo/foo/', 'status', '--porcelain=v2', '--branch'] });
});
