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
  枯れているので fetch 一本で足り、依存ゼロを崩さない。**第一の拡張＝[humidity.js](humidity.js)**（HA の
  `sensor.*` を読む室内湿度の快適帯）。REST の読み（認証・URL・PE）は [ha.js](ha.js) に共有し、在席（状態文字列）と
  湿度（数値の両側しきい値）で**意味論だけ分けた**——「天気でなく部屋の中」という HA が唯一くれる価値を取りにいく初例。
  その後 [co2.js](co2.js)（CO2）・[roomtemp.js](roomtemp.js)（室温）・[illuminance.js](illuminance.js)（照度）と `sensor.*` 系が増え、
  **[opening.js](opening.js)（ドア/窓の `binary_sensor`）は在席と完全に同型の二値遷移**＝この §5 の在席ロジックの「人物→開口部」版。
  いずれも ha.js を共有し protocol は不変（`say` に乗るだけ）。「部屋の中」を読む六本の型の整理は §7-1 末尾。

```sh
TZ_HASS_URL=http://homeassistant.local:8123 TZ_HASS_TOKEN=eyJ... TZ_HASS_PERSON=person.john \
  node server/serve.js     # 帰宅すると「おかえり」、外出すると「いってらっしゃい」
```

> ロジック（遷移検知・ゾーン間無発話・縮退・認証ヘッダ）は `home-assistant.test.js` で fetch を
> 注入して固定。実 HA への生スモークは各自の環境で。

## 6. 今ここに有るもの / まだ無いもの

**有る**：

- この設計メモ（二つの契約の所在を確定）。
- [home-assistant.js](home-assistant.js) … **入力役の初例**（在宅/外出・`person.*`/`device_tracker.*`）。behavior.js の `sources` 配線込み。
- [humidity.js](humidity.js) … **HA の sensor.* を読む入力役の初例＝室内湿度の快適帯**（`humidity.dry`/`humidity.humid`/`humidity.ok`）。
  Open-Meteo の外気では知れない「部屋の中」を HA から拾う（HA が唯一くれる価値）。**両側しきい値（快適帯）の初例**——
  低すぎ（乾燥）も高すぎ（じめじめ）も警戒し、`TZ_HUMIDITY_LOW`〜`TZ_HUMIDITY_HIGH`（既定 40〜60）の帯は黙る（`makeBand`）。
  `ctx.pct` を LLM が織り込む。`TZ_HASS_URL`＋`TZ_HASS_TOKEN`（在席と共有）＋`TZ_HASS_HUMIDITY`（対象 sensor）で有効化。
  HA REST の読みは [ha.js](ha.js) に共有（home-assistant と分け合う）。センサが無ければ黙る（PE）。
- [co2.js](co2.js) … **HA の室内 CO2 の stuffy↔ok**（`co2.stuffy`/`co2.ok`）。湿度と並ぶ「部屋の中」の二本目。
  湿度（両側）と違い CO2 は**片側＝大きいほど悪い**（外気以下にならず低い分には害なし）＝thermal/nic と同じ
  `makeThreshold` の below=false。`TZ_CO2_HIGH`（既定 **1000ppm**＝建築物衛生法の室内目安）超えで `co2.stuffy`、
  戻し 800ppm で `co2.ok`。`ctx.ppm` を LLM が織り込む。`TZ_HASS_CO2` で有効化（ha.js 共有・センサ無ければ PE）。
- [roomtemp.js](roomtemp.js) … **HA の室温の cold↔hot↔ok**（`roomtemp.cold`/`roomtemp.hot`/`roomtemp.ok`）。「部屋の中」三本目で
  **両側帯（快適帯）の二例目**（湿度に続く・makeBand）。寒すぎも暑すぎも警戒し、`TZ_ROOMTEMP_LOW`〜`TZ_ROOMTEMP_HIGH`
  （既定 **18〜28℃**＝建築物衛生法/事務所衛生基準の室内目安）の帯は黙る。屋外天気の `weather.hot`/`weather.cold`・CPU の
  `temp.hot` とは**別の身体**なので `roomtemp.*` で名前空間を分ける（「外は寒いが部屋は暑い」が共存）。`ctx.tempC` を LLM が織り込む。`TZ_HASS_TEMP` で有効化。
