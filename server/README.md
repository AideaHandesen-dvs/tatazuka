# server/ — 佇か本体（デーモン）

将来ここが「頭脳」になる：WS サーバー・人格・イベント処理（README §4）。
いまあるのは **M3 前倒しの HTTPS 静的配信だけ**（`serve.js`、依存ゼロ）。
WS は M3、本格的な人格は M4 で足す。

## 動かし方

```sh
node server/serve.js          # → https://durandal:8443/ （LAN なら https://192.168.1.99:8443/）
PORT=9000 node server/serve.js
```

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
