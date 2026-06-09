// Resume 入力コネクタ（スリープ/離脱からの復帰＝「おかえり、寝てたか?」）。connectors の「入力」役・readonly。
// これは family で**いちばん軽い**——ファイルも /sys も読まない。毎 tick の poll が呼ばれる**間隔そのもの**を
// 時計で測り、想定 tick よりずっと長い空白があれば「その間サーバ（＝PC）が止まっていた＝スリープ」と見なす。
// フタを閉じ開けする人全員に「おかえり」の瞬間が出る。activity（idle で離席/復帰）が「起きてるのに席を立った」
// のに対し、こちらは「**マシンごと寝ていた**」——idle では捉えられない領域（プロセスが止まる）を埋める。
//   resume.js   … poll 呼び出しの実時計間隔を測る（IO なし・時計だけ）
//   behavior.js … いつ拾うか（sources の一員として毎 tick poll）
//   persona.*   … 何を喋るか（resume.back。LLM は ctx.gapMin＝空白の長さ[分]を織り込む）
//
// 設計（イベント源パターンの三点・nic と同型の時計注入）：
//   - protocol は不変。say（situation タグ）に乗るだけ＝client は無改修。
//   - PE：TZ_RESUME が未設定なら null（黙る）。佇かは他の理由で喋る。
//   - IO 注入：時計を opts.now で差し替え可能（テストで実時計・実スリープを使わない）。
//   - 依存ゼロ：node 標準すら不要（Date.now のみ）。読むものが無い＝soft の極北（観察すらしない・時間だけ）。
//
// 判定：前回 poll からの経過が TZ_RESUME_GAP_S（既定 180 秒）を超えたら復帰とみなす。tick は 30 秒程度なので、
// 3 分の空白は「処理が詰まった」では説明しづらく、サスペンド/休止が現実的な原因。閾値は余裕を持たせて誤発火を避ける。

const GAP_S = 180; // この秒数を超える poll 間隔の空白を「寝ていた」とみなす

// env / opts を見て connector を作る。TZ_RESUME が未設定なら null（＝オフ＝PE）。
// opts.now / opts.gapS / opts.env はテスト・直接指定用。
export function createResume(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const now = opts.now || Date.now;

  if (!e.TZ_RESUME || typeof now !== 'function') return null;
  const gapMs = Number(opts.gapS ?? e.TZ_RESUME_GAP_S ?? GAP_S) * 1000;

  let last = null; // 前回 poll の時刻（接続ごとに独立）

  return {
    async poll() {
      const t = now();
      if (last == null) { last = t; return null; } // 初回は基準だけ（起動直後に「おかえり」は言わない）
      const gap = t - last;
      last = t;
      if (gap <= gapMs) return null; // 通常の tick 間隔 → 黙る
      // 想定より長い空白＝マシンが止まっていた。空白の長さを分で添える（「2 時間ぶりだな」のように）。
      return { situation: 'resume.back', ctx: { gapMin: Math.round(gap / 60000) } };
    },
  };
}