- [illuminance.js](illuminance.js) … **HA の室内照度の dark↔ok**（`illuminance.dark`/`illuminance.ok`）。「部屋の中」四本目。
  夕暮れに照明をつけ忘れて薄暗い、を拾う。型は **片側 below=true（小さいほど悪い＝暗い）**＝disk/memory と同系
  （CO2 の below=false と逆向き）。`TZ_LUX_MIN`（既定 50lux）を割り続けると `illuminance.dark`、戻し 80lux で `illuminance.ok`。
  雲の通過・人影の翳りをデバウンス 3 で弾く。`ctx.lux` を LLM が織り込む。`TZ_HASS_LUX` で有効化。
- [opening.js](opening.js) … **HA の binary_sensor＝ドア/窓の開閉**（`opening.open`/`opening.closed`）。しきい値型でなく
  **二値遷移＝[home-assistant.js](home-assistant.js)（在席）と完全に同型**（出自が人物の在席でなく開口部の開閉なだけ）。
  `on`＝開／`off`＝閉、初回基準・無変化は黙る。`ctx.what`（friendly_name）で「リビングの窓、開いてるぞ」。
  開けっ放しが気になる開口部（窓/ベランダ）に向ける想定（頻繁に開閉する玄関は賑やかになる＝env で選ぶ）。`TZ_HASS_OPENING` で有効化。
- [ha.js](ha.js) … HA REST（`GET /api/states/<entity>`・トークン認証・PE 縮退）の**共有リーダ**。home-assistant（在席）・
  humidity（湿度）・co2（CO2）・roomtemp（室温）・illuminance（照度）・opening（開閉）が分け合う純 IO 部品
  （`run.js`/`hysteresis.js` と同列＝消費者が増えたので一点に寄せた）。
- [git.js](git.js) … **soft 委譲の第一実装の readonly プローブ**（未コミット clean↔dirty ＋未 push unpushed↔pushed・§7-1）。
  `git status --porcelain=v2 --branch` を readonly で読み、`git.dirty`/`git.clean`/`git.unpushed`/`git.pushed` を投げる。`TZ_GIT_REPO` で有効化。
- [disk.js](disk.js) … **しきい値型の readonly プローブ**（空き容量の low↔ok・§7-1）。`df` を読み、
  空き率が `TZ_DISK_MIN_PCT`（既定 10）を割ると `disk.low`、回復で `disk.ok`。`TZ_DISK_PATH` で有効化。
- [memory.js](memory.js) … **デバウンス付きしきい値の readonly プローブ**（空きメモリの low↔ok・§7-1）。
  `/proc/meminfo` を読み、空き率が `TZ_MEM_MIN_PCT`（既定 10）を割った状態が続くと `mem.low`、回復で `mem.ok`。`TZ_MEM=1` で有効化。
- [net.js](net.js) … **二値の readonly プローブ**（オンライン/オフライン・§7-1）。`/sys/class/net/*/operstate`
  を読み、lo 以外で up があれば `net.online`、無ければ `net.offline`。`TZ_NET=1` で有効化。
- [nic.js](nic.js) … **レート型の readonly プローブ**（通信レートの busy↔idle・§7-1）。`/proc/net/dev` の
  rx+tx 累計を**2 点読んで差分÷経過時間**でレート化し、`TZ_NIC_BUSY_MBPS`（既定 2）を超え続けると `nic.busy`、
  落ち着くと `nic.idle`（hysteresis を below=false で使う）。`TZ_NIC=1` で有効化。
- [battery.js](battery.js) … **ゲート付きしきい値型の readonly プローブ**（残量の low↔ok ＋満充電ケア・§7-1）。git〜nic が
  「開発者の机」寄りだったのに対し、**ノートを使う人全員**に効く同居人の気遣い。`/sys/class/power_supply/*` の
  capacity / status を読み、**放電中に**残量が `TZ_BATTERY_MIN_PCT`（既定 20）を割ると `battery.low`、繋ぎ直せば
  `battery.ok`（充電中は「切れそう」と言わない＝充電ゲート）。第二の軸として `Full` で繋ぎっぱを `battery.full`
  （「もう満タン、抜いたら」＝電池いたわり・git の二軸と同型）。`TZ_BATTERY=1` で有効化。
