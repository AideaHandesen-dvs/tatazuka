// Illuminance 入力コネクタ（室内の明るさの dark↔ok＝「暗くなってきたぞ、電気つけたら」）。connectors の「入力」役。
// humidity/co2/roomtemp に続く **HA が唯一くれる「部屋の中」** の四本目。夕暮れに照明をつけ忘れて薄暗い中で
// 作業してる、を同居人が気づいて一言。目に悪い・気づかず暗くなる、は「机に座る人全員」に効く。
//   illuminance.js … HA の照度 sensor の state（lux）を読む（REST・ha.js 共有）＋しきい値検知
//   behavior.js     … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*       … 何を喋るか（illuminance.dark / illuminance.ok。LLM は ctx.lux を織り込む）
//
// 設計（イベント源パターンの三点・co2 と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：URL/トークン/対象 entity が欠ける・HA 不達・state が数値でない（"unavailable" 等）→ null（黙る）。
//   - IO 注入：fetch を opts で差し替え可能（テストで実 HA を叩かない・ha.js 経由）。
//   - 依存ゼロ：グローバル fetch のみ（SDK なし。他の HA 入力と同じ方針）。
//
// 型：**片側しきい値（below=true＝小さいほど悪い）**＝disk/memory（空きが少ないほど悪い）と同系。CO2 が
// below=false（大きいほど悪い）だったのと逆。暗い（lux 小）が警戒側。`TZ_LUX_MIN`（既定 50lux＝薄暗い目安）を
// 割り続けると `illuminance.dark`、戻し閾値（+30lux＝80lux）を超えると `illuminance.ok`。照度は雲の通過や人影で
// ちらつくのでデバウンス 3（連続して見て確定＝一瞬の翳りで騒がない）。判定は共有部品 hysteresis.js に委ねる。
// env：TZ_HASS_URL ＋ TZ_HASS_TOKEN（他の HA 入力と共有）＋ TZ_HASS_LUX（対象 entity 例 sensor.living_illuminance）。
// 閾値は TZ_LUX_MIN（既定 50）で変えられる。

import { makeHassReader } from './ha.js';
import { makeThreshold } from './hysteresis.js';

const MIN = 50;      // この lux を下回り続けたら「暗い」とみなす（薄暗い・要照明の目安）
const MARGIN = 30;   // 戻し閾値の余裕（ヒステリシス幅・80lux で回復）
const DEBOUNCE = 3;  // 何回連続で確定するか（雲の通過・人影の一瞬の翳りで騒がない）

// env / opts を見て connector を作る。HA の前提が欠ければ null（＝オフ＝PE）。
// opts.fetch / opts.url / opts.token / opts.entity / opts.min / opts.env はテスト・直接指定用。
export function createIlluminance(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const read = makeHassReader(opts, 'TZ_HASS_LUX');
  if (!read) return null; // 接続先・認証・対象・fetch のどれかが欠けた → connector オフ（PE）

  const min = Number(opts.min ?? e.TZ_LUX_MIN ?? MIN);
  // 小さいほど警戒（below=true）：v<min で warn（暗い）、v>min+MARGIN で ok。ちらつき弾きにデバウンス。接続ごとに独立。
  const th = makeThreshold({ low: min, high: min + MARGIN, below: true, debounce: DEBOUNCE });

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      const lux = Number(st.state);
      if (!Number.isFinite(lux)) return null; // "unavailable"/"unknown" 等 → 黙る
      const ev = th.feed(lux); // 'enter'（暗くなった）/ 'exit'（明るくなった）/ null
      if (!ev) return null;
      return { situation: ev === 'enter' ? 'illuminance.dark' : 'illuminance.ok', ctx: { lux: Math.round(lux) } };
    },
  };
}
