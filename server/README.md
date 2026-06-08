# server/ — 佇か本体（デーモン）

将来ここが「頭脳」になる：WS サーバー・人格・イベント処理（README §4）。
**依存ゼロ**（node 標準モジュールのみ、node_modules 無し）。

| ファイル | 責務 |
|---|---|
| `serve.js` | エントリ。HTTPS 静的配信（client/）＋ WS を同一オリジンに張る |
| `ws.js` | 依存ゼロの WebSocket（RFC6455）。`upgrade` に相乗り。マスク解除・フレーム生成・ping/pong・close |
| `behavior.js` | 「**いつ・どんな状況で喋るか**」（トリガ・間・presence/motion の副作用）。protocol v0 の server 側 |
| `persona.js` | 「**何を喋るか**」（situation タグ → 台詞）。**台詞生成の継ぎ目**。ルールベース（手書き表） |
| `persona-llm.js` | persona の LLM 版。同じ `line()` の顔で、環境系の台詞だけ LLM 生成（反応系・失敗時は `persona.js` にフォールバック） |
| `serve-ca.js` | 使い捨ての CA 配信。表示端末に root CA を信頼させる初回作業用（下記） |

## 動かし方

```sh
node server/serve.js          # → https://<このマシン>:8443/ ＋ wss://<このマシン>:8443/ws
PORT=9000 node server/serve.js

cd server && npm test         # 人格層の契約テスト（node:test・依存ゼロ）
```

テストは人格層の壊れやすい継ぎ目を固定する：

- **フォールバック契約**（`persona-llm.test.js`）：LLM 不在/反応系 sense.*/未知/失敗/
  タイムアウト/壊れた出力 → ルール表。mood は §4-3 語彙に丸め、散文混じりでも最初の `{...}` を拾う。
- **非同期 say の安全性**（`behavior.test.js`）：「await 後の closed 再チェック」＝生成中に切断
  したら発話を漏らさない。
- **provider のリクエスト整形**（`persona-llm.provider.test.js`）：fetch をスタブし、ollama は
  `format:json`、claude は temperature 等を**送らない**（Opus 4.8 で 400 の地雷）ことを固定。
- **実 LLM スモーク**（`persona-llm.smoke.test.js`）：ローカル ollama に 1 回投げ、出力契約が
  本当に通るか確認。**ollama 不在なら自動 skip**（CI/ネット不要を維持）。`TZ_SMOKE_MODEL` で
  モデル上書き（既定 `qwen2.5:3b`）。

`<このマシン>` は `localhost`、またはホスト名 / 表示端末から届く LAN IP（例 `192.168.x.x`）。

## protocol v0 の server 側実装（M3）

- WS は **同一オリジンの `/ws`**（protocol §1：オリジン一つ・wss 同一ホスト）。`serve.js` の HTTPS
  サーバーに `attachWS` で相乗りさせる。別ポートにはしない。
- 静的配信は `.vrm`/`.glb`/`.wasm` の MIME も返す。`HEAD` は `fs.stat` だけで応答（VRM 存在チェックで
  10MB を毎回読まないため）。client の `vendor/`（three.js 等）も `models/` の .vrm も同じ origin から配る。
- `ws.js` は小さい JSON テキストフレーム専用に割り切った自前実装。`ws` ライブラリは入れない
  （`git clone && node server/serve.js` で即動く self-contained さを優先）。binary フレームは無視、
  断片化は連結対応、背圧は LAN・小メッセージ前提で見ない。
- `behavior.js` は M2 の `client/mock-server.js` から振る舞いを移植したもの。体験は変えず本物化した。
  トランスポート非依存（`createSession({send})→{receive,close}`）。接続ごとのタイマーは `close()` で掃除する。
- 再接続時の hello 打ち直し（protocol §6-2）は **client 側の `ws-client.js`** が担当。server は
  毎回新規接続として扱い、`resumed:true` の hello を見たら「落ちてたぞ」と茶々を入れる（§6-3）。

## 人格エンジン（M4）

**「いつ喋るか」(behavior) と「何を喋るか」(persona) を分離**した。ハイブリッド方針：M4 は
ルールベースで完結（軽い・オフライン・予測可能）、LLM は後で persona を差し替えて足す。
LLM が無くても佇かは喋る＝人格層でもプログレッシブ・エンハンスメント。

