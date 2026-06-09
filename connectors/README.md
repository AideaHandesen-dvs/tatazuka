# connectors/ — 仲介ハブと第三者アダプタ

佇か本体を**仲介ハブ**にして、外の世界と繋ぐ場所（README §7）。

```
OpenCLAW / Home Assistant 等  ⇄  佇か本体（server/）  ⇄  表示クライアント（ブラウザ / 物理スタックチャン）
```

これも「育てていく」文書。決まったこと（連携の**型**）と、まだ手を付けていないこと（具体の統合）が混在する。
今ここに有るのは**土台＝二つの契約の所在を確定させた設計メモ**であって、実際の Home Assistant 統合や
ハブのルーティングはまだ無い（最後の節）。

---

## 1. connector は三つの顔を持つ

「連携」と一口に言うが、データの向きで性質が割れる。最初に名前を付けて分ける：

| 役割 | 向き | 何をする | 既にある証明 |
|---|---|---|---|
| **入力コネクタ**（イベント源） | 外 → 佇か | 外部システムの出来事を `situation` タグに翻訳し人格層に渡す | weather.js / activity.js（README §6-4） |
| **出力コネクタ**（表示先） | 佇か → 外 | server の語彙（`say`/`motion`/…）を別の身体で再生する | protocol v0 の語彙そのもの（§4-1） |
| **委譲コネクタ**（指揮役・将来） | 佇か → 外 → 佇か | open-ended な佇か発の問い合わせ（`delegate(query)→text`）。**当面は作らない**——soft は入力コネクタで足りる | まだ無い（seam のみ・§7-2） |

肝は、**どの契約も既存の設計判断が先に定義してしまっている**こと。connectors/ は新しい protocol を
発明しない。第三者アダプタの**置き場**であり、契約は protocol/ と situation タグの継ぎ目に既にある。

**当面、soft 委譲（README §7-1）は入力コネクタで足りる**——curated な readonly プローブ（git status・
ビルド状態…）を §3-1 の蛇口に足し、既存 LLM がキャラで茶々る。新しい契約は要らない。第三の顔
「委譲（往復・open-ended）」は「何でも自分で調べに行く部下」が本当に要ると分かってから作る seam で、
戻り値の落とし所は入力と同じ（結果は `situation` の ctx になって人格層へ・`say` に乗るだけで protocol 不変）。
詳細は §7。

### 1-1. 入力コネクタ — 外の出来事を situation に翻訳する

README §6-4 の「外部イベント源 → situation タグ → 人格層」パターンそのもの。weather・activity が
踏んだ道で、connector は**出自が違うだけ**：ホスト自身のセンサ（在席・idle）ではなく、外部システム
（Home Assistant の在宅判定、MQTT のセンサ、スマート家電…）を読む。

継ぎ目は weather/activity と**同一**。`poll()` が `{situation, ctx?}` か `null` を返すだけ。
behavior.js はそれが「ホストのセンサ」か「外部 connector」かを知らない（[example-source.js](example-source.js) が型の実体）。

### 1-2. 出力コネクタ — 封筒を開けずに転送する

物理スタックチャンや OpenCLAW を**表示先**にする側。ここで効くのが二つの先払い：

- **§2 の `{type, data}` 封筒分離** … ハブの仕事は「封筒を見てルーティングし、中身は開けずに転送」。
  平坦な形でなく type+data にしてあるのは、まさにこの転送のための先払い（§2 設計理由）。
- **§4-1 の意味論型語彙** … server は「呆れてる」「こっちを見る」という**意味**を送り、描画は受け手に任せる。
  だから物理スタックチャンは `mood:"喜び"` を**サーボ/LED の表情**として解釈すればいい——
  ブラウザが VRM の blendshape として解釈するのと完全に対称。**意味論型は provider 非依存の表示**であり、
  さくらスクリプト的な演出指定型を捨てた判断（§4-1）が、ここで物理デバイスを drop-in にする。

結論：**出力コネクタは「protocol v0 を喋るもう一つの client」でしかない**。新しい型は要らない。
生の傾きが要る等で語彙が足りなければ、§5-2/§5-3 が予告した「tilt ストリーム」を**非破壊的に足す**
（protocol を両側同セッションで直す。CLAUDE.md の規律）。

