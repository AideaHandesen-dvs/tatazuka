// hysteresis.js の単体テスト（依存ゼロ・node:test）。純ロジックなので IO なし。
//   node --test connectors/hysteresis.test.js
//
// 押さえる契約：
//   - 初回 feed は基準だけ（null）
//   - below=true は value<low で enter（warn）、value>high で exit（ok）。帯 [low,high] の中は維持
//   - デバウンス：新状態を N 連続で見るまで確定しない（スパイクは弾く）
//   - below=false（大きいほど悪い）は向きが反転する

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeThreshold, makeBand } from './hysteresis.js';

test('初回は基準だけ（null）', () => {
  const th = makeThreshold({ low: 10, high: 15 });
  assert.equal(th.feed(50), null);
});

test('below=true：縁のチャタはヒステリシス帯で吸収する', () => {
  const th = makeThreshold({ low: 10, high: 15 }); // debounce=1
  assert.equal(th.feed(50), null);     // 基準（ok）
  assert.equal(th.feed(8), 'enter');   // < low → 警戒
  assert.equal(th.feed(12), null);     // 帯 [10,15] の中 → 維持（戻さない＝チャタ吸収）
  assert.equal(th.feed(14), null);     // まだ帯の中
  assert.equal(th.feed(18), 'exit');   // > high → 安全に戻る
  assert.equal(th.feed(11), null);     // 帯の中 → 維持
});

test('デバウンス：N 連続で初めて確定（単発スパイクは弾く）', () => {
  const th = makeThreshold({ low: 10, high: 15, debounce: 3 });
  assert.equal(th.feed(50), null);     // 基準（ok）
  assert.equal(th.feed(5), null);      // warn 1 回目（未確定）
  assert.equal(th.feed(5), null);      // warn 2 回目
  assert.equal(th.feed(5), 'enter');   // warn 3 回目 → 確定
});

test('デバウンス中に戻るとリセット（スパイクを採用しない）', () => {
  const th = makeThreshold({ low: 10, high: 15, debounce: 3 });
  assert.equal(th.feed(50), null);     // 基準（ok）
  assert.equal(th.feed(5), null);      // warn 1 回目
  assert.equal(th.feed(5), null);      // warn 2 回目
  assert.equal(th.feed(50), null);     // ok に戻った → カウントは捨てられる（enter しない）
  assert.equal(th.feed(5), null);      // warn 1 回目（数え直し）
  assert.equal(th.feed(5), null);      // 2
  assert.equal(th.feed(5), 'enter');   // 3 → ここで初めて確定
});

test('below=false（大きいほど悪い）は向きが反転する', () => {
  const th = makeThreshold({ low: 70, high: 90, below: false }); // 負荷/温度などを想定
  assert.equal(th.feed(20), null);     // 基準（ok）
  assert.equal(th.feed(95), 'enter');  // > high → 警戒
  assert.equal(th.feed(80), null);     // 帯 [70,90] の中 → 維持
  assert.equal(th.feed(60), 'exit');   // < low → 安全に戻る
});

// ---- makeBand（両側帯＝真ん中が幸せ）----

test('band：初回は基準だけ。両側に外れたら low/high、戻れば ok', () => {
  const b = makeBand({ low: 40, high: 60 }); // margin=0 / debounce=1
  assert.equal(b.feed(50), null);     // 基準（ok・帯の中）
  assert.equal(b.feed(35), 'low');    // 下に外れた（乾燥）
  assert.equal(b.feed(50), 'ok');     // 帯に戻った
  assert.equal(b.feed(70), 'high');   // 上に外れた（じめじめ）
  assert.equal(b.feed(50), 'ok');     // 戻った
});

test('band：margin で再入のチャタを吸収（極に入ったら margin 余分に戻るまで維持）', () => {
  const b = makeBand({ low: 40, high: 60, margin: 5 });
  assert.equal(b.feed(50), null);     // 基準（ok）
  assert.equal(b.feed(38), 'low');    // < 40 → 乾燥
  assert.equal(b.feed(42), null);     // 40〜45 の縁＝まだ戻し切らない → low 維持（チャタ吸収）
  assert.equal(b.feed(46), 'ok');     // > 40+margin → 快適に復帰
});

test('band：デバウンスで単発スパイクを弾く', () => {
  const b = makeBand({ low: 40, high: 60, debounce: 2 });
  assert.equal(b.feed(50), null);     // 基準（ok）
  assert.equal(b.feed(30), null);     // low 1 回目（未確定）
  assert.equal(b.feed(50), null);     // ok に戻った＝スパイク → カウント捨て（low 確定しない）
  assert.equal(b.feed(30), null);     // low 数え直し 1
  assert.equal(b.feed(30), 'low');    // 2 連続 → 確定
});

test('band：極から極への直跳び（low→high）も拾う', () => {
  const b = makeBand({ low: 40, high: 60, margin: 5 });
  assert.equal(b.feed(50), null);     // 基準（ok）
  assert.equal(b.feed(30), 'low');    // 乾燥
  assert.equal(b.feed(80), 'high');   // 一気に上振れ → high（ok を経由せず直跳び）
});