- [thermal.js](thermal.js) … **温度の hot↔ok**（`/sys/class/thermal/*`・§7-1）。机に座ってる人全員に効く体感（膝が熱い・
  ファンが唸る）。複数ゾーンの最大を見て `TZ_TEMP_HOT_C`（既定 80℃）を超え続けると `temp.hot`、冷えると `temp.ok`。
  nic と同じ below=false ＋スパイク弾きのデバウンス 3（両方向）。`TZ_TEMP=1` で有効化。
- [download.js](download.js) … **ダウンロード完了**（既定 `~/Downloads` の readdir 差分・§7-1）。family 初の
  **エッジ（出来事）型**——サンプル値でなく「新しいファイルが現れた瞬間」を一度だけ拾う（伺からしい反応）。
  プライバシーで**件数だけ**見てファイル名は乗せず、途中ファイル（`.crdownload`/`.part` 等）は確定まで数えない。
  `download.done`＋`ctx.n`。`TZ_DOWNLOAD=1` で有効化（`TZ_DOWNLOAD_DIR` で監視先変更）。
- [trash.js](trash.js) … **ゴミ箱が溜まった full↔ok**（既定 `~/.local/share/Trash/files` の件数・§7-1）。掃除を促す
  家事ナッジ。below=false の件数しきい値（`TZ_TRASH_MAX` 既定 100・件数なので戻し幅 20 と広め）。
  プライバシーで件数だけ（download と同方針）。`trash.full`/`trash.ok`＋`ctx.n`。`TZ_TRASH=1` で有効化。
- [resume.js](resume.js) … **スリープ/休止からの復帰**（poll 間隔の空白・§7-1）。family で**いちばん軽い**——
  ファイルも /sys も読まず、poll が呼ばれる実時計間隔を測るだけ。`TZ_RESUME_GAP_S`（既定 180）を超える空白を
  「マシンが寝ていた」とみなし `resume.back`（「おかえり」）＋`ctx.gapMin`。activity（idle 離席）が捉えられない
  「マシンごと寝ていた」領域を埋める。`TZ_RESUME=1` で有効化。
- [uptime.js](uptime.js) … **連続稼働が長い**（`os.uptime()` のしきい値超え・§7-1）。resume の**双子**——あちらは
  「マシンが寝ていた」を、こちらは「ずっと再起動していない（起きっぱなし）」を拾う。`TZ_UPTIME_MAX_H`（既定 168＝7日）
  を超えて連続稼働で `uptime.long`（「そろそろ再起動したら?」）＋`ctx.days`/`ctx.hours`。**単方向ナッジ**——
  uptime は単調増加し回復は再起動時だけ＝佇か自身も再起動して状態がまっさらになるので、enter だけ拾い exit は捨てる
  （persona に死にタグを増やさない）。`os.uptime()` は node が全 OS で秒に正規化済み＝**読み口が OS 無関係**（§7-3）。`TZ_UPTIME=1` で有効化。
- [hysteresis.js](hysteresis.js) … しきい値プローブ共有の**判定部品**（シュミットトリガ＝二閾値＋任意デバウンス）。
  純ロジック・IO なし。disk（即時）/ memory（デバウンス）/ nic（below=false）が載る。`makeThreshold({low,high,below,debounce}).feed(v)→'enter'|'exit'|null`。
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

**初例：[git.js](git.js)** — 監視リポ（`TZ_GIT_REPO`）を `git status --porcelain=v2 --branch` で readonly に読み、
**二つの独立した二値遷移**を投げる：未コミットの clean↔dirty（`git.dirty`/`git.clean`）と、未 push の
ahead↔同期（`git.unpushed`/`git.pushed`、`# branch.ab` から ahead を読む・upstream 無しは催促しない）。
`ctx.n`＝未コミット数・`ctx.ahead`＝未 push 数・`ctx.repo`＝リポ名を LLM persona が織り込む。コミットは
clean と unpushed を同時に起こすので、clean を先に返し unpushed を次の poll に繰り越す（1 poll に 1 遷移）。
コマンド実行は `opts.run` 注入でテストし、実 git は叩かない（`git.test.js`）。soft を構造で守る＝*読むのは固定の readonly 一点*。

