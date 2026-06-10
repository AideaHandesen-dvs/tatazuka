// Uptime 入力コネクタ（連続稼働が長い＝「そろそろ再起動したら?」）。connectors の「入力」役・readonly。
// resume.js の**双子**——あちらは poll の空白で「マシンが寝ていた」を拾い、こちらは os.uptime() で「マシンが
// ずっと起きっぱなし（再起動していない）」を拾う。フタを開け閉めせず何日もつけっぱなしの人に「たまには休ませろ」。
// 家事ナッジ（trash と同じ「溜まったら促す」型）で、コンピュータを触る大多数に効く同居人ムーブ。
//   uptime.js   … os.uptime()（システム連続稼働秒）を読む（readonly・OS 正規化済みの数値一つ）
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（uptime.long。LLM は ctx.days／ctx.hours を織り込む）
//
// 設計（イベント源パターンの三点・trash / nic と同型の below=false しきい値）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：TZ_UPTIME が未設定なら null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：読み口を opts.uptime（秒を返す関数）で差し替え可能（テストで実時計を進めない）。
//   - 依存ゼロ：node 標準（os.uptime）のみ。読むのは固定の readonly 一点（soft を構造で守る・§7-1）。
//
// OS 別バックエンド（README §7-3）：os.uptime() は node が全 OS で秒に正規化済み＝**読み口が OS 無関係**。
// resume（時計のみ）/ git（git はどこでも git）/ download（標準パス）に並ぶ「既に OS 無関係」の四本目で、
// process.platform 分岐すら要らない（OS 固有口を読む /sys・/proc 群とはここが違う）。
//
// 単方向ナッジ（trash と違い回復遷移を出さない理由）：os.uptime() はプロセスの生存中は単調増加し、
// 「短くなる」のは再起動したときだけ。だが佇かは自動起動サービス（systemd/launchd/Task Scheduler）なので、
// マシンが再起動すれば佇か自身も再起動して状態がまっさらになる＝**回復（uptime.ok）は同一プロセス内では
// 起きない**。なので enter（長くなった）だけを uptime.long に写し、exit は黙って捨てる（persona に出ない
// 死にタグを増やさない）。makeThreshold の「初回は基準だけ」規律のおかげで、既に長稼働のマシンで佇かが
// 起動し直したときは warn を基準に取って黙る＝**再起動直後に説教しない**（これは欲しい挙動）。

import os from 'node:os';
import { makeThreshold } from './hysteresis.js';

const MAX_H = 168;   // この時間（既定 7 日）を超えて連続稼働していたら「そろそろ再起動したら?」
const MARGIN_H = 12; // 戻し閾値の余裕（ヒステリシス幅）。実際には exit を捨てるので名目だけ・帯の体裁を揃える

// env / opts を見て connector を作る。TZ_UPTIME が未設定なら null（＝オフ＝PE）。
// opts.uptime / opts.maxH / opts.env はテスト・直接指定用。
export function createUptime(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const uptime = opts.uptime || os.uptime; // 秒を返す関数（os.uptime は全 OS 正規化済み）

  if (!e.TZ_UPTIME || typeof uptime !== 'function') return null;
  const maxH = Number(opts.maxH ?? e.TZ_UPTIME_MAX_H ?? MAX_H);

  // 大きいほど警戒（below=false）：時間で h>maxH なら warn、h<maxH-MARGIN なら ok。連続稼働は
  // ゆっくり伸びる（trash と同じ）のでデバウンスは 1。回復は起きないので low は名目（帯の体裁のみ）。
  const th = makeThreshold({ low: Math.max(0, maxH - MARGIN_H), high: maxH, below: false, debounce: 1 });

  return {
    async poll() {
      let sec;
      try {
        sec = uptime();
      } catch {
        return null; // 読み口が投げた → 黙る
      }
      if (sec == null || !Number.isFinite(sec)) return null;
      const ev = th.feed(sec / 3600); // 時間で判定。'enter'（長くなった）/ 'exit'（回復）/ null
      if (ev !== 'enter') return null; // exit（回復）は捨てる＝単方向ナッジ（上のコメント参照）
      return {
        situation: 'uptime.long',
        ctx: { days: Math.floor(sec / 86400), hours: Math.round(sec / 3600) },
      };
    },
  };
}
