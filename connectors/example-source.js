// 入力コネクタの契約テンプレ（イベント源パターン・README §6-4 / connectors/README.md §3-1）。
// これは「型」であって実統合ではない。コピーして read()/translate() を埋めれば実 connector になる
// （例：read = Home Assistant の REST を fetch、translate = entity の状態遷移 → situation）。
//
// weather.js / activity.js と同じ継ぎ目：
//   const src = createExampleSource({ read });   // 無効なら null（＝この source はオフ）
//   src.poll() → { situation, ctx? } | null      // behavior.js が tick で呼ぶ。無変化/読めなければ null
//
// 設計（イベント源パターンの三点）：
//   - protocol は不変。situation タグ（say）に乗るだけ＝client は触らない。
//   - PE：read が無い／読めない → 黙る（null）。佇かは他の理由で喋る。
//   - IO 注入：外部 IO（fetch・コマンド・時計）は opts で差し替え可能に＝実ネット/実機をテストに持ち込まない。
//   - 依存ゼロ：node 標準のみ。実 connector も SDK を入れずグローバル fetch 等で足す。

// opts.read   : async () => 外部の現在値（任意の型）| null。null は「今は読めない」＝この tick は黙る。
//               実 connector はここで env（URL/トークン等）を見て、未設定なら下の factory で null を返す。
// opts.translate(prev, cur) : 直前値と現在値から situation を決める。遷移が無ければ null（＝毎回は喋らない）。
//               既定は「値が変わった瞬間だけ {situation:'example.changed'} を出す」薄い実装。
export function createExampleSource(opts) {
  opts = opts || {};
  const read = opts.read;

  // PE：読み口が無ければ source 自体オフ（null）。behavior.js は触れない。
  // 実 connector はここを「env に URL/トークンが無ければ null」にする（weather の TZ_CITY 未設定と同じ）。
  if (typeof read !== 'function') return null;

  const translate = opts.translate || defaultTranslate;

  let prev;          // 直前に読めた値（遷移検知の状態）
  let primed = false; // 一度でも読めたか（初回は「変わった」と言わない＝weather の初回ガードと同じ）

  return {
    // 接続ごとに作る前提（prev はこのインスタンス＝この端末のもの。複数端末が各々反応する）。
    async poll() {
      let cur;
      try {
        cur = await read();
      } catch {
        return null; // 読めなければ黙る（PE）。フォールバックは behavior 側に持たせない
      }
      if (cur == null) return null;

      if (!primed) { primed = true; prev = cur; return null; } // 初回は基準を取るだけ
      const out = translate(prev, cur);
      prev = cur;
      return out || null; // translate が遷移なしと判断したら黙る
    },
  };
}

// 既定の translate：値が変わった瞬間だけ一度喋る、最小の遷移検知。
// 実 connector はこれを差し替える（しきい値跨ぎ・カテゴリ遷移・entity の on/off など）。
function defaultTranslate(prev, cur) {
  if (prev === cur) return null;
  return { situation: 'example.changed', ctx: { from: prev, to: cur } };
}
