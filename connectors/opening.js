// Opening 入力コネクタ（ドア/窓の開閉＝open↔closed）。connectors の「入力」役。
// しきい値型の humidity/co2/roomtemp/illuminance（数値を読む）と違い、これは **二値遷移**——HA の
// binary_sensor（device_class door/window/opening）の on/off を読む。**在席 home-assistant.js と完全に同型**
// （状態文字列の遷移検知・初回基準・無変化は黙る）で、出自が「人物の在席」でなく「開口部の開閉」なだけ。
// 「窓開けっ放しだぞ（寒い/暑い/防犯）」「ドア開いてるぞ」を同居人が気づいて一言。
//   opening.js  … HA の binary_sensor の state（on=開 / off=閉）を読む（REST・ha.js 共有）＋遷移検知
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（opening.open / opening.closed。LLM は ctx.what＝対象名を織り込む）
//
// 設計（イベント源パターンの三点・home-assistant と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：URL/トークン/対象 entity が欠ける・HA 不達・state が文字列でない → null（黙る）。
//   - IO 注入：fetch を opts で差し替え可能（テストで実 HA を叩かない・ha.js 経由）。
//   - 依存ゼロ：グローバル fetch のみ（SDK なし。他の HA 入力と同じ方針）。
//
// HA の binary_sensor は **'on'＝開（検知あり）／'off'＝閉**。friendly_name があれば ctx.what に乗せ、LLM は
// 「リビングの窓、開いてるぞ」と呼べる（在席の ctx.who と同じ仕掛け）。対象は **開けっ放しが気になる開口部**
// （窓・ベランダ等）に向けるのが想定——玄関ドアのような頻繁に開閉するものに向けると賑やかになる（env で選ぶ＝PE）。
// env：TZ_HASS_URL ＋ TZ_HASS_TOKEN（他の HA 入力と共有）＋ TZ_HASS_OPENING（対象 entity 例 binary_sensor.living_window）。

import { makeHassReader } from './ha.js';

const OPEN = 'on'; // HA binary_sensor の開状態。'off' は閉

// env / opts を見て connector を作る。HA の前提が欠ければ null（＝オフ＝PE）。
// opts.fetch / opts.url / opts.token / opts.entity / opts.env はテスト・直接指定用。対象は TZ_HASS_OPENING。
export function createOpening(opts) {
  const read = makeHassReader(opts, 'TZ_HASS_OPENING');
  if (!read) return null; // 接続先・認証・対象・fetch のどれかが欠けた → connector オフ（PE）

  let primed = false;
  let wasOpen; // 直前の開閉状態（遷移検知の状態。接続ごとに独立＝各端末が反応）

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      const open = st.state === OPEN;
      const what = st.attributes && st.attributes.friendly_name;
      if (!primed) { primed = true; wasOpen = open; return null; } // 初回は基準だけ（遷移と誤検知しない）
      if (open === wasOpen) return null;                            // 無変化
      wasOpen = open;
      return { situation: open ? 'opening.open' : 'opening.closed', ctx: what ? { what } : undefined };
    },
  };
}
