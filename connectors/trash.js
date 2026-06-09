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
// OS 別バックエンド（README §7-3・確定③）：OS 差はゴミ箱の場所だけ＝readdir で件数を数える作りは不変。
//   - linux : freedesktop の $HOME/.local/share/Trash/files
//   - darwin: $HOME/.Trash
//   - その他（Win 等）: linux 既定（$Recycle.Bin はメタデータ構造が違うので将来の分岐・今は縮退）

import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

// 既定の読み口：ゴミ箱直下のエントリ数を返す。読めなければ null（PE：黙る）。
function makeDefaultReadCount(dir) {
  return async () => {
    try {
      return (await readdir(dir)).length;
    } catch {
      return null; // ゴミ箱が無い/読めない → 黙る
    }
  };
}

// env / opts を見て connector を作る。TZ_TRASH が未設定なら null（＝オフ＝PE）。
// opts.readCount / opts.dir / opts.platform / opts.max / opts.env はテスト・直接指定用。
export function createTrash(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const dir = opts.dir || trashDir(e, opts.platform);
  const readCount = opts.readCount || makeDefaultReadCount(dir);

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
