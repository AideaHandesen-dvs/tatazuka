// Net 入力コネクタ（オンライン/オフライン）。connectors の「入力」役・二値遷移（HA の home/away と同型）。
// soft 委譲の readonly プローブ。しきい値も差分も要らない一番素直な型。
//   net.js      … /sys/class/net/<if>/operstate を読む（readonly・ファイル読むだけ）＋遷移検知
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（net.online / net.offline。LLM は ctx.iface を織り込む）
//
// 設計（イベント源パターンの三点・git / disk と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：TZ_NET が未設定・/sys/class/net が読めない → null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：読み口を opts.readIfaces で差し替え可能（テストで実 /sys を読まない）。
//   - 依存ゼロ：node 標準（fs）のみ。読むのは固定の readonly 一点（soft を構造で守る・§7-1）。
//
// lo 以外で operstate==up が一つでもあればオンライン。Wi-Fi の一瞬の瞬断で泣きたくなければ将来
// デバウンスを足せる（この型を増やす）が、v1 は素の二値遷移（operstate はそう頻繁に揺れない）。

import { readdir, readFile } from 'node:fs/promises';

// 既定の読み口：/sys/class/net の各 if の operstate を返す。読めなければ null（PE：黙る）
async function defaultReadIfaces() {
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

// env / opts を見て connector を作る。TZ_NET が未設定なら null（＝オフ＝PE）。
// opts.readIfaces / opts.env はテスト・直接指定用。
export function createNet(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const readIfaces = opts.readIfaces || defaultReadIfaces;

  if (!e.TZ_NET || typeof readIfaces !== 'function') return null;

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
