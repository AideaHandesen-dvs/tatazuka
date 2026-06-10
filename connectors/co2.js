// CO2 入力コネクタ（室内 CO2 濃度の stuffy↔ok＝「空気こもってる、換気しろ」）。connectors の「入力」役。
// humidity.js（室内湿度）と並ぶ **HA が唯一くれる「部屋の中」** の二本目——Open-Meteo の外気では知れない、
// 締め切った部屋に人が居ると上がる CO2。眠気・集中力低下の体感に直結し、「机に座る人全員」に効く同居人ムーブ。
//   co2.js      … HA の CO2 sensor の state（ppm）を読む（REST・ha.js 共有）＋しきい値検知
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（co2.stuffy / co2.ok。LLM は ctx.ppm を織り込む）
//
// 設計（イベント源パターンの三点・humidity / thermal と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：URL/トークン/対象 entity が欠ける・HA 不達・state が数値でない（"unavailable" 等）→ null（黙る）。
//   - IO 注入：fetch を opts で差し替え可能（テストで実 HA を叩かない・ha.js 経由）。
//   - 依存ゼロ：グローバル fetch のみ（SDK なし。humidity/home-assistant と同じ方針）。
//
// 型：**片側しきい値（below=false＝大きいほど悪い）**。湿度（両側＝真ん中が幸せ）と違い CO2 は「低すぎて困る」が
// 無い（外気 ~420ppm 以下にならず低い分には害なし）＝thermal/nic/trash と同系。閾値の既定は **1000ppm**
// （建築物衛生法・学校環境衛生基準の室内目安）。戻し閾値は -200ppm（800ppm で「換気できたな」）。
// CO2 は息がかかると一瞬跳ねるのでデバウンス 2（連続して見て確定）。判定は共有部品 hysteresis.js に委ねる。
// env：TZ_HASS_URL ＋ TZ_HASS_TOKEN（在席/湿度と共有）＋ TZ_HASS_CO2（対象 entity 例 sensor.living_co2）。
// 閾値は TZ_CO2_HIGH（既定 1000）で変えられる。

import { makeHassReader } from './ha.js';
import { makeThreshold } from './hysteresis.js';

const HIGH = 1000;   // この ppm を超え続けたら「こもってる」とみなす（建築物衛生法の室内目安）
const MARGIN = 200;  // 戻し閾値の余裕（ヒステリシス幅・800ppm で回復）
const DEBOUNCE = 2;  // 何回連続で確定するか（息がかかった瞬間のスパイクで騒がない）

// env / opts を見て connector を作る。HA の前提が欠ければ null（＝オフ＝PE）。
// opts.fetch / opts.url / opts.token / opts.entity / opts.high / opts.env はテスト・直接指定用。
export function createCo2(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const read = makeHassReader(opts, 'TZ_HASS_CO2');
  if (!read) return null; // 接続先・認証・対象・fetch のどれかが欠けた → connector オフ（PE）

  const high = Number(opts.high ?? e.TZ_CO2_HIGH ?? HIGH);
  // 大きいほど警戒（below=false）：v>high で warn、v<high-MARGIN で ok。スパイク弾きにデバウンス。接続ごとに独立。
  const th = makeThreshold({ low: high - MARGIN, high, below: false, debounce: DEBOUNCE });

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      const ppm = Number(st.state);
      if (!Number.isFinite(ppm)) return null; // "unavailable"/"unknown" 等 → 黙る
      const ev = th.feed(ppm); // 'enter'（こもった）/ 'exit'（換気できた）/ null
      if (!ev) return null;
      return { situation: ev === 'enter' ? 'co2.stuffy' : 'co2.ok', ctx: { ppm: Math.round(ppm) } };
    },
  };
}
