// AwayPower 合成コネクタ（留守 × 高電力 ＝「消し忘れ」）。connectors の「入力」役・**合成型の二例目**。
// 単一センサのしきい値ではなく、**二つの HA 蛇口を時計で突き合わせる**——在席（person/device_tracker の
// home/not_home）が「留守」で、かつ消費電力（power sensor の W）が「高い」状態が一定時間続いたら、
// 「誰もいないのに電気食ってる＝消し忘れじゃないか」と気遣う。家計・省エネ・火の元を見る同居人ムーブ。
//   awaypower.js … 在席 reader と電力 reader を二本作り、両方を毎 poll で読んで合成判定
//   behavior.js  … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*    … 何を喋るか（power.forgotten。LLM は ctx.watts / ctx.awayMin を織り込む）
//
// 合成型としての位置づけ（README §6-4・motion に続く二例目）：
//   - motion は「二値 × 時計」（一つの entity ＋経過時間）。これは「二値（留守）× しきい値（電力）× 時計（滞留）」
//     ＝**二つの entity を AND で噛み合わせる**ぶん一段上の合成。新しい判定抽象は足していない（既存部品の組合せ）。
//   - power.js が自分で名指しした将来像そのもの（あちらは「今この瞬間の大きさ」だけ＝留守との合成は見ていない）。
//
// 設計（イベント源パターンの三点・motion と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：URL/トークン／在席 entity／電力 entity のどれかが欠ける・HA 不達・電力が数値でない → null（黙る）。
//     ＝在席（TZ_HASS_PERSON）と電力（TZ_HASS_POWER）の両方が揃った人にだけ自然に生える（追加 env ゼロで効く）。
//   - IO 注入：fetch（ha.js）と時計（opts.now）を差し替え可能（テストで実 HA・実時計を使わない）。
//
// 判定：留守（在席 state が 'home' でない＝not_home／ゾーン名）かつ 電力 ≥ TZ_AWAY_HIGH（既定 300W）が
//   TZ_AWAY_DWELL_S（既定 900 秒＝15 分）続いたら **一度だけ** power.forgotten。帰宅 or 電力が落ちたら解消＝再武装
//   （次の消し忘れでまた言える）。dwell が「ちょっと出ただけ」「レンジの一瞬」を自然に弾く＝デバウンス不要。
//   既定 300W は冷蔵庫の待機（〜150W）に何か一つ乗った目安——全体計か個別プラグかで TZ_AWAY_HIGH を合わせる。
// env：TZ_HASS_URL ＋ TZ_HASS_TOKEN（他の HA 入力と共有）＋ TZ_HASS_PERSON（在席）＋ TZ_HASS_POWER（電力）。

import { makeHassReader } from './ha.js';

const HIGH = 300;      // 留守中にこの W を超え続けたら「消し忘れ」候補（冷蔵庫待機＋α の目安）
const DWELL_S = 900;   // 留守 × 高電力がこの秒数続いて初めて警告（一瞬の外出/スパイクで騒がない）

// env / opts を見て connector を作る。在席・電力どちらかの前提が欠ければ null（＝オフ＝PE）。
// opts.fetch / opts.url / opts.token / opts.occEntity / opts.powEntity / opts.now / opts.high / opts.dwellS / opts.env は
// テスト・直接指定用。在席と電力で entity が違うので、各 reader に個別の entity を渡せるようにする。
export function createAwayPower(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const now = opts.now || Date.now;
  // 二本の蛇口。occEntity/powEntity 未指定なら makeHassReader が env（PERSON/POWER）に落ちる。
  const readOcc = makeHassReader({ ...opts, entity: opts.occEntity }, 'TZ_HASS_PERSON');
  const readPow = makeHassReader({ ...opts, entity: opts.powEntity }, 'TZ_HASS_POWER');
  if (!readOcc || !readPow || typeof now !== 'function') return null;

  const high = Number(opts.high ?? e.TZ_AWAY_HIGH ?? HIGH);
  const dwellMs = Number(opts.dwellS ?? e.TZ_AWAY_DWELL_S ?? DWELL_S) * 1000;

  let since = null;    // 留守×高電力が始まった時刻（null＝条件不成立）。接続ごとに独立
  let latched = false; // 既に警告を出したか（解消まで黙る＝鳴りっぱなしにしない）

  return {
    async poll() {
      const [occ, pow] = await Promise.all([readOcc(), readPow()]);
      if (!occ || !pow) return null;             // どちらか読めない → 黙る（PE）
      const away = occ.state !== 'home';         // not_home／ゾーン名 = 留守。'home' だけが在宅
      const watts = Number(pow.state);
      if (!Number.isFinite(watts)) return null;  // "unavailable"/"unknown" 等 → 黙る（PE）
      const t = now();

      if (away && watts >= high) {
        if (since == null) since = t;            // 条件成立の起点を刻む
        if (!latched && (t - since) >= dwellMs) { // dwell を超えて初めて警告（一度だけ）
          latched = true;
          return { situation: 'power.forgotten', ctx: { watts: Math.round(watts), awayMin: Math.round((t - since) / 60000) } };
        }
        return null;                             // まだ dwell 未満／既に警告済み → 黙る
      }
      // 帰宅した or 電力が落ちた → 消し忘れ解消。再武装して次に備える
      since = null;
      latched = false;
      return null;
    },
  };
}