**しきい値型：[disk.js](disk.js)** — git が二値遷移なのに対し、こちらは `df` の空き率が `TZ_DISK_MIN_PCT`
（既定 10）を割ったかで `disk.low`/`disk.ok`（weather・work.N と同じしきい値またぎ）。同じイベント源
パターンが**二値でもしきい値でも回る**ことを示す。`ctx.freePct`/`ctx.freeGb` を LLM が織り込む。

**デバウンス型：[memory.js](memory.js)** — `/proc/meminfo` の空きメモリ率。ディスクと違い**瞬間値でジャギジャギ
跳ねる**（ビルドで一瞬食う）ので、しきい値またぎを N 回連続で見て初めて確定する（スパイクを弾く）。
`ctx.availPct`/`ctx.availGb` を LLM が織り込む。

**二値型：[net.js](net.js)** — オンライン/オフライン（`/sys/class/net` の operstate）。しきい値も差分も要らない
HA・git と同じ素の二値遷移。`net.online` で `ctx.iface`（経路）を添える。

**レート型：[nic.js](nic.js)** — `/proc/net/dev` の累計バイトは*カーネルが時間積分済みのカウンタ*なので、
**2 点読んで差分÷経過時間**でレート（MB/s）にする（瞬間値でなく窓平均＝軽いローパス）。「大きいほど警戒」
なので hysteresis を **below=false** で使う。`ctx.mbps` を LLM が織り込む。時計は `opts.now` 注入でテスト。

**ゲート付きしきい値型：[battery.js](battery.js)** — disk と同じ残量しきい値だが、**ブール条件（放電中か）で
ゲートする**のが新しい肝：残量が低くても**電源に繋がっていれば警告しない**（充電中に「切れそう」は嘘）。
これを別ロジックにせず型に閉じ込めるため、hysteresis には「放電中なら実残量・それ以外は安全値 100」を流す
——`battery.low` は放電中にしか入らず、繋ぎ直せば 100 が流れて exit＝`battery.ok`。第二の軸（git の dirty/ahead と
同型）で `Full` 繋ぎっぱを `battery.full`（電池いたわり）。git〜nic が「開発者の机」寄りだったのに対し、
**ノート利用者全員**に効く readonly はこれ——**開発者ニッチより、コンピュータを触る大多数に届く観察を優先**する転回点。
`ctx.capacity`/`ctx.charging` を LLM が織り込む。

**ゲート付きしきい値型（その2）：[thermal.js](thermal.js)** — `/sys/class/thermal/*` の複数ゾーンの**最大**を
「いちばん熱いところ」として見る。nic と同じ below=false（大きいほど警戒）に、一瞬の負荷でツンと跳ねる温度の
スパイク弾き（デバウンス 3・両方向）を足す。`TZ_TEMP_HOT_C`（既定 80℃）超えで `temp.hot`、冷えて `temp.ok`。
膝の上が熱い・ファンが唸るは万人の体感。`ctx.tempC` を LLM が織り込む。

