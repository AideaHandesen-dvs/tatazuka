# server/ — 佇か本体（デーモン）

将来ここが「頭脳」になる：WS サーバー・人格・イベント処理（README §4）。
**依存ゼロ**（node 標準モジュールのみ、node_modules 無し）。

| ファイル | 責務 |
|---|---|
| `serve.js` | エントリ。HTTPS 静的配信（client/）＋ WS を同一オリジンに張る |
| `ws.js` | 依存ゼロの WebSocket（RFC6455）。`upgrade` に相乗り。マスク解除・フレーム生成・ping/pong・close |
| `behavior.js` | 佇かの振る舞い（人格の素）。protocol v0 を server 側として実装。**M4 でここを育てる** |

## 動かし方

```sh
node server/serve.js          # → https://durandal:8443/ ＋ wss://durandal:8443/ws
PORT=9000 node server/serve.js
```

## protocol v0 の server 側実装（M3）

- WS は **同一オリジンの `/ws`**（protocol §1：オリジン一つ・wss 同一ホスト）。`serve.js` の HTTPS
  サーバーに `attachWS` で相乗りさせる。別ポートにはしない。
- `ws.js` は小さい JSON テキストフレーム専用に割り切った自前実装。`ws` ライブラリは入れない
  （`git clone && node server/serve.js` で即動く self-contained さを優先）。binary フレームは無視、
  断片化は連結対応、背圧は LAN・小メッセージ前提で見ない。
- `behavior.js` は M2 の `client/mock-server.js` から振る舞いを移植したもの。体験は変えず本物化した。
  トランスポート非依存（`createSession({send})→{receive,close}`）。接続ごとのタイマーは `close()` で掃除する。
- 再接続時の hello 打ち直し（protocol §6-2）は **client 側の `ws-client.js`** が担当。server は
  毎回新規接続として扱い、`resumed:true` の hello を見たら「落ちてたぞ」と茶々を入れる（§6-3）。

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
