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
//   - PE：TZ_MEM が未設定・読めない → null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：linux の読み口を opts.read（/proc テキスト）、Mac 経路を opts.run / opts.platform で差し替え可能。
//   - 依存ゼロ：node 標準（fs / child_process）のみ。読むのは固定の readonly 一点（soft を構造で守る・§7-1）。
//
// OS 別バックエンド（README §7-3・確定③）：defaultReadState が process.platform で読み口を選び、どちらも
// 同じ {availPct, availGb} に正規化する＝判定（ヒステリシス＋デバウンス）は OS 非依存で再利用。
//   - linux : /proc/meminfo の MemAvailable/MemTotal（readMemLinux・従来）
//   - darwin: `vm_stat` ＋ `sysctl -n hw.memsize`（readMemMac）。macOS に MemAvailable 相当は無いので
//             available ≒ free + inactive + speculative + purgeable（再利用可能ページ）の近似。
//   - その他（Win 等）: linux 既定に落ち /proc 不在で null 縮退（将来 readMemWin を同様に分岐）
//
// 空きメモリ率が TZ_MEM_MIN_PCT（既定 10）を割ったら mem.low、戻し閾値（+5）を超えたら mem.ok。
// デバウンスは 3 回連続（30 秒 tick なら約 90 秒の継続で確定）。

import { readFile } from 'node:fs/promises';
import { run as defaultRun } from './run.js';
import { makeThreshold } from './hysteresis.js';

const MIN_PCT = 10;   // この空き率（%）を下回ったら「逼迫」とみなす
const MARGIN = 5;     // 戻し閾値の余裕（ヒステリシス幅）
const DEBOUNCE = 3;   // 何回連続で確定するか（スパイク弾き。瞬間的な逼迫では喋らない）

const round1 = (x) => Math.round(x * 10) / 10; // 小数1桁

// linux の既定読み口：/proc/meminfo テキスト。読めなければ null（PE：黙る）。
function readMeminfoText() {
  return readFile('/proc/meminfo', 'utf8').catch(() => null);
}

// linux：/proc/meminfo テキスト（kB）→ {availPct, availGb}。
async function readMemLinux(readText) {
  let txt;
  try {
    txt = await readText();
  } catch {
    return null; // 注入 read が投げた → 黙る
  }
  if (txt == null) return null;
  const total = txt.match(/^MemTotal:\s+(\d+)/m);
  const avail = txt.match(/^MemAvailable:\s+(\d+)/m);
  if (!total || !avail) return null;
  const t = parseInt(total[1], 10), a = parseInt(avail[1], 10);
  if (!t) return null;
  return { availPct: round1((a / t) * 100), availGb: round1(a / 1024 / 1024) }; // meminfo は kB
}

// darwin：`vm_stat`（ページ単位）＋`sysctl -n hw.memsize`（総バイト）→ {availPct, availGb}。
// available の定義は近似（macOS に直接の相当が無い）：free + inactive + speculative + purgeable。
async function readMemMac(run) {
  let vm, mem;
  try {
    vm = await run('vm_stat', []);
    mem = await run('sysctl', ['-n', 'hw.memsize']);
  } catch {
    return null;
  }
  if (vm == null || mem == null) return null;
  const total = parseInt(String(mem).trim(), 10); // バイト
  if (!Number.isFinite(total) || !total) return null;
  const free = vm.match(/Pages free:\s+(\d+)/);
  if (!free) return null; // vm_stat の体を成してない → 黙る
  const ps = parseInt((vm.match(/page size of (\d+) bytes/) || [])[1], 10) || 4096;
  const pg = (re) => { const m = vm.match(re); return m ? parseInt(m[1], 10) : 0; };
  const availPages =
    parseInt(free[1], 10) +
    pg(/Pages inactive:\s+(\d+)/) +
    pg(/Pages speculative:\s+(\d+)/) +
    pg(/Pages purgeable:\s+(\d+)/);
  const availBytes = availPages * ps;
  return { availPct: round1((availBytes / total) * 100), availGb: round1(availBytes / 1024 / 1024 / 1024) };
}

// プラットフォームで読み口を選ぶ（§7-3・特権ゼロ）。opts.read（text seam）が明示なら従来の linux 経路を優先。
function defaultReadState(opts) {
  if (opts.read) return readMemLinux(opts.read);
  const plat = opts.platform || process.platform;
  if (plat === 'darwin') return readMemMac(opts.run || defaultRun);
  return readMemLinux(readMeminfoText);
}

// env / opts を見て connector を作る。TZ_MEM が未設定なら null（＝オフ＝PE）。
// opts.read / opts.run / opts.platform / opts.minPct / opts.env はテスト・直接指定用。
export function createMemory(opts) {
  opts = opts || {};
  const e = opts.env || process.env;

  // PE：明示的に有効化されていなければオフ（/proc/meminfo は常在だが、勝手に監視しない）
  if (!e.TZ_MEM) return null;
  const minPct = Number(opts.minPct ?? e.TZ_MEM_MIN_PCT ?? MIN_PCT);

  // 判定は共有部品に委ねる（ヒステリシス＋デバウンス）。接続ごとに独立した状態。
  const th = makeThreshold({ low: minPct, high: minPct + MARGIN, below: true, debounce: DEBOUNCE });
  const readState = opts.readState || (() => defaultReadState(opts));

  return {
    async poll() {
      let st;
      try {
        st = await readState();
      } catch {
        return null; // 注入 readState が投げた → 黙る
      }
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
