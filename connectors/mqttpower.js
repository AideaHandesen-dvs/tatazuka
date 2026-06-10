// MqttPower 入力コネクタ（MQTT の電力トピック＝消費電力の high↔ok）。connectors の「入力」役・**非 HA 入力源の二例目**。
// 観察の中身は power.js と同じ「結構電気使ってるな／つけっぱなしじゃないか」だが、値の出どころが HA REST ではなく
// **MQTT ブローカー**（Mosquitto 等に直結）。＝mqtttemp（温度）に続く「既存の観察型の別トランスポート」の二本目で、
// 今度は **判定型が違う**のが肝：mqtttemp が両側帯（makeBand）を運んだのに対し、こちらは **片側しきい値（makeThreshold・
// below=false）**＝MQTT トランスポートが「判定型に依らない単なる運び屋」だと別の型で示す。判定（makeThreshold）も
// persona（power.*）も ctx（watts）も**丸ごと power と共有**し、違うのは「どこから値を取るか（mqtt.js の read ＋ pick）」だけ。
//   mqttpower.js … 共有 MQTT クライアントの topic を購読し、毎 poll で最新 payload → pick → しきい値検知
//   behavior.js  … いつ拾うか（sources の一員として毎 tick poll・HA か MQTT かは知らない）
//   persona.*    … 何を喋るか（power.high / power.ok＝power と同じタグを再利用・LLM は ctx.watts を織り込む）
//
// 設計（イベント源パターンの三点・power と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。しかも power と同じタグ＝persona も無改修。
//   - PE：共有クライアント未注入／topic 未設定／payload 未着・壊れ・非数値 → null（黙る）。
//   - IO 注入：MQTT クライアントは opts.client で注入（テストは fake client・実ブローカー不要）。**socket は serve.js が
//     一つだけ作って全セッションに配る**（トランスポートは共有・しきい値の状態 th は接続ごと独立）。
//
// 値の取り出し（センサごとの変動を吸収する一点）＝pick(payload, path)：生の数値そのまま／JSON の "power"／
// ネストの "ENERGY.Power"（Tasmota スマートプラグの代表形）等を env で選ぶ。閾値・margin・debounce は power と同一。
// env：TZ_MQTT_URL（ブローカー・mqtt.js が見る）＋ TZ_MQTT_POWER（対象 topic 例 tele/plug/SENSOR）＋
//   任意 TZ_MQTT_POWER_PATH（取り出しパス・既定は生値／Tasmota は ENERGY.Power）。
//   閾値は power と共有：TZ_POWER_HIGH（既定 500W・個別プラグなら機器に合わせて下げる）。

import { makeThreshold } from './hysteresis.js';
import { pick } from './mqtt.js';

const HIGH = 500;    // この W を超え続けたら「結構使ってる」とみなす（power.js と同じ既定）
const MARGIN = 100;  // 戻し閾値の余裕（ヒステリシス幅・400W で回復）
const DEBOUNCE = 3;  // 何回連続で確定するか（レンジ/ケトルの瞬間負荷で騒がない）

// env / opts を見て connector を作る。クライアント or topic が欠ければ null（＝オフ＝PE）。
// opts.client（共有 MQTT クライアント）/ opts.topic / opts.path / opts.high / opts.env はテスト・直接指定用。
export function createMqttPower(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const client = opts.client;                          // serve.js が一つ作って注入する共有クライアント
  const topic = opts.topic || e.TZ_MQTT_POWER;
  if (!client || !topic) return null;                  // クライアント未注入 or topic 未設定 → オフ（PE）
  const path = opts.path ?? e.TZ_MQTT_POWER_PATH ?? ''; // payload 取り出しパス（既定：生値）

  client.subscribe(topic);                             // 購読は冪等（Set）＝接続ごとに呼んでも安全
  const high = Number(opts.high ?? e.TZ_POWER_HIGH ?? HIGH);
  // 大きいほど警戒（below=false）：v>high で warn、v<high-MARGIN で ok。スパイク弾きにデバウンス。接続ごとに独立。
  const th = makeThreshold({ low: high - MARGIN, high, below: false, debounce: DEBOUNCE });

  return {
    async poll() {
      const watts = Number(pick(client.read(topic), path));
      if (!Number.isFinite(watts)) return null;        // 未着・壊れ・非数値 → 黙る（PE）
      const ev = th.feed(watts); // 'enter'（増えた）/ 'exit'（落ち着いた）/ null
      if (!ev) return null;
      return { situation: ev === 'enter' ? 'power.high' : 'power.ok', ctx: { watts: Math.round(watts) } };
    },
  };
}
