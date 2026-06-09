// Git 入力コネクタ（未コミット状態の clean↔dirty）。connectors の「入力」役、Home Assistant に続く2例目で、
// OpenClaw 連携の soft 委譲の第一実装（README §7-1 / connectors/README.md §7-1）の最初の readonly プローブ。
// イベント源パターン（README §6-4 / connectors/README.md §3-1）：外の出来事 → situation → 人格層。
//   git.js      … 監視リポジトリの `git status --porcelain=v2 --branch` を読む（readonly・コマンド注入）＋遷移検知
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（git.dirty / git.clean ＝未コミット、git.unpushed / git.pushed ＝未 push。
//                  LLM は ctx.n＝未コミット数・ctx.ahead＝未 push 数・ctx.repo を織り込む）
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
// 二つの独立した二値遷移を見る（HA の home/away と同型）：
//   - dirty（未コミットあり）↔ clean … `git.dirty` / `git.clean`
//   - ahead>0（未 push あり）↔ 同期済み … `git.unpushed` / `git.pushed`（upstream 無しは ahead=0 扱い＝催促しない）
// コミットは「dirty→clean」と「ahead 0→N」を同時に起こす。1 poll で 1 つしか返せないので、
// dirty 遷移を先に返し、ahead 遷移は次の poll に繰り越す（各遷移はちょうど一度出る）。
// 「どれだけ溜まってから言うか」のデバウンス／しきい値は将来の拡張（この型を増やす）。

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
  let wasAhead; // 直前の「未 push あり」状態

  // `git -C <repo> status --porcelain=v2 --branch`：未コミット数（n）と未 push 数（ahead）を一度に取る。
  // v2 のヘッダ行は `#` 始まり（`# branch.ab +A -B` が ahead/behind）。ファイル行は `#` 以外。
  // 読めなければ null（黙る＝PE）。upstream が無ければ branch.ab 行が無く ahead=0（＝push 催促しない）。
  async function read() {
    let out;
    try {
      out = await run('git', ['-C', repo, 'status', '--porcelain=v2', '--branch']);
    } catch {
      return null; // run が投げた（注入 run 等）→ 黙る
    }
    if (out == null) return null; // git 不在・リポでない（exit≠0）→ 黙る
    let n = 0, ahead = 0;
    for (const line of out.split('\n')) {
      if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+)\s+-(\d+)/);
        if (m) ahead = parseInt(m[1], 10);
      } else if (line && !line.startsWith('#')) {
        n++; // 変更／未追跡エントリ（clean なら 0）
      }
    }
    return { dirty: n > 0, n, ahead };
  }

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      const ahead = st.ahead > 0;
      if (!primed) { primed = true; wasDirty = st.dirty; wasAhead = ahead; return null; } // 初回は基準だけ
      // dirty 遷移を先に。ahead が同時に変わっていても、それは次の poll に繰り越す（各遷移ちょうど一度）。
      if (st.dirty !== wasDirty) {
        wasDirty = st.dirty;
        return { situation: st.dirty ? 'git.dirty' : 'git.clean', ctx: { n: st.n, repo: repoName } };
      }
      if (ahead !== wasAhead) {
        wasAhead = ahead;
        return { situation: ahead ? 'git.unpushed' : 'git.pushed', ctx: { ahead: st.ahead, repo: repoName } };
      }
      return null; // 無変化
    },
  };
}
