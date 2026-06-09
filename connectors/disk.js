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

import { run as defaultRun } from './run.js';
import { makeThreshold } from './hysteresis.js';

const MIN_PCT = 10; // この空き率（%）を下回ったら「残り少ない」とみなす
const MARGIN = 5;   // 戻し閾値の余裕（ヒステリシス幅）

// env / opts を見て connector を作る。監視パスが無ければ null（＝この connector はオフ＝PE）。
// opts.run / opts.path / opts.minPct / opts.env はテスト・直接指定用。
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

  // `df -kP <path>`：空き率（free%）と空き GB を返す。読めなければ null（黙る＝PE）。
  // -P（POSIX）はファイルシステムごと 1 行を保証（長い名前でも折り返さない）。
  async function read() {
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
