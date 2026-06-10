// Home Assistant 入力コネクタ（在宅/外出）。connectors の「入力」役の初例。
// イベント源パターン（README §6-4 / connectors/README.md §3-1）：外の出来事 → situation → 人格層。
//   home-assistant.js … HA の person/device_tracker の状態を読む（REST・トークン認証）＋変化検知
//   behavior.js       … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*         … 何を喋るか（home.back / home.away タグ。LLM は ctx.who を織り込む）
//
// 設計（イベント源パターンの三点・weather/activity と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：接続先 URL／トークン／対象 entity が無い・HA が落ちている → null（黙る）。佇かは喋る。
//   - IO 注入：fetch を opts で差し替え可能（テストで実 HA を叩かない）。
//   - 依存ゼロ：グローバル fetch のみ（SDK なし。weather と同じ方針）。
//
// 監視対象は person.* / device_tracker.*。状態は home / not_home / ゾーン名（"Work" 等）を取り得る。
// home 以外はすべて「外出」とみなす＝ゾーン間移動（not_home→Work）は外出のままなので発話しない。
// 複数 entity・ドア/照明などへの拡張は situation を足す形で（この型を増やす）。HA の sensor.*（数値）を
// 読む拡張は humidity.js（室内湿度の快適帯）が初例＝REST の読みは ha.js に共有して各 connector に分けた。

import { makeHassReader } from './ha.js';

const HOME = 'home'; // HA の在宅状態。これ以外は外出扱い

// env / opts を見て connector を作る。前提が欠ければ null（＝この connector はオフ＝PE）。
// opts.fetch / opts.url / opts.token / opts.entity / opts.env はテスト・直接指定用。
// HA REST の読み（認証・URL・PE）は ha.js に共有（humidity.js と分け合う）。対象は TZ_HASS_PERSON。
export function createHomeAssistant(opts) {
  const read = makeHassReader(opts, 'TZ_HASS_PERSON');
  if (!read) return null; // 接続先・認証・対象・fetch のどれかが欠けた → connector オフ（PE）

  let primed = false;
  let wasHome;  // 直前の在宅状態（遷移検知の状態。接続ごとに独立＝各端末が反応）

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      const home = st.state === HOME;
      const who = st.attributes && st.attributes.friendly_name;
      if (!primed) { primed = true; wasHome = home; return null; } // 初回は基準だけ（遷移と誤検知しない）
      if (home === wasHome) return null;                            // 無変化（ゾーン間移動を含む）
      wasHome = home;
      return { situation: home ? 'home.back' : 'home.away', ctx: who ? { who } : undefined };
    },
  };
}
