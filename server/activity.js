// 作業監視イベント源（離席・復帰）。weather.js と同じ「外部イベント源 → situation タグ」型。
//   activity.js … ホストの入力 idle を読む（X11 / Wayland）。トランスポート/人格を知らない
//   behavior.js … いつ拾うか（tick で poll）／persona.* … desk.away / desk.back の台詞
//
// 設計：
//   - 佇か本体（server）はユーザーの作業 PC 上で動くので、ホスト自身の idle ＝実際の作業状態。
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は触らない。
//   - PE：表示サーバが無い／idle ツールが無い → 作業監視は出ない。佇かは在席時間の代理指標で動く。
//   - 依存ゼロ（node_modules 無し）は維持。idle はシステムツールに shell out し、無ければ縮退。
//     アクティブウィンドウは見ない（Wayland でほぼ不可・プライバシー）。idle 一本に絞る。
//
// バックエンド：
//   - X11：`xprintidle`（idle ミリ秒を直接返す）
//   - Wayland/GNOME：`gdbus` で Mutter IdleMonitor の GetIdletime（uint64 ミリ秒）
// どれも無ければ作業監視オフ。実機での生スモークは各自（README）。

import { execFile } from 'node:child_process';

const AWAY_MS = 5 * 60 * 1000; // この idle で「離席」とみなす
const MAX_PROBE = 5;           // バックエンド確定までの試行上限（全滅したら以後あきらめる）

// 既定のコマンド実行：短いタイムアウトで stdout を返す。失敗は null（PE：黙って縮退）
function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch {
      resolve(null);
    }
  });
}

// X11：xprintidle → "12345\n"（idle ミリ秒）
const x11Backend = (run) => async () => {
  const out = await run('xprintidle', []);
  if (out == null) return null;
  const ms = parseInt(out.trim(), 10);
  return Number.isFinite(ms) ? ms : null;
};

// Wayland/GNOME：Mutter IdleMonitor.GetIdletime → "(uint64 12345,)"
const mutterBackend = (run) => async () => {
  const out = await run('gdbus', ['call', '--session',
    '--dest', 'org.gnome.Mutter.IdleMonitor',
    '--object-path', '/org/gnome/Mutter/IdleMonitor/Core',
    '--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime']);
  if (out == null) return null;
  const m = out.match(/uint64\s+(\d+)/); // "(uint64 12345,)" の uint64 の "64" を拾わないよう型名の後を取る
  return m ? parseInt(m[1], 10) : null;
};

// env を見て idle 監視を作る。バックエンド候補が無ければ null（作業監視オフ＝PE）。
// opts.run / opts.backend / opts.awayMs はテスト注入用。
export function createActivity(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const run = opts.run || defaultRun;
  const awayMs = opts.awayMs || AWAY_MS;

  const candidates = [];
  if (opts.backend) candidates.push(opts.backend); // テスト注入（これだけ使う）
  else {
    if (e.DISPLAY) candidates.push(x11Backend(run));
    if (e.WAYLAND_DISPLAY || e.XDG_SESSION_TYPE === 'wayland') candidates.push(mutterBackend(run));
  }
  if (!candidates.length) return null; // 表示サーバ無し（ヘッドレス等）＝作業監視オフ

  let backend = null;   // 確定したバックエンド（null=未確定 or 全滅）
  let resolved = false; // 確定済みか
  let attempts = 0;
  let away = false;

  // 最初に数値を返した候補を採用。何度試しても無理なら以後あきらめる（無駄な spawn を止める）
  async function idle() {
    if (resolved) return backend ? backend() : null;
    for (const c of candidates) {
      const ms = await c();
      if (ms != null) { backend = c; resolved = true; return ms; }
    }
    if (++attempts >= MAX_PROBE) resolved = true; // backend は null のまま＝以後オフ
    return null;
  }

  return {
    // idle のしきい値跨ぎで desk.away / desk.back を返す（無変化・読めなければ null）
    async poll() {
      const ms = await idle();
      if (ms == null) return null;
      if (!away && ms >= awayMs) { away = true; return { situation: 'desk.away' }; }
      if (away && ms < awayMs) { away = false; return { situation: 'desk.back' }; }
      return null;
    },
  };
}