---

## 2. 契約はどこにあるか（新 protocol を作らない）

| | 入力コネクタ | 出力コネクタ |
|---|---|---|
| 契約の所在 | `poll() → {situation, ctx?}` の継ぎ目＋ persona の situation 語彙 | **protocol/ v0 そのもの**（封筒＋意味論型語彙） |
| protocol への影響 | **不変**（`say` に乗るだけ・client 無改修） | **不変**（受け手が v0 client になる。語彙不足は非破壊追加） |
| 縮退（PE） | 取れなければ黙る。佇かは他の理由で喋る | 表示先が落ちていればその部屋に居ないだけ（§6-1） |

二つとも protocol を変えない。これが「connectors は新 protocol を発明しない」の具体的な意味。

---

## 3. 継ぎ目（型）

### 3-1. 入力コネクタの契約

weather.js / activity.js と同じ。factory は env 等を見て、有効なら `{ poll }`、無効なら `null`（PE）：

```js
export function createXxx(opts) {
  // 設定が無い／前提が満たせない → null（＝この connector はオフ。佇かは他の理由で喋る）
  // opts で IO（fetch・コマンド実行・時計）を注入できるようにする（テストで実ネットを飛ばす）
  return {
    async poll() {
      // 外部状態を読む → 変化を検知 → situation を返す。無変化／読めなければ null（黙る）
      return { situation: 'home.back', ctx: { /* persona に渡す状況。任意 */ } } || null;
    },
  };
}
```

- **変化を喋る**（毎 tick の現在値ではなく遷移を）。weather の降水遷移・activity の idle しきい値跨ぎと同じ。
- **situation タグ**は persona 側の語彙を増やす行為。新タグを足したら `characters/` やルール表に台詞を用意する。
- **接続ごとに作る**（変化検知の状態を端末ごとに独立させる。weather/activity がそうしている理由と同じ）。

> 配線：behavior.js は `poll()` を持つ入力源を `sources: [...]` で一様に受ける（activity も
> その一員）。connector を挿す＝この配列に足すだけ。serve.js の `makeSources()` が env を見て
> 有効な connector を組み立てる（無効なら `null` を `filter` で落とす＝PE）。**接続ごとに作る**。
> ※ この一般化は最初の実 connector（Home Assistant）と同時に入れた。消費者の無いうちは
> `weather`/`activity` の名前付き opt のままにしていた（「必要になった型にだけ足す」protocol §2 の流儀）。

### 3-2. 出力コネクタの契約

新コードは要らない。**protocol v0 を喋る client になる**こと。すなわち：

1. WS で繋ぎ、`hello`（自分の cap を名乗る。スタックチャンなら `webgl:none`・サーボや LED は cap 語彙の将来拡張）。
2. server からの `say`/`emote`/`motion`/`presence` を**自分の身体で**再生（解釈できない値は黙って無視＝§4-1）。
3. 物理デバイスのタッチセンサ等は `sense` で送り返す（§5。`kind` の語彙に乗る）。

ハブの**ルーティング**（どの封筒をどの表示先へ。§6-1 の「一度に一箇所」＝「どの部屋＝どの身体」）は
本体側の仕事。**実装済み**：`server/hub.js` が複数の部屋（ブラウザ端末）を束ね、佇かを一度に一箇所に
居させ、つつかれた部屋へ移す。物理スタックチャンは**この hub に挿さるもう一つの「部屋（身体）」**に
なる——表示先の差し替えは、この同じルーティングの上で「どの身体に居るか」を選ぶことに帰着する。
残るのは実機側（v0 client を喋る物理デバイス）と、サーボ/LED 用の cap 語彙の非破壊拡張だけ。

> **OpenClaw は「出力＝身体」ではなく頭脳（決定）**：当初 `OpenCLAW` を表示先のように置いていたが、
> 実態はエージェント・ランタイム（頭脳）。連携は **向き3（佇か＝指揮役）× soft 委譲** に決まり、
> **soft の第一実装はランタイム無し**（既存 LLM＋ curated readonly プローブ＝入力コネクタ）で閉じる
> （[../README.md](../README.md) §7-1）。open-ended な「佇か発の問い合わせ（第三の顔）」は将来の seam（§7-2）。

