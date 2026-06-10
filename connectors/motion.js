// Motion 入力コネクタ（人感センサで部屋の占有/空き＝present↔empty）。connectors の「入力」役。
// HA の motion binary_sensor を読むが、**生の on/off をそのまま喋らない**——PIR は人が居ても点いたり消えたり
// チャタるので、垂れ流すと五月蝿い。そこで「動きを最後に見た時刻」を時計で測り、**一定時間動きが無ければ
// 空、動きが戻れば占有**という滞留タイムアウトで二状態に均す。型としては home-assistant（二値遷移）と
// resume（時計だけ）の**合成**——状態は HA の binary_sensor から、空き判定は経過時間から。
//   motion.js   … HA motion binary_sensor の on/off ＋ poll の実時計で占有/空きを判定
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（motion.present＝来た / motion.empty＝静かになった。LLM は ctx.what / ctx.quietMin）
//
// 設計（イベント源パターンの三点・home-assistant / resume と同型）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：URL/トークン/対象 entity が欠ける・HA 不達・state が文字列でない → null（黙る）。
//   - IO 注入：fetch（ha.js）と時計（opts.now）を差し替え可能（テストで実 HA・実時計を使わない）。
//   - 依存ゼロ：グローバル fetch のみ（SDK なし。他の HA 入力と同じ方針）。
//
// 在席（home-assistant＝person/device_tracker の home/not_home）や activity（host の idle）とは別の角度＝
// **部屋単位の人感**。三つは出自が違う（HA の人物状態／host の入力 idle／HA の PIR）が、どれも「居る/居ない」を
// 別の蛇口から拾う。'on'＝動き検知／'off'＝なし。空き判定は TZ_MOTION_EMPTY_S（既定 600 秒＝10 分）。
// env：TZ_HASS_URL ＋ TZ_HASS_TOKEN（他の HA 入力と共有）＋ TZ_HASS_MOTION（対象 entity 例 binary_sensor.living_motion）。

import { makeHassReader } from './ha.js';

const EMPTY_S = 600; // この秒数だけ動きが無ければ「部屋が空いた」とみなす

// env / opts を見て connector を作る。HA の前提が欠ければ null（＝オフ＝PE）。
// opts.fetch / opts.url / opts.token / opts.entity / opts.now / opts.emptyS / opts.env はテスト・直接指定用。
export function createMotion(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const now = opts.now || Date.now;
  const read = makeHassReader(opts, 'TZ_HASS_MOTION');
  if (!read || typeof now !== 'function') return null;
  const emptyMs = Number(opts.emptyS ?? e.TZ_MOTION_EMPTY_S ?? EMPTY_S) * 1000;

  let occ = null;      // 'present' | 'empty'（null＝未確定＝初回前）。接続ごとに独立
  let lastSeen = null; // 最後に動きを見た時刻（空き判定の基準）

  return {
    async poll() {
      const st = await read();
      if (!st) return null;
      const motion = st.state === 'on';
      const what = st.attributes && st.attributes.friendly_name;
      const t = now();
      if (motion) lastSeen = t;

      if (occ == null) { occ = motion ? 'present' : 'empty'; return null; } // 初回は基準だけ

      if (motion) {
        if (occ === 'empty') { occ = 'present'; return { situation: 'motion.present', ctx: what ? { what } : undefined }; }
        return null; // 既に占有中・動き継続（チャタ含む）→ 黙る
      }
      // 動き無し：占有中で、最後の動きから空き時間を超えたら「空いた」
      if (occ === 'present' && lastSeen != null && (t - lastSeen) >= emptyMs) {
        occ = 'empty';
        return { situation: 'motion.empty', ctx: { quietMin: Math.round((t - lastSeen) / 60000) } };
      }
      return null;
    },
  };
}