- `persona.js` の `createPersona().line(situation, ctx)` が **台詞生成の継ぎ目**。situation タグ
  （例 `greet` / `work.180` / `sense.nade.warm`）→ `{text, mood}`。未知の situation は `null`（＝喋らない）。
  将来の LLM 版はこの `line()` と同じ顔で実装すれば behavior.js を一切触らず差し替わる。
- イベント源（M4 で実装）：
  1. **触られた**（sense → 段階反応。protocol §5）
  2. **時刻帯**（朝/昼/夕/夜/深夜。在席中にバンドをまたぐと一言＋深夜接続には就寝を促す）
  3. **在席・連続時間**（接続継続を「作業時間」の代理に。60/120/180 分で「3時間やってるぞ」系）
- **PC作業監視・天気・LLM は別マイルストーン**。在席時間は PC 監視の要らない代理指標
  （ただし再接続で連続時間はリセットされる。§6-2 で server は接続をまたがないため。M4 の割り切り）。
- `createSession({ send, persona?, now?, tickMs? })`：`now`/`tickMs` はテスト・デモで「間」を
  早送りするための注入（既定は実時間）。例：`tickMs: 5, now: ()=>fakeClock` で 3 時間ナグを即確認できる。

### LLM persona（`persona-llm.js`）— 「何を喋るか」を生成に格上げ

ルール表の固定台詞を、その場の生成に置き換える層。**`persona.js` の `line()` と同じ顔**
（`line(situation, ctx) → {text,mood}|null`）で実装してあるので、behavior.js は一切触らない。
卵 → VRM と同じ「格上げ」の発想を人格層でやる（§5 プログレッシブ・エンハンスメント）。

設計判断（2026-06-08 にユーザーと確定）：

- **`line()` を非同期化した。** 生成は喋る瞬間に走らせ、ctx（状況）をその場で織り込む。
  behavior.js 側は `say` が `await p.line(...)` するだけ（`await` は同期値にも効くので、
  ルール persona は無傷）。**生成中にセッションが切れることがあるので、await の後に
  `closed` を再チェックしてから送る**——非同期化で唯一の落とし穴。protocol は不変、
  変わったのは server 内の behavior↔persona の継ぎ目だけ。
- **環境系の situation だけ LLM。** `idle` / `time.*` / `work.*` / `greet` / `walk.back` など
  「一拍おいて喋ってよい」ものを生成する。**反応系（`sense.*` ＝つつく/なでる/揺らす）は
  即レスが命なので手書き表のまま**（LLM の遅延が許されない場所を LLM にしない）。
  振り分けは `persona-llm.js` 内の `LLM_SITUATIONS` で持つ。
- **フォールバックは常にルール表。** LLM 不在・遅い・失敗・出力が壊れている → 内部に抱えた
  `createPersona()` の `line()` を返す。**LLM が無くても佇かは喋る。**

provider は両対応（env で切替）。**依存ゼロ維持**のため Node 18+ のグローバル `fetch` を使い、
SDK は入れない（`ws` を自前実装したのと同じ方針）：

| env | 既定 | 説明 |
|---|---|---|
| `TZ_LLM` | （未設定＝LLM オフ） | `ollama` か `claude`。未設定なら `serve.js` は従来のルール persona を使う |
| `TZ_LLM_MODEL` | provider 既定 | モデル名 |
| `TZ_CHARACTER` | `tatazuka` | ゴースト（人格）を名前で選ぶ → `characters/<名前>.txt`。LLM 有効時のみ効く |
| `OLLAMA_HOST` | `http://localhost:11434` | ollama 接続先 |
| `ANTHROPIC_API_KEY` | — | `claude` 時のみ必須 |

**キャラは差し替えられる（ゴースト）。** `CHARACTER`（誰か＝差し替え対象）と `OUTPUT_RULE`
（tatazuka 固定の JSON 出力契約）を分離してある。人格は `characters/<名前>.txt` に外出しされ、
`TZ_CHARACTER` で選ぶ（既定 `tatazuka`、同梱に執事 `shitsuji`・妹 `imouto`）。読めなければ組み込みの
佇かにフォールバック＝ゴーストを全部消しても佇かは喋る。足し方・フォーマットは
[characters/README.md](characters/README.md)。伺かの `ghost/<名前>/` を 1 ファイルに簡略化したもの。

- **ollama**：`POST {OLLAMA_HOST}/api/chat`（`stream:false`, `format:"json"`）。既定モデルは環境依存
  なので `TZ_LLM_MODEL` で指定（例 `qwen2.5:3b` 等の軽量モデル）。オフライン・無料・ローカル完結。
