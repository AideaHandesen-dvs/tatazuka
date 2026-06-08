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
| `ws-client.js` | **本物の server への接続**（WS）。再接続＋hello 打ち直し（§6-2）を担当。app.js の既定の接続先 |
| `mock-server.js` | **偽の本体**。protocol v0 を厳守して喋る server スタブ。オフライン開発用（import を差し替えて使う） |
| `face-vrm.js` | **VRM アバターの顔**（上位レイヤ）。face.js と同じ顔を実装。WebGL が効く端末でだけ動的ロード |
| `vendor/` | three.js / three-vrm / GLTFLoader のビルド済み ESM（リポ同梱。外部CDN非依存・オフライン可） |
| `models/` | VRM モデル置き場（**git 管理外**。各自で .vrm を置く） |
| `style.css` | 見た目すべて。mood/act の語彙 → CSS の対応もここ |

## 将来の継ぎ目（ここを差し替える）

1. **mock → 本物の server（M3 で完了）**：`connect({onMessage}) → {send(msg)}` という形は
   本物の WebSocket 実装（`ws-client.js`）でも変えなかった。app.js は既定で `ws-client.js` に繋ぐ。
   オフライン開発したいときは app.js の import を `./mock-server.js` に戻すだけ。
   mock は protocol v0 に厳密に従うこと。**mock だけの方言を作ったら負け**（それは protocol 違反の温床）。
2. **顔の差し替え（README §5）**：`face.js` ＋ `style.css` の mood/act 対応部分を丸ごと入れ替えれば
   顔が変わる。`app.js` は顔の実装を知らない（`activeFace` の {emote,act,say,presence,setView} だけ見る）。
   この継ぎ目が実際に機能することは、VRM 顔（face-vrm.js）を後付けで差し込んで実証済み。

## VRM アバター（上位レイヤ＝プログレッシブ・エンハンスメント）

「顔」は CSS の卵（face.js）を**床**として常に持ち、WebGL が効く端末ではそこに VRM アバター
（face-vrm.js）を**格上げ**で載せる。設計メモ §5 の「軽量3D」をこの形で入れた。

- **格上げ条件**（app.js の `tryVRM`）：`webgl` cap が `on` ＋ モデルが実在（HEAD で確認）＋ 動的
  import が成功。どれかが欠ければ **CSS の卵のまま**。佇かは必ず出る。
- **iOS 12（＝試金石の iPad Air 2）では VRM は出ない**。three.js は新しい構文を使うので Safari 12 では
  パースできず、`import()` が reject → 自動で CSS にフォールバックする。これは想定動作。
  VRM が見えるのはデスクトップや新しめのタブレット。
- **ライブラリは vendor 済み**（`vendor/`）。`index.html` の importmap が `"three"` を
  `./vendor/three.module.js` に解決する。**バンドラ不要**（ビルド済み ESM を server が配るだけ）、
  外部 CDN に依存しない（オリジン一つ・LAN 完結）。three r160 / @pixiv/three-vrm 3.1.6。

### モデルの置き方

```sh
# 手元の .vrm を置くだけ。既定のパスは client/models/tatazuka.vrm
cp ~/somewhere/youravatar.vrm client/models/tatazuka.vrm
# 別パスを使うなら ?model= で指定： https://host:8443/?model=./models/foo.vrm
```

- `models/` は **git 管理外**（ライセンス・サイズのため同梱しない）。
- VRM0 / VRM1 どちらも可。three-vrm が向きを正規化し、face-vrm がカメラ側を向かせる。
- カメラのフレーミング（`baseR` ＝ 顔までの距離）はモデルの背丈で多少ズレうる。face-vrm.js で調整。
- 向き・寄り・高さ・腕角は実機から微調整できる：`?turn=`（半回転数, 既定1）`?dist=`（顔までの距離, 既定0.95）
  `?y=`（注視点の高さ補正）`?arms=`（腕下げ角 rad, 既定1.0）。
- **2026-06-08 実機検証**：Android Chrome（WebGL2）で aya（VRM0.x）を確認。**既定値のまま**
  正面・フレーミング・腕・視線追従・吹き出し すべて良好。iOS 12 の iPad は設計通り CSS の卵にフォールバック。

### face-vrm が実装する見た目

- **視線追従**：`vrm.lookAt.target = camera`。覗き込むと**目がこっちを追って向く**＝箱の中の存在が
  見返してくる。`setView`（傾き/マウス由来の角度）でカメラが佇かの周りを小さく回る。
- **mood → VRM 標準表情**（happy/angry/relaxed/surprised…）。`emote` で重みを lerp。
- **act → 簡易ボーン動作**（うなずく＝head pitch / 首を振る＝head yaw / 跳ねる＝scene Y / こっちを見る）。
- **say → 画面上部の吹き出し**（CSS 顔の #balloon とは別の overlay）。

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

## iOS 12 対応（古い端末がプログレッシブ・エンハンスメントの試金石）

実機 iPad Air 2（iOS 12.5.8 = Safari 12、2018年製）で「背景しか出ない」事故が出た。
原因は **client コードがモダンすぎた**こと。これは設計思想（枯れた技術・低性能端末対応）の
直接の試験であり、逃げずに iOS 12 で動くよう直した。避けた地雷：

- **`?.`（optional chaining）/ `??`（nullish）は Safari 13.4+**。iOS 12 では**構文エラーで
  モジュールが丸ごと死ぬ**（だから佇かもボタンも出ず、エラーすら表に出なかった）。明示チェックに展開。
- **Pointer Events は iOS 13+**。iOS 12 に無い。`touchstart/move/end` ＋ `mousedown/move/up` の
  両対応に置換。`setPointerCapture` の代わりに mouse は window で move/up を拾う。
- **CSS `inset` 短縮形は Safari 14.5+**。`top/right/bottom/left` を個別指定に（`box-shadow: inset` は別物、そのまま）。

実機デバッグは devtools を繋ぎにくいので、`index.html` に `window.onerror` →画面下の赤帯、を仕込んである。

### iOS 12 実機の端末設定（コードでは直せない）

- **設定 → Safari → モーションと画面の向きのアクセス → オン**。これがオフだと `deviceorientation` /
  `devicemotion` のイベントが一切来ない（iOS 12.2 でデフォルトがオフに変わった）。傾き覗き込みの前提。
- iOS 12 には `DeviceOrientationEvent.requestPermission`（許可ボタン）が無い。よって client は
  orientation/motion を `ask` にせず、設定がオンなら**イベントが来た時点で `on`**に上げる（cap は「動いた」だけ信用）。
