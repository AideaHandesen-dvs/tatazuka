// しきい値プローブ共有の判定部品（純ロジック・依存ゼロ・IO なし）。
// シュミットトリガ（二閾値ヒステリシス）＋任意デバウンス（N 連続で確定）。
// 二つの factory：makeThreshold（片側＝小さいほど/大きいほど悪い・enter/exit）と
// makeBand（両側＝真ん中が幸せ・low/ok/high の三状態。湿度や室温に。下に追加）。
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

// 快適帯（両側しきい値）：低すぎても高すぎても警戒し、真ん中の帯（low〜high）は黙る。湿度・室温・CO2 の
// ように「真ん中が幸せ」な量に。makeThreshold（片側＝小さいほど or 大きいほど悪い）と対で、状態は三つ：
// 'low'（下に外れた）/ 'ok'（快適帯の中）/ 'high'（上に外れた）。一度ある極に入ったら、戻るには margin だけ
// 余分に戻ってから ok に復帰する（縁のチャタ対策＝シュミットトリガを両端に置いたのと同じ）。スパイクは
// makeThreshold と同じ debounce（N 連続で確定）で弾く。極から極への直跳び（low→high）も raw で吸収する。
//
//   const b = makeBand({ low: 40, high: 60, margin: 5, debounce: 2 });
//   b.feed(35) // → 'low' | 'ok' | 'high'（確定遷移の瞬間だけ非 null。初回は基準＝null）| null
//   呼び手（humidity 等）が 'low'→xxx.dry / 'high'→xxx.humid / 'ok'→xxx.ok のように situation へ写す。

export function makeBand({ low, high, margin = 0, debounce = 1 }) {
  let state = null;       // 'low' | 'ok' | 'high'（null＝未確定＝初回前）
  let pending = null;     // 確定待ちの候補状態
  let count = 0;          // 候補を連続で見た回数

  // 生値が指す「素の状態」。現状態を踏まえ、極からの復帰には margin の戻りを要求する（縁のチャタ対策）。
  function raw(v) {
    if (state === 'low')  return v > low + margin ? (v > high ? 'high' : 'ok') : 'low';
    if (state === 'high') return v < high - margin ? (v < low ? 'low' : 'ok') : 'high';
    // ok または初回（state==null）：素の帯で分類
    if (v < low) return 'low';
    if (v > high) return 'high';
    return 'ok';
  }

  return {
    feed(v) {
      if (state == null) { state = raw(v); return null; } // 初回は基準だけ（遷移として出さない）

      const r = raw(v);
      if (r === state) { pending = null; count = 0; return null; } // 現状維持

      // 現状と違う素の状態が来た → デバウンス（N 連続で確定）
      if (r === pending) count++;
      else { pending = r; count = 1; }
      if (count < debounce) return null;

      state = r; pending = null; count = 0;
      return r; // 'low' | 'ok' | 'high'
    },
  };
}
