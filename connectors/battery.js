// Battery 入力コネクタ（バッテリー残量の low↔ok）。connectors の「入力」役・soft 委譲の readonly プローブ。
// git/disk/memory/net/nic が「開発者の机」寄りだったのに対し、これは**ノートを使う人全員**に効く一番素直な
// 同居人の気遣い——「電池切れそう、充電しな」。型としては disk（しきい値）に**充電状態のゲート**が
// 乗ったもの＝「**ゲート付きしきい値**」（既存の二値/即時しきい値/デバウンス/レートに続く第五の型）。
//   battery.js  … /sys/class/power_supply/* の capacity / status を読む（readonly・ファイル読むだけ）
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（battery.low / battery.ok。LLM は ctx.capacity / ctx.charging を織り込む）
//
// 設計（イベント源パターンの三点・disk / net と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：TZ_BATTERY が未設定・バッテリーが無い（デスクトップ）・読めない → null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：読み口を opts.readPower で差し替え可能（テストで実 /sys を読まない）。Mac 経路は opts.run / opts.platform。
//   - 依存ゼロ：node 標準（fs / child_process）のみ。読むのは固定の readonly 一点（soft を構造で守る・§7-1）。
//
// OS 別バックエンド（README §7-3・決定 2026-06-09）：defaultReadPower が process.platform で読み口を選ぶ。
//   - linux : /sys/class/power_supply を直読（readPowerLinux・従来）
//   - darwin: `pmset -g batt` を読み Linux 語彙へ正規化（readPowerMac・特権ゼロの CLI）
//   - その他（Win 等）: 当面 linux 既定に落ちる＝/sys が無く null 縮退（PE。将来 readPowerWin を同様に分岐）
// 正規化で {capacity, status, acOnline} の同じ形に揃えるので、判定（充電ゲート・ヒステリシス・満充電遷移）は
// OS 非依存のまま再利用できる。**特権が要るものは取りにいかない**：温度のように昇格が要る読みは縮退側に置く（§7-3 決定①）。
//
// 「充電ゲート」が disk と違う肝：**残量が低くても電源に繋がっていれば警告しない**（充電中に「切れそう」は嘘）。
// これを別ロジックにせず型に閉じ込めるため、しきい値部品には「放電中なら実残量・それ以外は安全値 100」を流す。
//   → battery.low は放電中に閾値を割ったときだけ出る／繋ぎ直せば 100 が流れて exit＝battery.ok（「充電して持ち直した」）。
// しきい値の縁のチャタはヒステリシス（共有部品）で吸収。残量はゆっくり動くのでデバウンスは 1（即時・disk と同じ）。
//
// 二つ目の軸（git の dirty/ahead と同型・独立した二値遷移）：**満充電で繋ぎっぱ**＝電池いたわり。
// status==='Full' に入ったら一度だけ `battery.full`（「もう満タン、抜いたら」）。外れたらリセットだけ（次の満充電でまた言える）。
// ノートを電源刺しっぱで使う人全員に効く——battery.low（放電が怖い）と対になる「充電し過ぎ」の気遣い。
// 1 poll に 1 遷移（git と同じ）：残量警告を先に返し、full 遷移は次の poll に繰り越す。

import { readdir, readFile } from 'node:fs/promises';
import { run as defaultRun } from './run.js';
import { makeThreshold } from './hysteresis.js';

const MIN_PCT = 20; // この残量（%）を放電中に割ったら「切れそう」とみなす（disk より高い＝電池は 20% で逼迫）
const MARGIN = 5;   // 戻し閾値の余裕（ヒステリシス幅）

const BASE = '/sys/class/power_supply';

// Linux の読み口：/sys/class/power_supply を走査し、最初のバッテリーの capacity / status と AC の online を返す。
// バッテリーが無い（デスクトップ）・読めなければ null（PE：黙る）。
async function readPowerLinux() {
  let names;
  try {
    names = await readdir(BASE);
  } catch {
    return null;
  }
  let capacity = null, status = null, acOnline = null;
  for (const name of names) {
    let type;
    try {
      type = (await readFile(`${BASE}/${name}/type`, 'utf8')).trim();
    } catch {
      continue; // type が読めない疑似デバイス → 飛ばす
    }
    if (type === 'Battery' && capacity == null) {
      try {
        capacity = parseInt((await readFile(`${BASE}/${name}/capacity`, 'utf8')).trim(), 10);
        status = (await readFile(`${BASE}/${name}/status`, 'utf8')).trim();
      } catch {
        capacity = null; status = null; // 片方でも欠けたら採らない
      }
    } else if (type === 'Mains') {
      try {
        acOnline = (await readFile(`${BASE}/${name}/online`, 'utf8')).trim() === '1';
      } catch {
        // AC が読めなくても status で放電判定できる → 無視
      }
    }
  }
  if (capacity == null || !Number.isFinite(capacity)) return null; // バッテリー無し → 黙る（PE）
  return { capacity, status, acOnline };
}

