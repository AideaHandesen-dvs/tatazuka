// Power 入力コネクタ（消費電力の high↔ok＝「結構電気使ってるな／つけっぱなしじゃないか」）。connectors の「入力」役。
// HA の電力 sensor（W）を読む。型は **片側 below=false（大きいほど警戒）**＝co2/nic/thermal と同系。
// 全体計（家全体）に向ければ「今どれだけ食ってるか」、スマートプラグ（個別機器）に向ければ「その家電つけっぱ」を
// 拾える——どちらに向けるかと閾値は env で選ぶ（PE）。家計・省エネを気にする同居人ムーブ。
//   power.js    … HA の power sensor の state（W）を読む（REST・ha.js 共有）＋しきい値検知
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（power.high / power.ok。LLM は ctx.watts を織り込む）
//
// 設計（イベント源パターンの三点・co2 と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：URL/トークン/対象 entity が欠ける・HA 不達・state が数値でない → null（黙る）。
//   - IO 注入：fetch を opts で差し替え可能（テストで実 HA を叩かない・ha.js 経由）。
//   - 依存ゼロ：グローバル fetch のみ（SDK なし。他の HA 入力と同じ方針）。
//
// `TZ_POWER_HIGH`（既定 500W）を超え続けると `power.high`、戻し閾値（-100W＝400W）を下回ると `power.ok`。
// 電子レンジ・ケトル等で一瞬跳ねるのでデバウンス 3（連続して見て確定＝瞬間負荷で騒がない）。判定は hysteresis.js。
// 既定 500W は「全体計で何かそこそこ動いてる」目安——個別プラグなら TZ_POWER_HIGH を機器に合わせて下げる。
// env：TZ_HASS_URL ＋ TZ_HASS_TOKEN（他の HA 入力と共有）＋ TZ_HASS_POWER（対象 entity 例 sensor.home_power）。
//
// 限界（正直に）：これは「今この瞬間の大きさ」のしきい値で、「つけっぱ（長時間 ON）」は持続時間を見ていない。
// 在席と突き合わせた「留守なのに高い＝消し忘れ」までやるなら将来の合成（uptime のような時計型）を足す。

import { makeHassReader } from './ha.js';
import { makeThreshold } from './hysteresis.js';

const HIGH = 500;    // この W を超え続けたら「結構使ってる」とみなす
const MARGIN = 100;  // 戻し閾値の余裕（ヒステリシス幅・400W で回復）
const DEBOUNCE = 3;  // 何回連続で確定するか（レンジ/ケトルの瞬間負荷で騒がない）

// env / opts を見て connector を作る。HA の前提が欠ければ null（＝オフ＝PE）。
// opts.fetch / opts.url / opts.token / opts.entity / opts.high / opts.env はテスト・直接指定用。
export function createPower(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const read = makeHassReader(opts, 'TZ_HASS_POWER');
  if (!read) return null; // 接続先・認証・対象・fetch のどれかが欠けた → connector オフ（PE）

  const high = Number(opts.high ?? e.TZ_POWER_HIGH ?? HIGH);
  // 大きいほど警戒（below=false）：v>high で warn、v<high-MARGIN で ok。スパイク弾きにデバウンス。接続ごとに独立。
  const th = makeThreshold({ low: high - MARGIN, high, below: false, debounce: DEBOUNCE });

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      const watts = Number(st.state);
      if (!Number.isFinite(watts)) return null; // "unavailable"/"unknown" 等 → 黙る
      const ev = th.feed(watts); // 'enter'（増えた）/ 'exit'（落ち着いた）/ null
      if (!ev) return null;
      return { situation: ev === 'enter' ? 'power.high' : 'power.ok', ctx: { watts: Math.round(watts) } };
    },
  };
}