**ばたつき対策＝共有部品 [hysteresis.js](hysteresis.js)**：threshold プローブの「ばたつき（flapping）」は
二要因あり、別レイヤで潰す——①**縁のチャタ**（値が閾値付近でゆらぐ）→ **シュミットトリガ**（low/high の
二閾値・帯の中は維持）②**スパイク**（一瞬だけ跨ぐ）→ **デバウンス**（N 連続で確定）。`makeThreshold` が
両方を持ち、disk は debounce=1（容量はゆっくり）、memory は debounce=3（30 秒 tick で約 90 秒の継続）、
nic は below=false＋debounce=2。これで遷移型は **二値（git/HA/net）／即時しきい値（disk）／デバウンス
しきい値（memory）／レート（nic）／ゲート付きしきい値（battery）／温度（thermal）／両側帯（湿度）** が揃った。battery は
hysteresis をそのまま使いつつ、**流す値の側でゲートする**（放電中=実値・充電中=安全値）ことでブール条件を
別レイヤを足さずに型へ畳み込んだ例。thermal は最大ゾーン＋両方向デバウンスの below=false 型。
**両側帯＝[hysteresis.js](hysteresis.js) の `makeBand`**：disk/battery が「片側（小さい/大きいほど悪い）」だったのに対し、
湿度は **「真ん中が幸せ」**——低すぎ（乾燥）も高すぎ（じめじめ）も警戒し、快適帯 [low,high] の中は黙る。状態は
`low`/`ok`/`high` の三つで、極から戻るには margin だけ余分に戻る（両端にシュミットトリガを置いた格好）＋debounce。
makeThreshold（片側・enter/exit）の対になる新 factory。**[humidity.js](humidity.js) が初例・[roomtemp.js](roomtemp.js)（室温）が二例目**で、
同じ band を意味づけだけ変えて使い回す。注意：**CO2 は band でなく片側**（low 側の害が無い）＝同じ「室内環境」でも量の性質で型が分かれる（[co2.js](co2.js)）。

**「部屋の中」六本（ha.js の上）で判定型が出揃った**：湿度・室温＝両側帯（makeBand）／CO2＝片側 below=false（大きいほど悪い）／
**[illuminance.js](illuminance.js) 照度＝片側 below=true（小さいほど悪い＝暗い・disk/memory と同系）**／**[opening.js](opening.js) ドア窓＝二値遷移（home-assistant 在席と同型）**。
HA の同じ REST 読み（ha.js）の上で、量の性質に応じて makeBand / makeThreshold(両向き) / 二値 を選ぶだけ——「センサ＝数値（or 状態）」を situation に翻訳する層が型を吸収している証拠。
**ゴミ箱 [trash.js](trash.js)** も同じ below=false の件数しきい値（掃除ナッジ・`ctx.n`）で、型としては
nic/thermal と同系——「机に座る人全員」向けの観察をしきい値型で増やした一本。**CO2 [co2.js](co2.js)** も同型
（below=false・大きいほど悪い・`TZ_CO2_HIGH` 既定 1000ppm で `co2.stuffy`／`ctx.ppm`）＝湿度が両側だったのに対し
CO2 は「低すぎて困る」が無いので片側。HA の同じ sensor 読み（ha.js）でも、湿度＝両側帯・CO2＝片側と**判定型が分かれる**好例。

**しきい値ではない型・その2＝時計だけの型：[resume.js](resume.js)** — /sys も /proc も読まない soft の極北。
**poll が呼ばれる実時計間隔**を測り、想定 tick よりずっと長い空白を「マシンが寝ていた＝スリープ復帰」とみなす。
観察対象すら無く、時間の経過だけが信号。nic と同じ `opts.now` 注入でテストする。activity（idle 離席）が
プロセスごと止まる領域は捉えられないのを埋める。

**resume の双子＝[uptime.js](uptime.js)** — resume が「マシンが寝ていた」を空白で拾うのに対し、こちらは
`os.uptime()`（システム連続稼働秒）が長くなりすぎたら「ずっと再起動していない＝起きっぱなし」を拾う（`uptime.long`＝
「そろそろ再起動したら?」）。型は trash と同じ below=false の閾値（大きいほど警戒・ゆっくり伸びるのでデバウンス 1）だが、
**回復遷移を出さない単方向ナッジ**なのが新しい点：uptime はプロセス生存中は単調増加し、短くなるのは再起動時だけ＝
佇かは自動起動サービスなので**マシン再起動＝佇か自身も再起動して状態がまっさら**になる。だから回復（exit）は同一プロセス内で
原理的に起きず、enter だけを `uptime.long` に写し exit は捨てる（persona に出ない死にタグを足さない）。`makeThreshold` の
「初回は基準だけ」規律が、既に長稼働のマシンで佇かが起動し直したとき warn を基準に取って黙る＝**再起動直後に説教しない**を
無料でくれる。`os.uptime()` は node が全 OS で秒に正規化済み＝**読み口が OS 無関係**（§7-3 の resume/git/download に並ぶ四本目）。

