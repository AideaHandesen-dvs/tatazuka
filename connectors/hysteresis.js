// しきい値プローブ共有の判定部品（純ロジック・依存ゼロ・IO なし）。
// シュミットトリガ（二閾値ヒステリシス）＋任意デバウンス（N 連続で確定）。
//
// 二種類の「ばたつき」を別レイヤで潰す：
//   - 縁のチャタ（値が閾値付近でゆらぐ）→ ヒステリシス（low/high の二閾値）。帯の中は現状維持。
//   - スパイク（一瞬だけ跨ぐ）→ デバウンス（新しい状態を N 回連続で見るまで確定しない）。
//
// ドメイン中立：'warn'（警戒）/ 'ok'（安全）の内部状態を持ち、確定遷移のときだけ 'enter'/'exit' を返す。
// 呼び手（disk/memory 等）が 'enter'→xxx.low / 'exit'→xxx.ok のように situation へ写す。
//
//   below=true（小さいほど悪い・空き容量/空きメモリ）：value<low で warn、value>high で ok（low<high）
//   below=false（大きいほど悪い・負荷/温度/通信レート）：value>high で warn、value<low で ok
//
//   const th = makeThreshold({ low: 10, high: 15, below: true, debounce: 3 });
//   th.feed(8)  // → 'enter' | 'exit' | null（遷移が確定した瞬間だけ非 null。初回は基準＝null）

export function makeThreshold({ low, high, below = true, debounce = 1 }) {
  let state = null;       // 'warn' | 'ok'（null＝未確定＝初回前）
  let pending = null;     // 確定待ちの候補状態
  let count = 0;          // 候補を連続で見た回数

  // 生値が指す「素の状態」。ヒステリシス帯の中なら null（＝現状維持）。
  function raw(v) {
    if (below) {
      if (v < low) return 'warn';
      if (v > high) return 'ok';
    } else {
      if (v > high) return 'warn';
      if (v < low) return 'ok';
    }
    return null; // 帯の中
  }

  return {
    feed(v) {
      // 初回は基準を取るだけ（遷移として出さない）。帯の中で始まったら ok 扱い（安全側）。
      if (state == null) { state = raw(v) ?? 'ok'; return null; }

      const r = raw(v);
      if (r == null || r === state) { pending = null; count = 0; return null; } // 帯内 or 現状維持

      // 現状と違う素の状態が来た → デバウンス（N 連続で確定）
      if (r === pending) count++;
      else { pending = r; count = 1; }
      if (count < debounce) return null;

      state = r; pending = null; count = 0;
      return r === 'warn' ? 'enter' : 'exit';
    },
  };
}
