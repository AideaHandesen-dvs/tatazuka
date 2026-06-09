// Trash 入力コネクタ（ゴミ箱が溜まった full↔ok）。connectors の「入力」役・soft 委譲の readonly プローブ。
// 「そろそろ空にしたら?」——掃除を促す同居人ムーブ。普遍的な家事ナッジで、コンピュータ触る人なら誰でも分かる。
// 型は「大きいほど警戒」の件数しきい値（nic と同じ below=false）。ゴミ箱はゆっくり溜まるのでデバウンスは 1。
//   trash.js    … freedesktop ゴミ箱（既定 ~/.local/share/Trash/files）の件数を見る（readonly・readdir）
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（trash.full / trash.ok。LLM は ctx.n＝件数を織り込む）
//
// 設計（イベント源パターンの三点・disk / nic と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：TZ_TRASH が未設定・ゴミ箱が無い/読めない → null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：読み口を opts.readCount で差し替え可能（テストで実 FS を読まない）。
//   - 依存ゼロ：node 標準（fs）のみ。読むのは固定の readonly 一点（soft を構造で守る・§7-1）。
//
// プライバシー：**件数だけ**を見て中身もファイル名も覗かない（download と同方針）。サイズでなく件数なのは
// readdir 一発で済んで依存ゼロ・軽いから（巨大1ファイルより「散らかり具合」の体感に近い）。
// TZ_TRASH_MAX（既定 100 件）を超え続けると trash.full、戻し閾値（-20 件）を下回ると trash.ok。
//
// OS 別バックエンド（README §7-3・確定③）：linux/darwin は「場所だけの差」で readdir 共通だが、Windows の
// $Recycle.Bin は SID 別サブフォルダ＋$I/$R メタデータ構造で readdir 一発では数えられない＝**専用の読み口**
// （PowerShell で $R* を再帰カウント）に分岐する。正規化先は同じ「件数（number）」なので判定は無改修で再利用。
//   - linux : freedesktop の $HOME/.local/share/Trash/files（readdir）
//   - darwin: $HOME/.Trash（readdir・場所だけ差）
//   - win32 : C:\$Recycle.Bin 配下の $R*（実体）を再帰カウント（readCountWin）。$I はメタなので数えない
//   - その他: linux 既定（readdir。ゴミ箱が無ければ null 縮退＝PE）

import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run as defaultRun } from './run.js';
import { makeThreshold } from './hysteresis.js';

const MAX = 100;     // この件数を超えたら「溜まってる」とみなす
const MARGIN = 20;   // 戻し閾値の余裕（ヒステリシス幅・件数なので広め）

// 既定の監視先：OS でゴミ箱の場所が違うので process.platform で選ぶ。TZ_TRASH_DIR で上書き可。
// （純関数＝テストで platform を強制して経路を直接確かめられるよう export する）
export function trashDir(e, plat) {
  if (e.TZ_TRASH_DIR) return e.TZ_TRASH_DIR;
  if ((plat || process.platform) === 'darwin') return join(homedir(), '.Trash');
  return join(homedir(), '.local', 'share', 'Trash', 'files'); // freedesktop（linux 既定）
}

// Windows の読み口：C:\$Recycle.Bin 配下の $R*（ゴミの実体）を再帰カウントする。$I はメタデータなので
// 数えない＝1 アイテム 1 カウント。SID 別サブフォルダを跨ぐので -Recurse、隠し/システムを見るので -Force、
// 他 SID への不可視はエラーを握り潰す（-ErrorAction SilentlyContinue）。出力は件数のみ。読めなければ null。
async function readCountWin(run) {
  let out;
  try {
    out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-ChildItem -Path 'C:\\$Recycle.Bin' -Recurse -Force -Filter '$R*' -ErrorAction SilentlyContinue | Measure-Object).Count"]);
  } catch {
    return null; // run が投げた → 黙る
  }
  if (out == null) return null;
  const m = String(out).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// 既定の読み口を OS で選ぶ：win32 は専用カウント、それ以外は readdir でゴミ箱直下のエントリ数。
// 読めなければ null（PE：黙る）。opts.dir / opts.run はテスト・直接指定用。
function makeDefaultReadCount(opts, e) {
  const plat = opts.platform || process.platform;
  if (plat === 'win32') {
    const run = opts.run || defaultRun;
    return () => readCountWin(run);
  }
  const dir = opts.dir || trashDir(e, opts.platform);
  return async () => {
    try {
      return (await readdir(dir)).length;
    } catch {
      return null; // ゴミ箱が無い/読めない → 黙る
    }
  };
}

// env / opts を見て connector を作る。TZ_TRASH が未設定なら null（＝オフ＝PE）。
// opts.readCount / opts.dir / opts.run / opts.platform / opts.max / opts.env はテスト・直接指定用。
export function createTrash(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const readCount = opts.readCount || makeDefaultReadCount(opts, e);

  if (!e.TZ_TRASH || typeof readCount !== 'function') return null;
  const max = Number(opts.max ?? e.TZ_TRASH_MAX ?? MAX);

  // 大きいほど警戒（below=false）：n>max で warn、n<max-MARGIN で ok。ゆっくり溜まるのでデバウンス 1。
  const th = makeThreshold({ low: max - MARGIN, high: max, below: false, debounce: 1 });

  async function read() {
    let n;
    try {
      n = await readCount();
    } catch {
      return null; // readCount が投げた → 黙る
    }
    if (n == null || !Number.isFinite(n)) return null;
    return { n };
  }

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      const ev = th.feed(st.n); // 'enter'（溜まった）/ 'exit'（片付いた）/ null
      if (!ev) return null;
      return { situation: ev === 'enter' ? 'trash.full' : 'trash.ok', ctx: { n: st.n } };
    },
  };
}
