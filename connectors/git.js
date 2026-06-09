// Git 入力コネクタ（未コミット状態の clean↔dirty）。connectors の「入力」役、Home Assistant に続く2例目で、
// OpenClaw 連携の soft 委譲の第一実装（README §7-1 / connectors/README.md §7-1）の最初の readonly プローブ。
// イベント源パターン（README §6-4 / connectors/README.md §3-1）：外の出来事 → situation → 人格層。
//   git.js      … 監視リポジトリの `git status --porcelain` を読む（readonly・コマンド注入）＋遷移検知
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（git.dirty / git.clean。LLM は ctx.n＝未コミット数・ctx.repo を織り込む）
//
// 設計（イベント源パターンの三点・activity / HA と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：監視リポ（TZ_GIT_REPO）が無い・git が無い・リポでない → null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：コマンド実行を opts.run で差し替え可能（テストで実 git を叩かない）。
//   - 依存ゼロ：node 標準（child_process）のみ。SDK なし。
//
// soft 委譲を「約束でなく構造で守る」（README §7-1）：読むのは `git status` 固定の readonly 一点で、
// 書込・実行系コマンドを組み立てない。LLM にコマンドを生成・実行させない（プローブはこちらが固定で書く）。
//
// 状態は clean（未コミットなし）/ dirty（未コミットあり）の二値。HA の home/away と同型の遷移検知。
// 「どれだけ溜まってから言うか」のデバウンス／しきい値や、未 push の検知は将来の拡張（この型を増やす）。

import { execFile } from 'node:child_process';
import { basename } from 'node:path';

// 既定のコマンド実行：短いタイムアウトで stdout を返す。失敗（git 不在・リポでない等）は null（PE：黙る）
function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 3000 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch {
      resolve(null);
    }
  });
}

// env / opts を見て connector を作る。監視リポが無ければ null（＝この connector はオフ＝PE）。
// opts.run / opts.repo / opts.env はテスト・直接指定用。
export function createGit(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const run = opts.run || defaultRun;
  const repo = opts.repo || e.TZ_GIT_REPO;

  // PE：監視リポ未設定なら connector オフ
  if (!repo || typeof run !== 'function') return null;
  const repoName = basename(repo.replace(/\/+$/, '')); // ctx 用のリポ名（末尾スラッシュを正規化）

  let primed = false;
  let wasDirty; // 直前の dirty 状態（遷移検知の状態。接続ごとに独立＝各端末が反応）

  // `git -C <repo> status --porcelain`：未コミットの行数を数える。読めなければ null（黙る＝PE）。
  async function read() {
    let out;
    try {
      out = await run('git', ['-C', repo, 'status', '--porcelain']);
    } catch {
      return null; // run が投げた（注入 run 等）→ 黙る
    }
    if (out == null) return null; // git 不在・リポでない（exit≠0）→ 黙る
    const n = out.split('\n').map((s) => s.trim()).filter(Boolean).length; // 変更ファイル数（clean なら 0）
    return { dirty: n > 0, n };
  }

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      if (!primed) { primed = true; wasDirty = st.dirty; return null; } // 初回は基準だけ（遷移と誤検知しない）
      if (st.dirty === wasDirty) return null;                            // 無変化
      wasDirty = st.dirty;
      return { situation: st.dirty ? 'git.dirty' : 'git.clean', ctx: { n: st.n, repo: repoName } };
    },
  };
}
