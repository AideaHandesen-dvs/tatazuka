// Humidity 入力コネクタ（室内湿度の快適帯＝乾燥/じめじめ/快適）。connectors の「入力」役。
// home-assistant.js（在席）が HA を入力に使う初例なら、こちらは **HA が唯一くれる「部屋の中」**——
// Open-Meteo の外気では原理的に知れない室内環境。同居人が気づくのは外の予報でなく「この部屋、乾いてるぞ
// （喉/肌/風邪）」「じめじめだな（カビ/不快）」の方。温湿度センサは HA で最も安く普及したカテゴリなので、
// HA 持ちには案外刺さる readonly。持っていなければ黙る（PE）＝センサが有る前提で設計しない（PE は背骨）。
//   humidity.js … HA の湿度 sensor の state（%）を読む（REST・ha.js 共有）＋快適帯判定
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（humidity.dry / humidity.humid / humidity.ok。LLM は ctx.pct を織り込む）
//
// 設計（イベント源パターンの三点・home-assistant と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：URL/トークン/対象 entity が欠ける・HA 不達・state が数値でない（"unavailable" 等）→ null（黙る）。
//   - IO 注入：fetch を opts で差し替え可能（テストで実 HA を叩かない・ha.js 経由）。
//   - 依存ゼロ：グローバル fetch のみ（SDK なし。weather/home-assistant と同じ方針）。
//
// 型：**両側しきい値（快適帯）の初例**＝「真ん中が幸せ」。低すぎ（乾燥）も高すぎ（じめじめ）も警戒し、
// 快適帯 [low,high] の中は黙る（makeBand）。disk/battery が片側だったのに対する新型で、室温や CO2 にも
// そのまま再利用できる。env：TZ_HASS_URL ＋ TZ_HASS_TOKEN（home-assistant と共有）＋ TZ_HASS_HUMIDITY
// （対象 entity 例 sensor.living_humidity）。快適帯は TZ_HUMIDITY_LOW（既定 40）／TZ_HUMIDITY_HIGH（既定 60）。
// margin は固定 5（縁のチャタ吸収）・debounce 2（センサのジャギを弾く・温度より動きはゆっくりだが安全側）。

import { makeHassReader } from './ha.js';
import { makeBand } from './hysteresis.js';

const LOW = 40, HIGH = 60, MARGIN = 5, DEBOUNCE = 2;
// 快適帯の三状態を situation に写す（low=乾燥・high=じめじめ・ok=快適に復帰）。
const SIT = { low: 'humidity.dry', high: 'humidity.humid', ok: 'humidity.ok' };

// env / opts を見て connector を作る。HA の前提が欠ければ null（＝オフ＝PE）。
// opts.fetch / opts.url / opts.token / opts.entity / opts.low / opts.high / opts.env はテスト・直接指定用。
export function createHumidity(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const read = makeHassReader(opts, 'TZ_HASS_HUMIDITY');
  if (!read) return null; // 接続先・認証・対象・fetch のどれかが欠けた → connector オフ（PE）

  const low = Number(opts.low ?? e.TZ_HUMIDITY_LOW ?? LOW);
  const high = Number(opts.high ?? e.TZ_HUMIDITY_HIGH ?? HIGH);
  const band = makeBand({ low, high, margin: MARGIN, debounce: DEBOUNCE }); // 接続ごとに独立

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      const pct = Number(st.state);
      if (!Number.isFinite(pct)) return null; // "unavailable"/"unknown" 等 → 黙る
      const ev = band.feed(pct); // 'low' | 'ok' | 'high' | null（確定遷移だけ）
      if (!ev) return null;
      return { situation: SIT[ev], ctx: { pct: Math.round(pct) } };
    },
  };
}
