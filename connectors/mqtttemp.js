// MqttTemp 入力コネクタ（MQTT の温度トピック＝室温の快適帯）。connectors の「入力」役・**非 HA 入力源の初例**。
// 観察の中身は roomtemp.js と同じ「部屋の温度の寒すぎ/暑すぎ/快適」だが、値の出どころが HA REST ではなく
// **MQTT ブローカー**（Mosquitto 等に直結）。＝MQTT は「新しい観察型」ではなく **既存の観察型の別トランスポート**
// という割り切りの実体：判定（makeBand）も persona（roomtemp.*）も ctx（tempC）も**丸ごと roomtemp と共有**し、
// 違うのは「どこから値を取るか（mqtt.js の read ＋ pick）」だけ。HA を立てていない人でも安物センサで佇かが反応する。
//   mqtttemp.js … 共有 MQTT クライアントの topic を購読し、毎 poll で最新 payload → pick → 快適帯判定
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll・HA か MQTT かは知らない）
//   persona.*   … 何を喋るか（roomtemp.cold / roomtemp.hot / roomtemp.ok＝roomtemp と同じタグを再利用）
//
// 設計（イベント源パターンの三点・roomtemp と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。しかも roomtemp と同じタグ＝persona も無改修。
//   - PE：共有クライアント未注入／topic 未設定／payload 未着・壊れ・非数値 → null（黙る）。
//   - IO 注入：MQTT クライアントは opts.client で注入（テストは fake client・実ブローカー不要）。**socket は serve.js が
//     一つだけ作って全セッションに配る**（トランスポートは共有・快適帯の状態 band は接続ごと独立）。
//
// 値の取り出し（センサごとの変動を吸収する一点）＝pick(payload, path)：生の数値そのまま／JSON の "temperature"／
// ネストの "ENERGY.Power" 等を env で選ぶ。閾値・帯・margin・debounce は roomtemp と同一（同じ観察だから）。
// env：TZ_MQTT_URL（ブローカー・mqtt.js が見る）＋ TZ_MQTT_TEMP（対象 topic）＋任意 TZ_MQTT_TEMP_PATH（取り出しパス・既定は生値）。
//   快適帯は roomtemp と共有：TZ_ROOMTEMP_LOW（既定 18）／TZ_ROOMTEMP_HIGH（既定 28）。

import { makeBand } from './hysteresis.js';
import { pick } from './mqtt.js';

const LOW = 18, HIGH = 28, MARGIN = 1, DEBOUNCE = 2;
// 快適帯の三状態を situation に写す（roomtemp.js と完全に同じ＝同じ観察の別トランスポート）。
const SIT = { low: 'roomtemp.cold', high: 'roomtemp.hot', ok: 'roomtemp.ok' };

// env / opts を見て connector を作る。クライアント or topic が欠ければ null（＝オフ＝PE）。
// opts.client（共有 MQTT クライアント）/ opts.topic / opts.path / opts.low / opts.high / opts.env はテスト・直接指定用。
export function createMqttTemp(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const client = opts.client;                          // serve.js が一つ作って注入する共有クライアント
  const topic = opts.topic || e.TZ_MQTT_TEMP;
  if (!client || !topic) return null;                  // クライアント未注入 or topic 未設定 → オフ（PE）
  const path = opts.path ?? e.TZ_MQTT_TEMP_PATH ?? ''; // payload 取り出しパス（既定：生値）

  client.subscribe(topic);                             // 購読は冪等（Set）＝接続ごとに呼んでも安全
  const low = Number(opts.low ?? e.TZ_ROOMTEMP_LOW ?? LOW);
  const high = Number(opts.high ?? e.TZ_ROOMTEMP_HIGH ?? HIGH);
  const band = makeBand({ low, high, margin: MARGIN, debounce: DEBOUNCE }); // 接続ごとに独立

  return {
    async poll() {
      const t = Number(pick(client.read(topic), path));
      if (!Number.isFinite(t)) return null;            // 未着・壊れ・非数値 → 黙る（PE）
      const ev = band.feed(t); // 'low' | 'ok' | 'high' | null（確定遷移だけ）
      if (!ev) return null;
      return { situation: SIT[ev], ctx: { tempC: Math.round(t * 10) / 10 } };
    },
  };
}
