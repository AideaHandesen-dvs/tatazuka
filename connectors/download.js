// Download 入力コネクタ（ダウンロード完了＝「お、何か来たぞ」）。connectors の「入力」役・soft 委譲の readonly プローブ。
// これは family 初の **エッジ（出来事）型**——git/disk/…が「状態のしきい値またぎ」だったのに対し、
// こちらは「サンプル値」を持たず、監視フォルダに**新しいファイルが現れた瞬間**を一度だけ拾う。
// 伺かの さくら が一番やりそうな反応で、コンピュータ触る人の大多数（＝何かを落とす人）に効く。
//   download.js … 監視フォルダ（既定 ~/Downloads）を readdir で見て差分（新規出現）を検知
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（download.done。LLM は ctx.n＝新規件数を織り込む）
//
// 設計（イベント源パターンの三点・git / net と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：TZ_DOWNLOAD が未設定・フォルダが無い/読めない → null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：読み口を opts.readNames で差し替え可能（テストで実 FS を読まない）。
//   - 依存ゼロ：node 標準（fs）のみ。読むのは固定の readonly 一点（soft を構造で守る・§7-1）。
//
// プライバシー：**件数だけ**を見てファイル名は situation に乗せない（中身も名前も覗かない＝activity と同方針）。
// 未完テンポラリ（.crdownload/.part/.tmp/.download）は「まだ落ちてる途中」なので無視——
// 最終ファイル名に変わって初めて「新規出現」として一度だけ喋る（DL 中にフライング発火しない）。

import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 落ちきっていないテンポラリ（ブラウザ/各DLマネージャの途中ファイル）。確定するまで数えない。
const TEMP = /\.(crdownload|part|tmp|download)$/i;

// 既定の監視先：$HOME/Downloads。env で差し替え可（TZ_DOWNLOAD_DIR）。
function defaultDir(e) {
  return e.TZ_DOWNLOAD_DIR || join(homedir(), 'Downloads');
}

// 既定の読み口：dir 直下の「確定済み」エントリ名を返す。読めなければ null（PE：黙る）。
function makeDefaultReadNames(dir) {
  return async () => {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return null; // フォルダが無い/読めない → 黙る
    }
    return names.filter((n) => !n.startsWith('.') && !TEMP.test(n)); // 隠し・途中ファイルを除く
  };
}

// env / opts を見て connector を作る。TZ_DOWNLOAD が未設定なら null（＝オフ＝PE）。
// opts.readNames / opts.env はテスト・直接指定用。
export function createDownload(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const dir = opts.dir || defaultDir(e);
  const readNames = opts.readNames || makeDefaultReadNames(dir);

  if (!e.TZ_DOWNLOAD || typeof readNames !== 'function') return null;

  let primed = false;
  let seen = null; // 直前に在ったファイル名の集合（差分検知の状態。接続ごとに独立）

  return {
    async poll() {
      let names;
      try {
        names = await readNames();
      } catch {
        return null; // readNames が投げた → 黙る
      }
      if (names == null) return null; // フォルダ無し/読めない → 黙る（PE）
      const now = new Set(names);
      if (!primed) { primed = true; seen = now; return null; } // 初回は基準だけ（既存ファイルでは喋らない）

      // 新規出現（前回に無く今回在る）。消えた分は seen から落とすだけ（喋らない）。
      let added = 0;
      for (const n of now) if (!seen.has(n)) added++;
      seen = now;
      if (added === 0) return null;
      return { situation: 'download.done', ctx: { n: added } };
    },
  };
}