---

## 4. 作業規律（イベント源パターンの三点・README §6-4）

- **protocol を変えない**（入力は `say` に乗るだけ／出力は v0 client。語彙拡張は両側同セッションで非破壊追加）。
- **PE で縮退**（設定が無い・相手が落ちている → 黙る／その部屋に居ない。佇かは他の理由で存在する）。
- **IO を注入してテスト**（fetch・コマンド実行・時計を差し替え可能に。実ネット/実機を CI に持ち込まない）。
- **依存ゼロを維持**（node 標準のみ。SDK は入れない＝ws を自前実装したのと同じ方針。グローバル `fetch` で足りる）。
- **改名禁止の余波**：本体は `server/`、connectors はここ。systemd user サービス化を見据えてパスを動かさない。

---

## 5. Home Assistant 入力コネクタ（入力役の初例・`home-assistant.js`）

イベント源パターンの最初の実 connector。HA の人物/端末の在席状態を読んで**在宅/外出**を喋る。
weather/activity と同型（fetch 注入・PE縮退・遷移検知）で、protocol は不変（`say` に乗るだけ）。

- **対象**：`person.*` / `device_tracker.*`（状態 `home` / `not_home` / ゾーン名）。`home` 以外は
  すべて外出扱い＝**ゾーン間移動（not_home→Work）では喋らない**。`friendly_name` があれば `ctx.who`
  に乗せ、LLM は「おかえり、◯◯」と呼べる（ルール表は固定台詞）。
- **situation**：`home.back`（帰宅＝出迎え）／`home.away`（外出＝見送り）。`desk.*`（PC の idle）とは別物。
- **env**：`TZ_HASS_URL`（例 `http://homeassistant.local:8123`）／`TZ_HASS_TOKEN`（長期アクセストークン）／
  `TZ_HASS_PERSON`（対象 entity 例 `person.john`）。**三つ揃わなければ connector オフ（PE）**。
- **拡張**：複数 entity・ドア/照明/温度などは situation を足す形で（この型を増やす）。HA は REST が
  枯れているので fetch 一本で足り、依存ゼロを崩さない。

```sh
TZ_HASS_URL=http://homeassistant.local:8123 TZ_HASS_TOKEN=eyJ... TZ_HASS_PERSON=person.john \
  node server/serve.js     # 帰宅すると「おかえり」、外出すると「いってらっしゃい」
```

> ロジック（遷移検知・ゾーン間無発話・縮退・認証ヘッダ）は `home-assistant.test.js` で fetch を
> 注入して固定。実 HA への生スモークは各自の環境で。

## 6. 今ここに有るもの / まだ無いもの

**有る**：

- この設計メモ（二つの契約の所在を確定）。
- [home-assistant.js](home-assistant.js) … **入力役の初例**（在宅/外出）。behavior.js の `sources` 配線込み。
- [git.js](git.js) … **soft 委譲の第一実装の readonly プローブ**（未コミットの clean↔dirty・§7-1）。
  `git status --porcelain` を readonly で読み、`git.dirty`/`git.clean` を投げる。`TZ_GIT_REPO` で有効化。
- [disk.js](disk.js) … **しきい値型の readonly プローブ**（空き容量の low↔ok・§7-1）。`df` を読み、
  空き率が `TZ_DISK_MIN_PCT`（既定 10）を割ると `disk.low`、回復で `disk.ok`。`TZ_DISK_PATH` で有効化。
- [example-source.js](example-source.js) … 入力コネクタの実行可能な**契約テンプレ**（依存ゼロ・IO 注入・PE縮退）。
  コピーして `read()`/`translate()` を実装すれば新しい入力 connector になる。
- 各 `*.test.js` … `poll()` の契約（遷移検知・縮退・状態独立・認証）を固定。

**有る（出力の土台）**：