// macOS の読み口：`pmset -g batt` を読み、Linux と同じ {capacity, status, acOnline} に正規化する。
// 出力例（実ノート）：
//   Now drawing from 'Battery Power'
//    -InternalBattery-0 (id=...)\t87%; discharging; 3:21 remaining present: true
// バッテリー行が無い（デスクトップ/VM＝実機で確認）→ null（PE：黙る）。status は放電/満充電だけ判定に効くので、
// それ以外（charging / not charging / AC attached 等）は中立扱い（警告も満充電遷移も出さない）。
async function readPowerMac(run) {
  let out;
  try {
    out = await run('pmset', ['-g', 'batt']);
  } catch {
    return null; // run が投げた → 黙る
  }
  if (out == null) return null; // pmset 不在 → 黙る
  const m = out.match(/(\d+)%\s*;\s*([^;]+);/); // " 87%; discharging; ..." の残量と状態
  if (!m) return null;                          // バッテリー行が無い（電源のみ）→ 黙る（PE）
  const capacity = parseInt(m[1], 10);
  if (!Number.isFinite(capacity)) return null;
  const raw = m[2].trim().toLowerCase();
  const status =
    raw === 'discharging' ? 'Discharging' :                          // → 警告ゲートが開く
    raw === 'charged' ? 'Full' :                                     // → 満充電いたわり
    (raw === 'charging' || raw === 'finishing charge') ? 'Charging' : // → 中立（充電中）
    'Unknown';                                                       // not charging / AC attached 等＝中立
  const acOnline = /drawing from '[^']*AC[^']*'/i.test(out);        // 'AC Power' から給電中か（情報用）
  return { capacity, status, acOnline };
}

// プラットフォームで読み口を選ぶ（§7-3・特権ゼロ）。opts.platform / opts.run はテストで OS・CLI を強制する用。
function defaultReadPower(opts) {
  const plat = opts.platform || process.platform;
  if (plat === 'darwin') return readPowerMac(opts.run || defaultRun);
  return readPowerLinux(); // linux 既定。Win 等は /sys が無く null 縮退（将来 readPowerWin を同様に分岐）
}

// env / opts を見て connector を作る。TZ_BATTERY が未設定なら null（＝オフ＝PE）。
// opts.readPower / opts.minPct / opts.env はテスト・直接指定用。
export function createBattery(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  // opts.readPower は読み口を丸ごと差し替える最上位の seam（従来通り）。未指定なら OS で読み口を選ぶ
  // defaultReadPower に opts（platform / run）を閉じ込めて zero-arg にする（read() 側は readPower() のまま）。
  const readPower = opts.readPower || (() => defaultReadPower(opts));

  // PE：明示的に有効化されていなければオフ（電源デバイスを勝手に監視しない＝net/mem と同じ作法）
  if (!e.TZ_BATTERY || typeof readPower !== 'function') return null;
  const minPct = Number(opts.minPct ?? e.TZ_BATTERY_MIN_PCT ?? MIN_PCT);

  // 判定は共有部品に委ねる（ヒステリシス）。接続ごとに独立した状態。残量はゆっくり動くのでデバウンス 1。
  const th = makeThreshold({ low: minPct, high: minPct + MARGIN, below: true, debounce: 1 });
  let primedFull = false;
  let wasFull; // 直前の「満充電（Full）」状態（軸2の遷移検知。接続ごとに独立）

  async function read() {
    try {
      return await readPower();
    } catch {
      return null; // readPower が投げた（注入 read 等）→ 黙る
    }
  }

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      // 軸1：残量警告。放電中（status==='Discharging'）だけ実残量を流す。それ以外（充電/満充電/不明）は安全値 100＝警告しない。
      const discharging = st.status === 'Discharging';
      const ev = th.feed(discharging ? st.capacity : 100); // 'enter'（切れそう）/ 'exit'（持ち直した）/ null
      if (ev) {
        return {
          situation: ev === 'enter' ? 'battery.low' : 'battery.ok',
          ctx: { capacity: st.capacity, charging: !discharging },
        };
      }
      // 軸2：満充電で繋ぎっぱ。Full に入った瞬間だけ battery.full（外れたらリセットだけ＝黙る）。
      const full = st.status === 'Full';
      if (!primedFull) { primedFull = true; wasFull = full; return null; } // 初回は基準だけ
      if (full !== wasFull) {
        wasFull = full;
        if (full) return { situation: 'battery.full', ctx: { capacity: st.capacity, charging: true } };
      }
      return null;
    },
  };
}
