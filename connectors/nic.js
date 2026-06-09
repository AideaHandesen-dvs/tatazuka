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
//   - PE：TZ_NIC が未設定・読めない → null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：linux の読み口を opts.read、Mac 経路を opts.run / opts.platform、時計を opts.now で差し替え可能。
//   - 依存ゼロ：node 標準（fs / child_process）のみ。読むのは固定の readonly 一点（soft を構造で守る・§7-1）。
//
// レートが TZ_NIC_BUSY_MBPS（既定 2 MB/s）を超える状態が続くと nic.busy、その 1/4 を下回ると nic.idle
// （ヒステリシス）。レートは既に窓平均だが瞬間バーストもあるので debounce=2。lo は除く（rx+tx 合算）。
//
// OS 別バックエンド（README §7-3・確定③）：どちらも lo 以外の rx+tx 累計バイト合計（number）に正規化＝
// レート判定（差分÷経過）は OS 非依存で再利用。
//   - linux : /proc/net/dev の rx(0)+tx(8) 列（readBytesLinux・従来）
//   - darwin: `netstat -ibn` の <Link#> 行の Ibytes+Obytes（readBytesMac。重複アドレス行は除外）
//   - その他（Win 等）: linux 既定に落ち /proc 不在で null 縮退（将来 readBytesWin を同様に分岐）

import { readFile } from 'node:fs/promises';
import { run as defaultRun } from './run.js';
import { makeThreshold } from './hysteresis.js';

const BUSY_MBPS = 2; // この MB/s を超える通信が続いたら「通信中」とみなす
const DEBOUNCE = 2;  // 何回連続で確定するか（瞬間バーストを弾く）

// linux の既定読み口：/proc/net/dev を読む。読めなければ null（PE：黙る）
function readNetDevText() {
  return readFile('/proc/net/dev', 'utf8').catch(() => null);
}

// linux：/proc/net/dev テキスト → lo 以外の rx+tx 累計合計（number）。各行 "iface: rx ... tx ..."（rx=0,tx=8）。
async function readBytesLinux(read) {
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

// darwin：`netstat -ibn` → lo 以外の Ibytes+Obytes 合計（number）。各 if は宛先別に複数行出るが、累計は
// どの行も同じなので **<Link# 行だけ**を採って二重計上を避ける。末尾 7 列が Ipkts Ierrs Ibytes Opkts Oerrs
// Obytes Coll（MAC 有無で前方の列数が変わるので末尾から数える）。
async function readBytesMac(run) {
  let out;
  try {
    out = await run('netstat', ['-ibn']);
  } catch {
    return null;
  }
  if (out == null) return null;
  let total = 0, found = false;
  for (const line of out.split('\n')) {
    if (!line.includes('<Link#')) continue;                  // Link 行だけ（重複アドレス行を除外）
    const tok = line.trim().split(/\s+/);
    if (tok[0].replace(/\*$/, '').startsWith('lo')) continue; // lo* 除外
    const nums = tok.slice(-7).map(Number);                   // 末尾 7 列＝数値カウンタ
    if (nums.length < 7 || !Number.isFinite(nums[2]) || !Number.isFinite(nums[5])) continue;
    total += nums[2] + nums[5];                               // Ibytes ＋ Obytes
    found = true;
  }
  return found ? total : null;
}

// プラットフォームで読み口を選ぶ（§7-3・特権ゼロ）。opts.read（text seam）が明示なら従来の linux 経路を優先。
function defaultReadBytes(opts) {
  if (opts.read) return readBytesLinux(opts.read);
  const plat = opts.platform || process.platform;
  if (plat === 'darwin') return readBytesMac(opts.run || defaultRun);
  return readBytesLinux(readNetDevText);
}

// env / opts を見て connector を作る。TZ_NIC が未設定なら null（＝オフ＝PE）。
// opts.read / opts.run / opts.platform / opts.now / opts.busyMbps / opts.env はテスト・直接指定用。
export function createNic(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const now = opts.now || Date.now;

  if (!e.TZ_NIC) return null;
  const busy = Number(opts.busyMbps ?? e.TZ_NIC_BUSY_MBPS ?? BUSY_MBPS);
  // below=false（レートが高いほど busy）。回復はその 1/4（ヒステリシス）。接続ごとに独立。
  const th = makeThreshold({ low: busy / 4, high: busy, below: false, debounce: DEBOUNCE });
  const readBytes = opts.readBytes || (() => defaultReadBytes(opts));

  let prevBytes = null;
  let prevTime = null;

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
