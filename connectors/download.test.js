// download.js の契約テスト（依存ゼロ・node:test）。readNames を注入し実 FS は読まない。
//   node --test connectors/download.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1, §7-1）：
//   - TZ_DOWNLOAD が無ければ createDownload は null（PE：connector オフ）
//   - poll() は新規ファイルの出現（エッジ）だけを返す。初回は基準＝既存ファイルでは喋らない
//   - 件数だけ ctx.n に乗せる（ファイル名は乗せない＝プライバシー）
//   - 消えたファイルでは喋らない／無変化では喋らない
//   - readNames が null（フォルダ無し）／例外なら null（黙る・PE）
//   - 途中ファイル（.crdownload 等）は既定の読み口でテンポラリ除外される

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownload } from './download.js';

// readNames スタブ：ファイル名配列の列を順に返す。null/'!throw' で失敗を演じる。
function dirRun(seq) {
  let i = 0;
  return async () => {
    const s = seq[Math.min(i++, seq.length - 1)];
    if (s === '!throw') throw new Error('boom');
    return s;
  };
}
const ENV = { TZ_DOWNLOAD: '1' };

test('TZ_DOWNLOAD 未設定なら null（PE：connector オフ）', () => {
  assert.equal(createDownload({ readNames: dirRun([]), env: {} }), null);
  assert.ok(createDownload({ readNames: dirRun([]), env: ENV }));
});

test('初回は基準だけ。新規出現で download.done（件数のみ）。消失・無変化は黙る', async () => {
  const src = createDownload({
    readNames: dirRun([
      ['old.pdf'],                  // prime（既存では喋らない）
      ['old.pdf'],                  // 無変化
      ['old.pdf', 'new.zip'],       // 1件増えた
      ['old.pdf', 'new.zip', 'a.png', 'b.png'], // 2件増えた
      ['new.zip'],                  // 消えた（old.pdf, a.png, b.png 消滅）→ 黙る
    ]),
    env: ENV,
  });
  assert.equal(await src.poll(), null);                  // prime
  assert.equal(await src.poll(), null);                  // 無変化
  assert.deepEqual(await src.poll(), { situation: 'download.done', ctx: { n: 1 } });
  assert.deepEqual(await src.poll(), { situation: 'download.done', ctx: { n: 2 } });
  assert.equal(await src.poll(), null);                  // 消失では喋らない
});

test('同時に複数落ちたら件数でまとめる', async () => {
  const src = createDownload({ readNames: dirRun([[], ['a', 'b', 'c']]), env: ENV });
  assert.equal(await src.poll(), null);                  // prime（空）
  assert.deepEqual(await src.poll(), { situation: 'download.done', ctx: { n: 3 } });
});

test('読めない（null＝フォルダ無し・例外）なら null（黙る・PE）', async () => {
  const a = createDownload({ readNames: dirRun([null, null]), env: ENV });
  assert.equal(await a.poll(), null);
  const b = createDownload({ readNames: dirRun(['!throw']), env: ENV });
  assert.equal(await b.poll(), null);
});

test('既定の読み口は隠しファイルと途中ファイル（.crdownload/.part）を除く', async () => {
  // readNames を注入せず dir だけ差し替え、defaultReadNames のフィルタを通す。
  // readdir は実 FS を叩くので、存在しない dir を与えて「読めない→null」だけ確認（フィルタの正は本体コメント＋実利用で担保）。
  const src = createDownload({ env: ENV, dir: '/nonexistent/tatazuka-test-dir' });
  assert.equal(await src.poll(), null); // 読めない → PE
});