これで「机に座る人全員」に効く一群（電池・温度・ダウンロード・ゴミ箱・スリープ復帰・連続稼働）が揃った——**git/CI の
ような開発者ニッチより、コンピュータを触る大多数に届く観察を優先**する方針の実体。soft 委譲は「家の中が
少し見えてる同居人」だが、その“家”は開発部屋とは限らない。

**しきい値ではない型・その1＝エッジ（出来事）型：[download.js](download.js)** — サンプル値を持たず、監視
フォルダの **readdir 差分**で「新しいファイルが現れた瞬間」を一度だけ拾う。状態のまたぎでなく**離散イベント**。
途中ファイル（`.crdownload`/`.part`）は確定まで数えず、プライバシーで**件数だけ**（名前は乗せない）。
「机に座る人全員に効く readonly を優先」という転回の、開発者ニッチから最も遠い例（伺かの さくらが一番やる反応）。

### 7-2. 将来：open-ended な delegate seam（要るとわかってから）

「何でも自分で調べに行く部下」が本当に欲しくなったら、外向きの `delegate(query) → text` を足す。
戻り値の落とし所は入力と同じ（結果が `situation` の ctx）で protocol 不変。頭脳には **ReadOnly の
サブエージェント**を据える——第一候補は**自作 PawAgent に ReadOnly autonomy 段＋構造化出力を足したもの**
（README §7-1）。ReadOnly 段が soft の境界で、autonomy を上げる＝hard 化＝§1 を意識的に上書きする
**意図的スイッチ**。サードパーティ（ZeroClaw 等）より中身を把握した自前を優先する。要ると分かるまで作らない。

### 7-3. OS 別バックエンド（Win/Mac）— 同じ IO 注入境界で差し替える【決定・2026-06-09】

現状サーバ（頭脳）は**実質 Linux 専用**。host 観察プローブは全部 Linux 固有口を読む（`/sys/class/power_supply`・
`/sys/class/thermal`・`/proc/meminfo`・`/sys/class/net`・`/proc/net/dev`・freedesktop `~/.local/share/Trash`・
X11/Wayland idle）。Win/Mac では**壊れず PE で `null` に縮退**（佇かは喋るが家の中は見えない）。

**移行の足場は既に切ってある**：各プローブの IO は注入境界（`opts.readPower` / `opts.readTemps` / `opts.read` /
`opts.run` / `opts.now`）で外に出してある。OS 対応は**この境界の内側を差し替える**だけで、`poll()` 契約も
situation 語彙も protocol も不変。判定ロジック（hysteresis・遷移検知・ゲート）は OS 非依存なので**そのまま再利用**できる。
つまり「縮退して黙る」今の作りが、そのまま OS 別バックエンドの土台になっている。

**決定①：特権は一切上げない（線引きの芯）。** 普通のユーザーで読めるものだけ OS 別に対応し、特権（root/管理者/
特別な entitlement）が要るものは**取りにいかず、今まで通り `null` 縮退で黙る**。佇かは「家の中が少し見えてる
**同居人**」であって監視ソフトではない（§7-1 の PE と「soft を約束でなく構造で守る」の延長）——同居人は鍵の
かかった部屋の鍵を要求しない。sudo/管理者昇格を求めた瞬間に soft の境界を OS を跨いで踏み越える。だから
特権昇格は技術可否でなく「佇かが何者か」の問題として却下。これで各プローブは連続的な「どこまで権限を取るか」では
なく**二値「普通のユーザーで読めるか/読めないか」**で振り分けるだけになる（縮退は新しく足すのでなく、既存の
「読めない /sys は null で黙る」がもう 1 OS でも起きるだけ。コードの作りは歪まない）。具体的に **thermal だけが
Mac/Win で特権側に落ちる**＝対応 OS でも黙る。

**移植マトリクス（2026-06-09・Mac＋Win 全 landed 後／uptime は 2026-06-10 に OS 無関係で追加）：** thermal を除く 10 本が三 OS で観察に到達。

