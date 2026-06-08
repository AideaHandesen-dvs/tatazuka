// 再会の記憶（protocol §6-3）。label（端末）ごとに「最後に見た時刻」を覚え、再接続したときに
// 「リビングのiPad、3分ぶりだな」と間隔に言及できるようにする。
//   - 接続をまたぐ記憶なので、セッション（接続ごと）ではなく server プロセスに一つ持つ（serve.js が注入）。
//   - 記憶は label をキーにした最終接続時刻だけ。protocol は不変（greet に ctx を添えるだけ）。
//   - 落ちたことを隠さず人格の材料にする（§6-3）＝再接続を「茶々」に変える蛇口。
//
// 注入の継ぎ目（behavior.js）：
//   - 退室/切断で mark(label, now)（＝最後に見た時刻を更新）
//   - 入室の挨拶で seen(label) → 最終時刻。now との差が間隔。
// 時刻は呼び出し側（session）の clock を渡す＝テストで早送りできる（既定の実時間に依存しない）。

export function createReunion() {
  const lastSeen = new Map(); // label → 最後に見た時刻(ms)
  return {
    seen(label) { return lastSeen.has(label) ? lastSeen.get(label) : null; },
    mark(label, atMs) { if (label) lastSeen.set(label, atMs); },
  };
}

// 間隔(ms) を人間向けの短い語に。「3分」「2時間」「5日」。greet.reunion の ctx.since に入れる。
export function humanizeGap(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}分`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間`;
  return `${Math.floor(hr / 24)}日`;
}
