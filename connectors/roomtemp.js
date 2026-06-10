// RoomTemp 入力コネクタ（室温の快適帯＝寒すぎ/暑すぎ/快適）。connectors の「入力」役。
// humidity（湿度）・co2（CO2）と並ぶ **HA が唯一くれる「部屋の中」** の三本目。Open-Meteo の外気温では
// 知れない「いま居る部屋の」体感——暖房/冷房をつけ忘れて寒い・暑い、を同居人が気づいて一言。
//   roomtemp.js … HA の温度 sensor の state（℃）を読む（REST・ha.js 共有）＋快適帯判定
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（roomtemp.cold / roomtemp.hot / roomtemp.ok。LLM は ctx.tempC を織り込む）
//
// 設計（イベント源パターンの三点・humidity と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：URL/トークン/対象 entity が欠ける・HA 不達・state が数値でない（"unavailable" 等）→ null（黙る）。
//   - IO 注入：fetch を opts で差し替え可能（テストで実 HA を叩かない・ha.js 経由）。
//   - 依存ゼロ：グローバル fetch のみ（SDK なし。humidity/co2/home-assistant と同じ方針）。
//
// 型：**両側しきい値（快適帯）の二例目**＝湿度に続く「真ん中が幸せ」。寒すぎも暑すぎも警戒し、快適帯
// [low,high] の中は黙る（makeBand）。CO2（片側 below=false）とは違い室温は両端に害がある＝湿度と同型。
// 既定の帯は **18〜28℃**（建築物衛生法/事務所衛生基準規則の室内温度の目安・CO2 の 1000ppm と同じ流儀）。
// env：TZ_HASS_URL ＋ TZ_HASS_TOKEN（在席/湿度/CO2 と共有）＋ TZ_HASS_TEMP（対象 entity 例 sensor.living_temp）。
// 快適帯は TZ_ROOMTEMP_LOW（既定 18）／TZ_ROOMTEMP_HIGH（既定 28）。margin 固定 1℃・debounce 2（センサのジャギ弾き）。
//
// 命名：屋外天気の weather.hot/weather.cold（Open-Meteo）・CPU の temp.hot（thermal）とは**別の身体**なので
// roomtemp.* で名前空間を分ける（「外は寒いが部屋は暑い」が両立する＝別の situation として共存する）。

import { makeHassReader } from './ha.js';
import { makeBand } from './hysteresis.js';

const LOW = 18, HIGH = 28, MARGIN = 1, DEBOUNCE = 2;
// 快適帯の三状態を situation に写す（low=寒い・high=暑い・ok=快適に復帰）。
const SIT = { low: 'roomtemp.cold', high: 'roomtemp.hot', ok: 'roomtemp.ok' };

// env / opts を見て connector を作る。HA の前提が欠ければ null（＝オフ＝PE）。
// opts.fetch / opts.url / opts.token / opts.entity / opts.low / opts.high / opts.env はテスト・直接指定用。
export function createRoomTemp(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const read = makeHassReader(opts, 'TZ_HASS_TEMP');
  if (!read) return null; // 接続先・認証・対象・fetch のどれかが欠けた → connector オフ（PE）

  const low = Number(opts.low ?? e.TZ_ROOMTEMP_LOW ?? LOW);
  const high = Number(opts.high ?? e.TZ_ROOMTEMP_HIGH ?? HIGH);
  const band = makeBand({ low, high, margin: MARGIN, debounce: DEBOUNCE }); // 接続ごとに独立

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      const t = Number(st.state);
      if (!Number.isFinite(t)) return null; // "unavailable"/"unknown" 等 → 黙る
      const ev = band.feed(t); // 'low' | 'ok' | 'high' | null（確定遷移だけ）
      if (!ev) return null;
      return { situation: SIT[ev], ctx: { tempC: Math.round(t * 10) / 10 } };
    },
  };
}