| プローブ | 読み口 | Linux | Mac | Win | 対応の所在 |
|---|---|:--:|:--:|:--:|---|
| resume | 時計のみ（`opts.now`） | ✓ | ✓ | ✓ | **既に OS 無関係**（読むものが無い） |
| uptime | `os.uptime()`（`opts.uptime`） | ✓ | ✓ | ✓ | **既に OS 無関係**（node が秒に正規化済み・platform 分岐ゼロ） |
| git | `git status`（`opts.run`） | ✓ | ✓ | ✓ | **既にクロス**（git はどこでも git） |
| download | `readdir ~/Downloads` | ✓ | ✓ | ✓ | **ほぼクロス**（標準パス・readdir 不問） |
| disk | `df -kP`（`opts.run`） | ✓ | **✓実証** | **✓実証** | Mac は df 無改修（実機 10.15.7）／Win=`Win32_LogicalDisk`（実機 tiny10） |
| battery | `/sys/class/power_supply` | ✓ | **✓実証** | **✓実証** | Mac=`pmset -g batt`・Win=`Win32_Battery`（BatteryStatus 正規化）。VM は電池無しで null 縮退 |
| memory | `/proc/meminfo` | ✓ | **✓実証** | **✓実証** | Mac=`vm_stat`＋`sysctl hw.memsize`・Win=`Win32_OperatingSystem`（Free/TotalVisible kB） |
| net | `/sys/class/net/*/operstate` | ✓ | **✓実証** | **✓実証** | Mac=`ifconfig`（RUNNING/非 LOOPBACK）・Win=`Win32_NetworkAdapter`（物理／NetConnectionStatus==2） |
| nic | `/proc/net/dev` | ✓ | **✓実証** | **✓実証** | Mac=`netstat -ibn`・Win=`Win32_PerfRawData_Tcpip_NetworkInterface`（"Persec" 名でも生の累計） |
| trash | `~/.local/share/Trash` | ✓ | **✓実証** | **✓実証** | Mac=`~/.Trash`（場所だけ差）・Win=`$Recycle.Bin` の `$R*` 再帰カウント（構造が違うので専用 read） |
| **thermal** | `/sys/class/thermal` | ✓ | ✕ | ✕ | **特権側＝両 OS で縮退のまま**（決定①。Mac は `pmset -g therm` が "No thermal..."、Win も非特権では読めない） |

→ Linux ロックだった **/sys + /proc + freedesktop-trash 群**（memory/net/nic/battery/trash）は Mac＋Win とも
正規化境界の内側を差し替えて解消。残るのは特権側の thermal だけ（決定①でそもそも取りにいかない）。

**決定②：依存ゼロは維持できる。** Win=PowerShell `Get-CimInstance`、Mac=`pmset`/`vm_stat`/`df`/`netstat` で全部
CLI 越しに読める＝SDK 不要、既存の `opts.run` 境界にそのまま乗る。正直な穴 2 つを明記しておく：(a) PowerShell の
spawn は重い（~100–300ms）ので毎 tick poll に響く→キャッシュ/間引きが要る、(b) thermal は決定①で縮退のまま。

**確定③：`process.platform` 分岐は各 `defaultReadXxx` 内の named 関数で dispatch。** `defaultReadPower` の中で
`readPowerLinux` / `readPowerMac`（将来 `readPowerWin`）に振り分ける（OS 固有の読みが situation 語彙の隣に居る＝凝集・
新抽象ゼロ）。dispatch は `opts.platform ?? process.platform` を見る小さな選択だけ。**test seam は読み口の全置換
（`opts.readPower` 等）に加え、CLI 経路用に `opts.run` ＋ OS 強制の `opts.platform` を足す**（実 pmset/df を叩かず注入）。
共有 helper 化（platform.js）や OS 別ファイル分割は、分岐ロジックが散って辛くなってからでよい（今は不要）。

**第一実装の到達点（2026-06-09）：**
- **disk**（Mac）：OS 固有の読みを持たず `df -kP` 一本なので Linux の defaultRun が無改修で効く。実機 macOS
  10.15.7（osx-kvm）の df 実出力を注入する回帰テストで裏取り（マウント先の空白行も % 列までしか見ないので無害）。