- **claude**：`POST https://api.anthropic.com/v1/messages`（`anthropic-version: 2023-06-01`、
  `x-api-key`）。既定モデルは `claude-opus-4-8`。**短い台詞なら遅延・コスト的に
  `TZ_LLM_MODEL=claude-haiku-4-5` が実用的**。`temperature` 等は送らない（Opus 4.8 で 400）。

出力契約は両 provider 共通：**厳格 JSON `{"text": "...", "mood": "..."}`** をプロンプトで要求し、
`mood` は protocol §4-3 の語彙（通常/呆れ/疑い/喜び/怒り/照れ）。最初の `{...}` を取り出して
パースし、壊れていればルール表にフォールバック。

起動例：

```sh
# ローカル（ollama）。先に `ollama serve` と `ollama pull <model>` 済みであること
TZ_LLM=ollama TZ_LLM_MODEL=qwen2.5:3b node server/serve.js

# Claude API。台詞が短いので haiku で十分速い
TZ_LLM=claude TZ_LLM_MODEL=claude-haiku-4-5 ANTHROPIC_API_KEY=sk-ant-... node server/serve.js

# 何も指定しなければ従来どおりルールベースで動く（LLM 不要）
node server/serve.js
```

## HTTPS / 証明書（mkcert で決定：2026-06-08）

`getUserMedia` / `DeviceOrientation` は HTTPS 必須（README §6）。方式は **mkcert** に決めた：
LAN 完結・枯れてる・外部サービス不要。Tailscale 案は「外から佇かに会いたい」が出てきたら再検討。

- 証明書は `server/certs/cert.pem` / `key.pem`。**git 管理外**（.gitignore 済み）。
- 初回・再生成（IP やホスト名が変わったとき）。`<LAN-IP>` は表示端末から届くこのマシンの IP：

```sh
mkcert -install
mkcert -cert-file server/certs/cert.pem -key-file server/certs/key.pem \
  "$(hostname)" "$(hostname).local" localhost 127.0.0.1 <LAN-IP>
```

### 表示端末に root CA を信頼させる（端末ごとに一度だけ）

mkcert のローカル CA は、この PC だけが信頼している。表示端末（スマホ等）にも入れないと
`wss://` が拒否される。まず CA を配信する：

```sh
node server/serve-ca.js     # → http://<LAN-IP>:9000/tatazuka-rootCA.crt （済んだら Ctrl+C）
```

> `python3 -m http.server` で `rootCA.pem` を配るのは**ダメ**：Content-Type が合わず iOS が
> 「原因不明のエラー」で弾く上、CAROOT ごと配ると秘密鍵まで晒す。`serve-ca.js` は公開鍵だけを
> 正しい Content-Type で配る。

**iOS（iPad / iPhone）**
1. Safari で `http://<LAN-IP>:9000/tatazuka-rootCA.crt` を開く → ダウンロードを許可
2. 設定アプリの上部に出る **「プロファイルがダウンロード済み」**（または 設定 → 一般 → VPN とデバイス管理）→ **インストール**
3. **ここを忘れると無効**：設定 → 一般 → 情報 → **証明書信頼設定** → mkcert の root を**オン**

**Android（Chrome）**
1. Chrome で `http://<LAN-IP>:9000/tatazuka-rootCA.crt` を開く → ダウンロード
2. 設定 → セキュリティ → 暗号化と認証情報 → **証明書をインストール → CA 証明書**（警告は許可）→ 落としたファイルを選ぶ

以後、端末のブラウザで `https://<LAN-IP>:8443/?label=好きな名前` を開けば佇かが出る
（鍵マークに警告が出なければ成功。Safari は鍵が緑にはならない）。VRM が出るのは WebGL の効く端末
（Android 等）。古い iOS は CSS の簡易顔にフォールバックする（[../client/README.md](../client/README.md)）。

## 設計メモ

- client/ を**この server が配信する**ことで、オリジンが一つになり HTTPS 終端も一箇所で済む（README §8）。
  WS を足すときも同じオリジン（`wss://` 同一ホスト）に張るだけになる。
- 依存ゼロ（node:https のみ）。`package.json` は `"type": "module"` の宣言だけ。
  依存を入れるのは M3 で ws を検討するときに最小限で。
- systemd user サービス化（将来）を見据えて、パスは `server/serve.js` から動かさないこと（CLAUDE.md）。
