# client/ — 表示クライアント

M2 の単体プロトタイプ。**server 無しで動く**。「傾けると覗き込める＋カメラ背景＋仮の顔」で
「透明な箱の中に佇かがいる」体感を検証するためのもの（README §7）。

## 動かし方

```sh
# リポジトリのどこからでも
python3 -m http.server 8000 -d client
# → http://localhost:8000 を開く
```

- **file:// で直接開くと動かない**（ES modules がブロックされる）。必ず HTTP で配信する。
- デスクトップ：センサが無いので、マウス移動が視点の代替になる（覗き込みの感触だけ確認できる）。
- スマホ/タブレットで試すには **HTTPS が要る**（`getUserMedia` / `DeviceOrientation` の制約。README §6）。
  配信方法は未決の TODO。候補：mkcert のローカル証明書 / Tailscale Serve / 自己署名（iOS は痛い）。
- `?label=リビングのiPad` で端末名を名乗れる（protocol §3-1 の `label`）。
- ページをリロードすると `resumed: true` の hello になり、佇かが「落ちてたぞ」と言う（protocol §6-3 のデモ）。

## ファイル構成と責務

| ファイル | 責務 |
|---|---|
| `index.html` | 骨組みだけ。box（#scene/#stage）・佇か・許可ボタン置き場・HUD |
| `app.js` | cap 検出・入力の意味化（つつく/なでる/長押し/揺らす）・メッセージ配線 |
| `face.js` | **顔**。protocol の意味論（mood/act/presence/say）を DOM に翻訳する層 |
| `mock-server.js` | **偽の本体**。protocol v0 を厳守して喋る server スタブ |
| `style.css` | 見た目すべて。mood/act の語彙 → CSS の対応もここ |

## 将来の継ぎ目（ここを差し替える）

1. **mock → 本物の server（M3）**：`connect({onMessage}) → {send(msg)}` という形は
   本物の WebSocket 実装でも変えない。`app.js` の import 先を差し替えるだけで移行できるようにしてある。
   mock は protocol v0 に厳密に従うこと。**mock だけの方言を作ったら負け**（それは protocol 違反の温床）。
2. **顔の差し替え（README §5）**：`face.js` ＋ `style.css` の mood/act 対応部分を丸ごと入れ替えれば
   顔が変わる。`app.js` は顔の実装を知らない。

## 設計判断のメモ

- **描画は CSS 3D だけ。Three.js すら入れない**。`perspective` ＋ 層ごとの `translateZ` で
  2.5D パララックスは成立する。WebGL が無い端末（中古学習タブレット級）でも CSS transform は動く。
  リッチな顔が欲しくなったら face.js ごと差し替える（その時に Three.js を検討）。
- **cap は「動いた」だけを信用する**。`DeviceOrientationEvent` が window に存在しても、
  センサの無いデスクトップでは一生イベントが来ない。だから iOS 系（許可ゲート持ち）だけ `ask`、
  それ以外は `none` で開始し、最初のイベントが来た時点で `on` に上げて `caps` 差分を送る。
  hello の後に cap が育つのは protocol §3-3 が想定済みの動き。
- **傾き・加速度の生データは server に送らない**（protocol §5-2）。傾き→視点は client 内で消費し、
  加速度は「揺らす」に意味化してから送る。
- **なでなで判定**：ポインタ移動距離が 240px たまるごとに `sense なでる` を1発（protocol §5-2 の
  「一定量ごとのイベント繰り返し」）。タップ（移動 12px 未満）は「つつく」、600ms 押しっぱなしは「長押し」。
- **吹き出しの 8 秒フェードは暫定**。protocol 上は「新しい say が前の台詞を置き換える」だけで
  消す指示は無い（§4-2）。永遠に残ると見た目が悪いので client の解釈で薄くしている。
  ちゃんとやるなら protocol に消去の語彙を足す議論をすること。
- HUD（左上）はプロト用。caps の現在値と直近の送受信を表示する。「視点リセット」で傾きの基準を取り直す。