- **battery**（Mac）：OS 固有の読みが要る最初の例。`pmset -g batt` を Linux 語彙 `{capacity,status,acOnline}` に
  正規化し、充電ゲート・ヒステリシス・満充電遷移の判定は無改修で再利用＝**正規化境界が OS 差を吸収する**ことを実証。
  電池無しの fixture は実機 VM の pmset verbatim＝デスクトップ/VM は null 縮退（決定①）。
- **memory/net/nic/trash**（Mac・2026-06-09 landed）：同じ正規化境界で実装。memory=`vm_stat`＋`sysctl hw.memsize`
  （available は free+inactive+speculative+purgeable の近似）・net=`ifconfig`（RUNNING を up・LOOPBACK 除外）・
  nic=`netstat -ibn`（`<Link#` 行の Ibytes+Obytes・重複アドレス行を除外）・trash=場所だけ差（`~/.Trash`）。
  実機 verbatim のユニットテスト＋ライブ end-to-end（`run` を ssh 差し替え）でパーサ一致を確認。
- **CLI 実行の集約**：CLI を使う probe が 5 本（disk/battery/memory/nic/net）になったので `defaultRun` の重複を
  **`run.js`**（純 IO の小部品・`hysteresis.js` と同列）に切り出した。これは判定/IO を OS 非依存の小部品に
  寄せるだけで、上で警告した platform.js（OS 知識を集める god module）とは別物。
- **Win 全 6 本**（2026-06-09 landed）：同じ正規化境界で `readXxxWin` を各 dispatch に追加。disk=`Win32_LogicalDisk`
  （df 不在なので別 CLI・FreeSpace/Size バイト）・battery=`Win32_Battery`（BatteryStatus 1/4/5=放電・3=満充電・
  6〜9=充電に正規化）・memory=`Win32_OperatingSystem`（Free/TotalVisible kB）・net=`Win32_NetworkAdapter`（物理
  だけ／NetConnectionStatus==2 を up）・nic=`Win32_PerfRawData_Tcpip_NetworkInterface`（**"Persec" 名でも生の累計
  カウンタ**・名は parens→[]/slash→_ にサニタイズ）・trash=`$Recycle.Bin` の `$R*`（実体）を再帰カウント（$I は
  メタなので数えない＝場所だけ差で済む linux/mac と違い専用 read）。全部 `opts.run` 越しの PowerShell＝SDK 不要・
  特権ゼロ。出力は CRLF なので各 parser は `\r` を吸収。Win 固有の引数は execFile の argv 安全のため**シングル
  クォートだけ**で書く（disk は `-Filter` でなく `Where-Object`）。
- **Win の検証経路**（tiny10 は削り込み版で OpenSSH も node も無い）：Mac の「`run` を ssh 差し替え」が使えないので、
  ホスト（vindalfr）に小さな HTTP サーバを立て、ゲストの PowerShell から `irm http://<gw>:8000/p.ps1 | iex` で
  **production コマンドの実出力を POST** させて回収。それを各 probe の `opts.run` に注入するライブ e2e で 6 本とも
  期待 situation（disk.ok 61%/23.8GB・電池無し→null・mem.low・net.online=Ethernet・nic.busy・trash.full）を確認＝
  **fixture が実機 tiny10 verbatim であること＋ production コマンド文字列が実 Windows で通ることまで**を担保。
  回帰テストは実出力 verbatim の const（電池/温度は VM で取れないので Mac と同じく null 縮退側のみ実機・残りは
  安定フォーマットの構築文字列）。

**到達の射程は OS と導入の別軸。** OS バックエンドは「観察の到達」（この OS で家が見えるか）を広げるが、
**到達の本丸は導入**——`git clone`＋node＝開発者の作法から、自動起動つきのエンドユーザー配布へ。
**Linux=systemd user／macOS=launchd は landed**（[../deploy/](../deploy/README.md)・2026-06-09 各実機で実証）、
Win=Task Scheduler（ログオン＋時刻トリガ）も実機 tiny10 で全 e2e landed（2026-06-10・起動＋クラッシュ自動復活）。導入は OS バックエンドとは独立した別議題（秘密は env へ逃がす・env 無くても起動）。
§7-1 の「観察の射程（大多数向け）」とここの「到達の射程（OS×導入）」を混同しない。OS は既存 seam の内側で安く済む／導入は別途。
