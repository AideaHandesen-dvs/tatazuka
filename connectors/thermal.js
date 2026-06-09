// Thermal 入力コネクタ（CPU/筐体温度の hot↔ok）。connectors の「入力」役・soft 委譲の readonly プローブ。
// 「机に座ってる人全員」に効く体感——膝の上が熱い・ファンが唸る。型は nic と同じ **below=false の
// しきい値**（大きいほど警戒）に、温度のスパイク弾き（瞬間的な負荷で跳ねる）のデバウンスを足したもの。
//   thermal.js  … /sys/class/thermal/thermal_zone*/temp を読む（readonly・ファイル読むだけ）＋しきい値検知
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（temp.hot / temp.ok。LLM は ctx.tempC を織り込む）
//
// 設計（イベント源パターンの三点・disk / nic と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：TZ_TEMP が未設定・thermal_zone が無い（仮想/読めない）→ null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：読み口を opts.readTemps で差し替え可能（テストで実 /sys を読まない）。
//   - 依存ゼロ：node 標準（fs）のみ。読むのは固定の readonly 一点（soft を構造で守る・§7-1）。
//
// 複数ゾーン（CPU/GPU/各種センサ）の**最大**を「今いちばん熱いところ」として見る。TZ_TEMP_HOT_C（既定 80℃）を
// 超え続けると temp.hot、戻し閾値（-5℃）を下回ると temp.ok。判定は共有部品 hysteresis.js（below=false）に委ねる。
// 温度は一瞬の負荷でツンと跳ねるので、デバウンス 3（連続して見て初めて確定＝スパイクで騒がない）。

import { readdir, readFile } from 'node:fs/promises';
import { makeThreshold } from './hysteresis.js';

const HOT_C = 80;    // この温度（℃）を超え続けたら「熱い」とみなす
const MARGIN = 5;    // 戻し閾値の余裕（ヒステリシス幅）
const DEBOUNCE = 3;  // 何回連続で確定するか（瞬間的な発熱では騒がない）

const BASE = '/sys/class/thermal';

// 既定の読み口：thermal_zone* の temp（ミリ℃）を ℃ にして配列で返す。読めなければ null（PE：黙る）。
async function defaultReadTemps() {
  let names;
  try {
    names = await readdir(BASE);
  } catch {
    return null;
  }
  const out = [];
  for (const name of names) {
    if (!name.startsWith('thermal_zone')) continue;
    try {
      const milli = parseInt((await readFile(`${BASE}/${name}/temp`, 'utf8')).trim(), 10);
      if (Number.isFinite(milli)) out.push(milli / 1000); // ミリ℃ → ℃
    } catch {
      // このゾーンは読めない → 飛ばす
    }
  }
  return out.length ? out : null; // 一つも読めなければ黙る
}

// env / opts を見て connector を作る。TZ_TEMP が未設定なら null（＝オフ＝PE）。
// opts.readTemps / opts.hotC / opts.env はテスト・直接指定用。
export function createThermal(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const readTemps = opts.readTemps || defaultReadTemps;

  if (!e.TZ_TEMP || typeof readTemps !== 'function') return null;
  const hotC = Number(opts.hotC ?? e.TZ_TEMP_HOT_C ?? HOT_C);

  // 大きいほど警戒（below=false）：v>hotC で warn、v<hotC-MARGIN で ok。スパイク弾きにデバウンス。
  const th = makeThreshold({ low: hotC - MARGIN, high: hotC, below: false, debounce: DEBOUNCE });

  async function read() {
    let temps;
    try {
      temps = await readTemps();
    } catch {
      return null; // readTemps が投げた → 黙る
    }
    if (temps == null || !temps.length) return null;
    const tempC = Math.round(Math.max(...temps) * 10) / 10; // いちばん熱いゾーン（小数1桁）
    return { tempC };
  }

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      const ev = th.feed(st.tempC); // 'enter'（熱い）/ 'exit'（落ち着いた）/ null
      if (!ev) return null;
      return { situation: ev === 'enter' ? 'temp.hot' : 'temp.ok', ctx: { tempC: st.tempC } };
    },
  };
}
