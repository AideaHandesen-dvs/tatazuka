// NIC 入力コネクタ（通信レートの busy↔idle）。soft 委譲の readonly プローブ・**レート型**の初例。
// /proc/net/dev が返すのは「起動からの累計バイト数」＝カーネルが時間積分済みのカウンタ。だから
// レートは自分で積分せず、**2 点を読んで差分÷経過時間**で出す（瞬間値でなく窓の平均＝軽いローパス）。
// 「大きいほど警戒」なので hysteresis.js を below=false で使う（しきい値を高い側で跨ぐ）。
//   nic.js      … /proc/net/dev の rx+tx 累計を読む（readonly）＋前回との差分でレート＋しきい値検知
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（nic.busy / nic.idle。LLM は ctx.mbps を織り込む）
//
// 設計（イベント源パターンの三点・disk / memory と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：TZ_NIC が未設定・/proc/net/dev が読めない → null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：読み口を opts.read・時計を opts.now で差し替え可能（テストで実 /proc・実時計を使わない）。
//   - 依存ゼロ：node 標準（fs）のみ。読むのは固定の readonly 一点（soft を構造で守る・§7-1）。
//
// レートが TZ_NIC_BUSY_MBPS（既定 2 MB/s）を超える状態が続くと nic.busy、その 1/4 を下回ると nic.idle
// （ヒステリシス）。レートは既に窓平均だが瞬間バーストもあるので debounce=2。lo は除く（rx+tx 合算）。

import { readFile } from 'node:fs/promises';
import { makeThreshold } from './hysteresis.js';

const BUSY_MBPS = 2; // この MB/s を超える通信が続いたら「通信中」とみなす
const DEBOUNCE = 2;  // 何回連続で確定するか（瞬間バーストを弾く）

// 既定の読み口：/proc/net/dev を読む。読めなければ null（PE：黙る）
function defaultRead() {
  return readFile('/proc/net/dev', 'utf8').catch(() => null);
}

// env / opts を見て connector を作る。TZ_NIC が未設定なら null（＝オフ＝PE）。
// opts.read / opts.now / opts.busyMbps / opts.env はテスト・直接指定用。
export function createNic(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const read = opts.read || defaultRead;
  const now = opts.now || Date.now;

  if (!e.TZ_NIC || typeof read !== 'function') return null;
  const busy = Number(opts.busyMbps ?? e.TZ_NIC_BUSY_MBPS ?? BUSY_MBPS);
  // below=false（レートが高いほど busy）。回復はその 1/4（ヒステリシス）。接続ごとに独立。
  const th = makeThreshold({ low: busy / 4, high: busy, below: false, debounce: DEBOUNCE });

  let prevBytes = null;
  let prevTime = null;

  // /proc/net/dev：lo 以外の rx+tx 累計バイト合計を読む。読めなければ null（黙る）。
  // 各行 "iface: rxbytes ... txbytes ..."（rx=0 列目、tx=8 列目）。
  async function readBytes() {
    let txt;
    try {
      txt = await read();
    } catch {
      return null;
    }
    if (txt == null) return null;
    let total = 0, found = false;
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([^:]+):\s*(.*)$/);
      if (!m) continue;                       // ヘッダ行（コロン無し）は飛ばす
      if (m[1].trim() === 'lo') continue;     // ループバックは除外
      const nums = m[2].trim().split(/\s+/).map(Number);
      if (nums.length < 9 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[8])) continue;
      total += nums[0] + nums[8];             // rx bytes ＋ tx bytes
      found = true;
    }
    return found ? total : null;
  }

  return {
    async poll() {
      const bytes = await readBytes();
      if (bytes == null) return null;
      const t = now();
      if (prevBytes == null) { prevBytes = bytes; prevTime = t; return null; } // 初回は基準（2 点目からレート）
      const dt = (t - prevTime) / 1000; // 秒
      const db = bytes - prevBytes;
      prevBytes = bytes; prevTime = t;
      if (dt <= 0 || db < 0) return null; // 時計巻き戻り・カウンタリセットは無視（黙る）
      const mbps = db / dt / 1e6;
      const ev = th.feed(mbps); // 'enter'（通信中）/ 'exit'（落ち着いた）/ null
      if (!ev) return null;
      return { situation: ev === 'enter' ? 'nic.busy' : 'nic.idle', ctx: { mbps: Math.round(mbps * 10) / 10 } };
    },
  };
}
