# server/ — 佇か本体（デーモン）

将来ここが「頭脳」になる：WS サーバー・人格・イベント処理（README §4）。
**依存ゼロ**（node 標準モジュールのみ、node_modules 無し）。

| ファイル | 責務 |
|---|---|
| `serve.js` | エントリ。HTTPS 静的配信（client/）＋ WS を同一オリジンに張る |
| `ws.js` | 依存ゼロの WebSocket（RFC6455）。`upgrade` に相乗り。マスク解除・フレーム生成・ping/pong・close |
| `behavior.js` | 「**いつ・どんな状況で喋るか**」（トリガ・間・presence/motion の副作用）。protocol v0 の server 側 |
| `persona.js` | 「**何を喋るか**」（situation タグ → 台詞）。**LLM の継ぎ目はここ**。M4 はルールベース |

## 動かし方

```sh
node server/serve.js          # → https://durandal:8443/ ＋ wss://durandal:8443/ws
PORT=9000 node server/serve.js
```

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

## HTTPS / 証明書（mkcert で決定：2026-06-08）

`getUserMedia` / `DeviceOrientation` は HTTPS 必須（README §6）。方式は **mkcert** に決めた：
LAN 完結・枯れてる・外部サービス不要。Tailscale 案は「外から佇かに会いたい」が出てきたら再検討。

- 証明書は `server/certs/cert.pem` / `key.pem`。**git 管理外**（.gitignore 済み）。
- 再生成（IP やホスト名が変わったとき）：

```sh
mkcert -cert-file server/certs/cert.pem -key-file server/certs/key.pem \
  durandal durandal.local 192.168.1.99 localhost 127.0.0.1
```

### iPad（表示端末）の初回セットアップ — root CA を一度だけ信頼させる

mkcert のローカル CA を端末に入れる。**端末ごとに一回だけ**の作業。

1. この PC で root CA を一時配信する：
   ```sh
   python3 -m http.server 9000 -d "$(mkcert -CAROOT)"
   ```
2. iPad の Safari で `http://192.168.1.99:9000/rootCA.pem` を開く →「プロファイルをダウンロード」を許可
3. 設定 → 一般 → VPN とデバイス管理 → ダウンロード済みプロファイル → **インストール**
4. **ここを忘れると無効**：設定 → 一般 → 情報 → 証明書信頼設定 → mkcert の root を**オン**
5. 一時配信（手順1）を止める

以後、iPad の Safari で `https://192.168.1.99:8443/?label=リビングのiPad` を開けば緑の鍵で佇かが出る。

## 設計メモ

- client/ を**この server が配信する**ことで、オリジンが一つになり HTTPS 終端も一箇所で済む（README §8）。
  WS を足すときも同じオリジン（`wss://` 同一ホスト）に張るだけになる。
- 依存ゼロ（node:https のみ）。`package.json` は `"type": "module"` の宣言だけ。
  依存を入れるのは M3 で ws を検討するときに最小限で。
- systemd user サービス化（将来）を見据えて、パスは `server/serve.js` から動かさないこと（CLAUDE.md）。
