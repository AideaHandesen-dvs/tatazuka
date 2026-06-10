// MqttHumidity 入力コネクタ（MQTT の湿度トピック＝室内湿度の快適帯）。connectors の「入力」役・**非 HA 入力源の三例目**。
// 観察の中身は humidity.js と同じ「乾燥/じめじめ/快適」だが、値の出どころが HA REST ではなく **MQTT ブローカー**。
// ＝mqtttemp（温度・両側帯）/ mqttpower（電力・片側しきい値）に続く「既存型の別トランスポート」の三本目で、
// 判定型としては mqtttemp と同じ**両側帯（makeBand）**だが「室温」でなく「湿度」＝同じ band を意味づけだけ変えて
// 使い回す（humidity.js が HA REST で roomtemp と band を共有したのと同じ構図を、MQTT トランスポートでも示す）。
// 判定（makeBand）も persona（humidity.*）も ctx（pct）も**丸ごと humidity と共有**し、違うのは「どこから値を取るか
// （mqtt.js の read ＋ pick）」だけ。HA を立てていない人でも安物温湿度センサ（Tasmota/ESPHome/Zigbee2MQTT…）で佇かが反応する。
//   mqtthumidity.js … 共有 MQTT クライアントの topic を購読し、毎 poll で最新 payload → pick → 快適帯判定
//   behavior.js     … いつ拾うか（sources の一員として毎 tick poll・HA か MQTT かは知らない）
//   persona.*       … 何を喋るか（humidity.dry / humidity.humid / humidity.ok＝humidity と同じタグを再利用）
//
// 設計（イベント源パターンの三点・mqtttemp と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。しかも humidity と同じタグ＝persona も無改修。
//   - PE：共有クライアント未注入／topic 未設定／payload 未着・壊れ・非数値 → null（黙る）。
//   - IO 注入：MQTT クライアントは opts.client で注入（テストは fake client・実ブローカー不要）。**socket は serve.js が
//     一つだけ作って全セッションに配る**（トランスポートは共有・快適帯の状態 band は接続ごと独立）。
//
// 値の取り出し（センサごとの変動を吸収する一点）＝pick(payload, path)：生の数値そのまま／JSON の "humidity"／
// ネストの "AM2301.Humidity"（Tasmota 温湿度センサの代表形）等を env で選ぶ。閾値・帯・margin・debounce は humidity と同一。
// env：TZ_MQTT_URL（ブローカー・mqtt.js が見る）＋ TZ_MQTT_HUMIDITY（対象 topic）＋
//   任意 TZ_MQTT_HUMIDITY_PATH（取り出しパス・既定は生値）。快適帯は humidity と共有：TZ_HUMIDITY_LOW（既定 40）／TZ_HUMIDITY_HIGH（既定 60）。

import { makeBand } from './hysteresis.js';
import { pick } from './mqtt.js';

const LOW = 40, HIGH = 60, MARGIN = 5, DEBOUNCE = 2;
// 快適帯の三状態を situation に写す（humidity.js と完全に同じ＝同じ観察の別トランスポート）。
const SIT = { low: 'humidity.dry', high: 'humidity.humid', ok: 'humidity.ok' };

// env / opts を見て connector を作る。クライアント or topic が欠ければ null（＝オフ＝PE）。
// opts.client（共有 MQTT クライアント）/ opts.topic / opts.path / opts.low / opts.high / opts.env はテスト・直接指定用。
export function createMqttHumidity(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const client = opts.client;                          // serve.js が一つ作って注入する共有クライアント
  const topic = opts.topic || e.TZ_MQTT_HUMIDITY;
  if (!client || !topic) return null;                  // クライアント未注入 or topic 未設定 → オフ（PE）
  const path = opts.path ?? e.TZ_MQTT_HUMIDITY_PATH ?? ''; // payload 取り出しパス（既定：生値）

  client.subscribe(topic);                             // 購読は冪等（Set）＝接続ごとに呼んでも安全
  const low = Number(opts.low ?? e.TZ_HUMIDITY_LOW ?? LOW);
  const high = Number(opts.high ?? e.TZ_HUMIDITY_HIGH ?? HIGH);
  const band = makeBand({ low, high, margin: MARGIN, debounce: DEBOUNCE }); // 接続ごとに独立

  return {
    async poll() {
      const pct = Number(pick(client.read(topic), path));
      if (!Number.isFinite(pct)) return null;          // 未着・壊れ・非数値 → 黙る（PE）
      const ev = band.feed(pct); // 'low' | 'ok' | 'high' | null（確定遷移だけ）
      if (!ev) return null;
      return { situation: SIT[ev], ctx: { pct: Math.round(pct) } };
    },
  };
}
