// Disk 入力コネクタ（空き容量の low↔ok）。connectors の「入力」役、git.js に続く soft 委譲の readonly プローブ。
// git が二値遷移（clean/dirty）なのに対し、これは**しきい値またぎ**（weather / work.N 型）で、同じ
// イベント源パターンが閾値でも回ることを示す例（README §6-4 / connectors/README.md §3-1, §7-1）。
//   disk.js     … 監視パス（TZ_DISK_PATH）の `df` を読む（readonly・コマンド注入）＋しきい値検知
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（disk.low / disk.ok。LLM は ctx.freePct / ctx.freeGb を織り込む）
//
// 設計（イベント源パターンの三点・git / activity と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：監視パス（TZ_DISK_PATH）が無い・df が無い・読めない → null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：コマンド実行を opts.run で差し替え可能（テストで実 df を叩かない）。
//   - 依存ゼロ：node 標準（child_process）のみ。読むのは固定の readonly 一点（soft を構造で守る・§7-1）。
//
// 空き率（free%）が TZ_DISK_MIN_PCT（既定 10）を下回ったら disk.low、戻し閾値（+5）を超えたら disk.ok。
// 判定は共有部品 hysteresis.js に委ねる（シュミットトリガ＝境界のチャタを帯で吸収）。容量はゆっくり
// 変わるのでデバウンスは 1（即時）。inode・複数パスは将来の拡張（この型を増やす）。
//
// OS 別バックエンド（README §7-3・確定③）：defaultReadDisk が process.platform で読み口を選び、どちらも
// 同じ {freePct, freeGb} に正規化する＝判定（ヒステリシス）は OS 非依存で再利用。
//   - linux/darwin: `df -kP <path>`（readDiskDf）。POSIX -P が列構造を保証＝Mac でも無改修で効く（実証済）。
//   - win32: `Win32_LogicalDisk`（PowerShell・readDiskWin）。Windows に df は無いので別 CLI。path はドライブ
//            （例 'C:'）として DeviceID で絞り、FreeSpace/Size（バイト）を空き率/空き GB に正規化する。
//   - その他: linux 既定に落ちる（df が無ければ null 縮退＝PE）

import { run as defaultRun } from './run.js';
import { makeThreshold } from './hysteresis.js';

const MIN_PCT = 10; // この空き率（%）を下回ったら「残り少ない」とみなす
const MARGIN = 5;   // 戻し閾値の余裕（ヒステリシス幅）

// linux/darwin の読み口：`df -kP <path>`。空き率（free%）と空き GB を返す。読めなければ null（黙る＝PE）。
// -P（POSIX）はファイルシステムごと 1 行を保証（長い名前でも折り返さない）。
async function readDiskDf(run, path) {
  let out;
  try {
    out = await run('df', ['-kP', path]);
  } catch {
    return null; // run が投げた → 黙る
  }
  if (out == null) return null; // df 不在・パス不正 → 黙る
  const lines = out.trim().split('\n');
  if (lines.length < 2) return null;                 // ヘッダ＋データ行が要る
  const f = lines[lines.length - 1].trim().split(/\s+/);
  const capIdx = f.findIndex((x) => /^\d+%$/.test(x)); // Capacity（使用率 "82%"）の列
  if (capIdx < 1) return null;
  const usedPct = parseInt(f[capIdx], 10);
  const availKb = parseInt(f[capIdx - 1], 10);         // -P では Capacity の直前が Available
  if (!Number.isFinite(usedPct)) return null;
  const freePct = 100 - usedPct;
  const freeGb = Number.isFinite(availKb) ? Math.round((availKb / 1024 / 1024) * 10) / 10 : null;
  return { freePct, freeGb };
}

// win32 の読み口：`Win32_LogicalDisk` を PowerShell で読み、FreeSpace/Size（バイト）を正規化する。
// path はドライブレター（'C:' / 'C:\'）として扱い、末尾の \ / を落として DeviceID で絞る。Where-Object は
// シングルクォートだけで書く（execFile の argv に二重引用符を持ち込まない）。Format-List は "Key : Value"。
// 出力は CRLF（\r\n）なので \r を吸収する。ドライブが無い・読めなければ null（黙る＝PE）。
async function readDiskWin(run, path) {
  const drive = String(path).trim().replace(/[\\/]+$/, ''); // 'C:\' → 'C:'
  let out;
  try {
    out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq '${drive}' } | Format-List DeviceID,DriveType,FreeSpace,Size`]);
  } catch {
    return null;
  }
  if (out == null) return null;
  const txt = String(out).replace(/\r/g, '');
  const free = txt.match(/^FreeSpace\s*:\s*(\d+)/m);
  const size = txt.match(/^Size\s*:\s*(\d+)/m);
  if (!free || !size) return null;                         // 行が無い＝ドライブ不在 → 黙る
  const f = parseInt(free[1], 10), s = parseInt(size[1], 10);
  if (!s || !Number.isFinite(f) || !Number.isFinite(s)) return null;
  const freePct = Math.round((f / s) * 100);
  const freeGb = Math.round((f / 1024 / 1024 / 1024) * 10) / 10;
  return { freePct, freeGb };
}

// プラットフォームで読み口を選ぶ（§7-3・特権ゼロ）。opts.platform はテストで OS を強制する用。
function defaultReadDisk(opts, run, path) {
  const plat = opts.platform || process.platform;
  if (plat === 'win32') return readDiskWin(run, path);
  return readDiskDf(run, path); // linux/darwin（df は両方で効く）
}

// env / opts を見て connector を作る。監視パスが無ければ null（＝この connector はオフ＝PE）。
// opts.run / opts.path / opts.platform / opts.minPct / opts.env はテスト・直接指定用。
export function createDisk(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const run = opts.run || defaultRun;
  const path = opts.path || e.TZ_DISK_PATH;

  // PE：監視パス未設定なら connector オフ
  if (!path || typeof run !== 'function') return null;
  const minPct = Number(opts.minPct ?? e.TZ_DISK_MIN_PCT ?? MIN_PCT);

  // 判定は共有部品に委ねる（ヒステリシス。接続ごとに独立した状態）。
  const th = makeThreshold({ low: minPct, high: minPct + MARGIN, below: true, debounce: 1 });

  // 空き率（free%）と空き GB を返す（OS で読み口が変わるが正規化先は同じ）。読めなければ null（黙る＝PE）。
  async function read() {
    return defaultReadDisk(opts, run, path);
  }

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      const ev = th.feed(st.freePct); // 'enter'（残り少ない）/ 'exit'（回復）/ null（初回・帯内・無変化）
      if (!ev) return null;
      return { situation: ev === 'enter' ? 'disk.low' : 'disk.ok', ctx: { freePct: st.freePct, freeGb: st.freeGb, path } };
    },
  };
}
