// Net 入力コネクタ（オンライン/オフライン）。connectors の「入力」役・二値遷移（HA の home/away と同型）。
// soft 委譲の readonly プローブ。しきい値も差分も要らない一番素直な型。
//   net.js      … /sys/class/net/<if>/operstate を読む（readonly・ファイル読むだけ）＋遷移検知
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（net.online / net.offline。LLM は ctx.iface を織り込む）
//
// 設計（イベント源パターンの三点・git / disk と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：TZ_NET が未設定・読めない → null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：読み口を opts.readIfaces で差し替え可能（テストで実 /sys を読まない）。Mac 経路は opts.run / opts.platform。
//   - 依存ゼロ：node 標準（fs / child_process）のみ。読むのは固定の readonly 一点（soft を構造で守る・§7-1）。
//
// lo 以外で operstate==up が一つでもあればオンライン。Wi-Fi の一瞬の瞬断で泣きたくなければ将来
// デバウンスを足せる（この型を増やす）が、v1 は素の二値遷移（operstate はそう頻繁に揺れない）。
//
// OS 別バックエンド（README §7-3・確定③）：どちらも [{name, operstate}] に正規化＝遷移判定は OS 非依存。
//   - linux : /sys/class/net/<if>/operstate（readIfacesLinux・従来）
//   - darwin: `ifconfig` の flags（RUNNING を up とみなし、LOOPBACK は除外）（readIfacesMac）
//   - その他（Win 等）: linux 既定に落ち /sys 不在で null 縮退（将来 readIfacesWin を同様に分岐）

import { readdir, readFile } from 'node:fs/promises';
import { run as defaultRun } from './run.js';

// linux の読み口：/sys/class/net の各 if の operstate を返す。読めなければ null（PE：黙る）
async function readIfacesLinux() {
  let names;
  try {
    names = await readdir('/sys/class/net');
  } catch {
    return null;
  }
  const out = [];
  for (const name of names) {
    try {
      const operstate = (await readFile(`/sys/class/net/${name}/operstate`, 'utf8')).trim();
      out.push({ name, operstate });
    } catch {
      // この if は読めない → 飛ばす
    }
  }
  return out;
}

// darwin の読み口：`ifconfig` を parse。各 if の flags に RUNNING があれば operstate='up'。
// LOOPBACK フラグの if（lo0 等）は除外＝下流の lo 判定と同じく「数えない」。読めなければ null。
async function readIfacesMac(run) {
  let out;
  try {
    out = await run('ifconfig', []);
  } catch {
    return null;
  }
  if (out == null) return null;
  const ifaces = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+?):\s+flags=\d+<([^>]*)>/); // "en0: flags=8863<UP,...,RUNNING,...> ..."
    if (!m) continue;
    const flags = m[2];
    if (flags.includes('LOOPBACK')) continue;             // ループバックは数えない
    ifaces.push({ name: m[1], operstate: flags.includes('RUNNING') ? 'up' : 'down' });
  }
  return ifaces;
}

// プラットフォームで読み口を選ぶ（§7-3・特権ゼロ）。opts.platform / opts.run はテスト用。
function defaultReadIfaces(opts) {
  const plat = opts.platform || process.platform;
  if (plat === 'darwin') return readIfacesMac(opts.run || defaultRun);
  return readIfacesLinux();
}

// env / opts を見て connector を作る。TZ_NET が未設定なら null（＝オフ＝PE）。
// opts.readIfaces / opts.run / opts.platform / opts.env はテスト・直接指定用。
export function createNet(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const readIfaces = opts.readIfaces || (() => defaultReadIfaces(opts));

  if (!e.TZ_NET) return null;

  let primed = false;
  let wasOnline; // 直前のオンライン状態（遷移検知の状態。接続ごとに独立）

  async function read() {
    let ifaces;
    try {
      ifaces = await readIfaces();
    } catch {
      return null;
    }
    if (ifaces == null) return null;
    const up = ifaces.filter((i) => i.name !== 'lo' && i.operstate === 'up');
    return { online: up.length > 0, iface: up[0] && up[0].name };
  }

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      if (!primed) { primed = true; wasOnline = st.online; return null; } // 初回は基準だけ
      if (st.online === wasOnline) return null;                            // 無変化
      wasOnline = st.online;
      return {
        situation: st.online ? 'net.online' : 'net.offline',
        ctx: st.iface ? { iface: st.iface } : undefined,
      };
    },
  };
}
