// Memory 入力コネクタ（空きメモリの low↔ok）。soft 委譲の readonly プローブ。
// disk が「即時しきい値」だったのに対し、これは**デバウンス付きしきい値**の初例：
// メモリは瞬間値でジャギジャギ跳ねる（ビルドで一瞬食う）ので、ヒステリシス（縁のチャタ）に加えて
// デバウンス（N 連続で確定＝スパイクを弾く）を効かせる。判定は共有部品 hysteresis.js に委ねる。
//   memory.js   … /proc/meminfo の MemAvailable/MemTotal を読む（readonly・ファイル読むだけ）
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（mem.low / mem.ok。LLM は ctx.availPct / ctx.availGb を織り込む）
//
// 設計（イベント源パターンの三点・git / disk と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：TZ_MEM が未設定・/proc/meminfo が読めない → null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：読み口を opts.read で差し替え可能（テストで実 /proc を読まない）。
//   - 依存ゼロ：node 標準（fs）のみ。読むのは固定の readonly 一点（soft を構造で守る・§7-1）。
//
// 空きメモリ率（MemAvailable/MemTotal）が TZ_MEM_MIN_PCT（既定 10）を割ったら mem.low、
// 戻し閾値（+5）を超えたら mem.ok。デバウンスは 3 回連続（30 秒 tick なら約 90 秒の継続で確定）。

import { readFile } from 'node:fs/promises';
import { makeThreshold } from './hysteresis.js';

const MIN_PCT = 10;   // この空き率（%）を下回ったら「逼迫」とみなす
const MARGIN = 5;     // 戻し閾値の余裕（ヒステリシス幅）
const DEBOUNCE = 3;   // 何回連続で確定するか（スパイク弾き。瞬間的な逼迫では喋らない）

// 既定の読み口：/proc/meminfo を読む。読めなければ null（PE：黙る）
function defaultRead() {
  return readFile('/proc/meminfo', 'utf8').catch(() => null);
}

// env / opts を見て connector を作る。TZ_MEM が未設定なら null（＝オフ＝PE）。
// opts.read / opts.minPct / opts.env はテスト・直接指定用。
export function createMemory(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const read = opts.read || defaultRead;

  // PE：明示的に有効化されていなければオフ（/proc/meminfo は常在だが、勝手に監視しない）
  if (!e.TZ_MEM || typeof read !== 'function') return null;
  const minPct = Number(opts.minPct ?? e.TZ_MEM_MIN_PCT ?? MIN_PCT);

  // 判定は共有部品に委ねる（ヒステリシス＋デバウンス）。接続ごとに独立した状態。
  const th = makeThreshold({ low: minPct, high: minPct + MARGIN, below: true, debounce: DEBOUNCE });

  // MemAvailable / MemTotal（kB）を読んで空き率（%）と空き GB を返す。読めなければ null（黙る）。
  async function readState() {
    let txt;
    try {
      txt = await read();
    } catch {
      return null; // read が投げた（注入 read 等）→ 黙る
    }
    if (txt == null) return null;
    const total = txt.match(/^MemTotal:\s+(\d+)/m);
    const avail = txt.match(/^MemAvailable:\s+(\d+)/m);
    if (!total || !avail) return null;
    const t = parseInt(total[1], 10), a = parseInt(avail[1], 10);
    if (!t) return null;
    const availPct = Math.round((a / t) * 1000) / 10;     // 小数1桁
    const availGb = Math.round((a / 1024 / 1024) * 10) / 10; // meminfo は kB
    return { availPct, availGb };
  }

  return {
    async poll() {
      const st = await readState();
      if (!st) return null;
      const ev = th.feed(st.availPct); // 'enter'（逼迫）/ 'exit'（回復）/ null
      if (!ev) return null;
      return {
        situation: ev === 'enter' ? 'mem.low' : 'mem.ok',
        ctx: { availPct: st.availPct, availGb: st.availGb },
      };
    },
  };
}
