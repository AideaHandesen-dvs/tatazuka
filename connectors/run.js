// CLI 実行の共有部品（純 IO・依存ゼロ）。OS 別バックエンド（README §7-3）で readonly コマンドを叩く
// probe（disk / battery / memory / nic / net …）が共有する。短いタイムアウトで stdout を返し、失敗
// （コマンド不在・タイムアウト・spawn 例外）はすべて null に畳む（PE：黙る）。判定を切り出した hysteresis.js
// と同じ「OS 非依存の小部品に寄せる」方針＝§7-3 が警告した platform.js（OS 知識の god module）とは別物。
import { execFile } from 'node:child_process';

export function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 3000 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch {
      resolve(null);
    }
  });
}