- ハブのルーティング（`server/hub.js`）… 佇かを「一度に一箇所」に居させ、つつかれた部屋へ移す
  （protocol §6-1）。物理スタックチャンはここに挿さるもう一つの「部屋＝身体」になる（§3-2）。

**まだ無い（M5 の残り）**：

- **入力**：HA 以外のイベント源（MQTT・他の HA ドメイン等）。型は揃ったので足すだけ。
- **委譲（soft）**：curated readonly プローブを入力コネクタとして足す（§7-1）。**git（二値）・ディスク（しきい値）は実装済み**
  （`git.js` / `disk.js`）。他（ビルド/テスト状態 等）は同じ型に沿って足すだけ。「開いてるファイル」はアクティブ
  ウィンドウ依存で Wayland 不可・プライバシーのため見ない（activity.js と同方針）。open-ended な delegate
  seam（§7-2）は要ると分かってから。
- **出力**：物理スタックチャン/OpenCLAW を v0 client として喋らせる実機側＋サーボ/LED の cap 語彙拡張（§3-2）。**要実機**。

```sh
node --test connectors/*.test.js   # connector の契約テスト（依存ゼロ）
```

---

## 7. 委譲：soft は入力コネクタで足りる／open-ended は将来の seam（README §7-1）

佇か＝指揮役 × soft の**第一実装は、新しいコネクタ型を作らない**。soft の現実的な範囲（README §7-1）は
**既存 LLM＋ curated readonly プローブ**で閉じ、それは §3-1 の入力コネクタそのものだから。

### 7-1. 当面：readonly プローブ＝入力コネクタ

「家の中も少し見えてる同居人」は、こちらが書いた readonly プローブを §3-1 の `poll()` 契約で足すこと：

- 例：`git status`／ビルドの成否／開いているファイル／ディスク残量。weather・activity と同型
  （IO 注入・PE 縮退・遷移検知）で、**読み取りしかしない**（書込・実行系コマンドを組み立てない）。
- 戻りは `situation`＋ctx（`work.pr.unreviewed` 等）。`characters/` とルール表に台詞を用意する
  （新タグを足したら persona 側の語彙も増やす＝§3-1 と同じ規律）。
- **生成 ≠ 実行の罠を踏まない**：LLM にコマンドを生成・実行させない。プローブは*こちらが固定で書く*。
  これが soft を「約束」でなく「構造」で守るということ（README §7-1）。

新しい契約は要らない。**soft 委譲の near-term は「入力コネクタを増やす」に帰着する。**

**初例：[git.js](git.js)** — 監視リポ（`TZ_GIT_REPO`）の未コミットを `git status --porcelain` で readonly に読み、
clean↔dirty の遷移で `git.dirty`/`git.clean` を投げる（HA の home/away と同型）。`ctx.n`＝未コミット数・
`ctx.repo`＝リポ名を LLM persona が織り込む（「foo に3件たまってるぞ」）。コマンド実行は `opts.run` 注入で
テストし、実 git は叩かない（`git.test.js`）。これが soft を構造で守る形＝*読むのは固定の readonly 一点*。

**しきい値型：[disk.js](disk.js)** — git が二値遷移なのに対し、こちらは `df` の空き率が `TZ_DISK_MIN_PCT`
（既定 10）を割ったかで `disk.low`/`disk.ok`（weather・work.N と同じしきい値またぎ）。同じイベント源
パターンが**二値でもしきい値でも回る**ことを示す。`ctx.freePct`/`ctx.freeGb` を LLM が織り込む。

### 7-2. 将来：open-ended な delegate seam（要るとわかってから）

「何でも自分で調べに行く部下」が本当に欲しくなったら、外向きの `delegate(query) → text` を足す。
戻り値の落とし所は入力と同じ（結果が `situation` の ctx）で protocol 不変。頭脳には **ReadOnly の
サブエージェント**を据える——第一候補は**自作 PawAgent に ReadOnly autonomy 段＋構造化出力を足したもの**
（README §7-1）。ReadOnly 段が soft の境界で、autonomy を上げる＝hard 化＝§1 を意識的に上書きする
**意図的スイッチ**。サードパーティ（ZeroClaw 等）より中身を把握した自前を優先する。要ると分かるまで作らない。
