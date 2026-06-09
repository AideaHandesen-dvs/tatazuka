# deploy/ — 導入（自動起動）

佇か本体（`server/`）を OS の仕組みで**黙って起動・自動再起動**させる設置物。

これは「到達」の軸であって「観察」の軸ではない（connectors/README.md §7-3 の区別）：OS 別バックエンドが
「この OS で家が見えるか」を広げたのに対し、ここは「`git clone`＋node＝開発者の作法」を**エンドユーザー
配布**へ引き上げる。両者は独立。

| OS | 仕組み | 状態 |
|---|---|---|
| Linux | systemd **user** サービス（`systemd/tatazuka.service`） | ✅ landed（2026-06-09・実機 Linux で動作確認） |
| macOS | launchd（LaunchAgent plist） | ⬜ これから |
| Windows | Task Scheduler（ログオン時タスク） | ⬜ これから |

設計上の約束（共通）：

- **オリジン一つ・HTTPS 終端一箇所**（CLAUDE.md / README §8）。serve.js が `client/` を静的配信し
  wss も同一ホスト。導入はこの構成を変えない。
- **秘密は unit/plist に書かず env ファイルへ逃がす**（`TZ_HASS_TOKEN` / `ANTHROPIC_API_KEY` 等）。
- **env が無くても起動する**（ルールベースで喋る＝プログレッシブ・エンハンスメント）。
- リポジトリは `~/tatazuka` に clone されている前提（リポ名・`server/` パスは改名禁止＝systemd 化の布石）。

---

## Linux（systemd user サービス）

ユーザー権限だけで完結する（root 不要）。ログイン中だけでなく**ログアウト後も動かす**なら linger を有効化する。

```sh
# 0) 前提：~/tatazuka に clone 済み・node 入り・証明書が server/certs/ にある
#    （証明書の作り方は server/README.md / README クイックスタート）

# 1) env（要るものだけ。空でもルールベースで起動する）
mkdir -p ~/.config/tatazuka
cp ~/tatazuka/deploy/systemd/tatazuka.env.example ~/.config/tatazuka/tatazuka.env
chmod 600 ~/.config/tatazuka/tatazuka.env
$EDITOR ~/.config/tatazuka/tatazuka.env        # 要る TZ_* のコメントを外す

# 2) unit を設置して有効化
mkdir -p ~/.config/systemd/user
cp ~/tatazuka/deploy/systemd/tatazuka.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tatazuka

# 3) 確認
systemctl --user status tatazuka
journalctl --user -u tatazuka -f             # 起動ログ（人格/天気/connectors の on/off が出る）

# ログアウト後も常駐させる（任意・一度だけ）
loginctl enable-linger "$USER"
```

運用：

```sh
systemctl --user restart tatazuka            # 設定変更を反映
systemctl --user disable --now tatazuka      # 停止＋自動起動オフ
```

- **WorkingDirectory / ExecStart** は unit が `%h/tatazuka`（＝`~/tatazuka`）を見る。別の場所に置くなら
  unit を書き換える。`/usr/bin/env node` 経由なので node の場所には依存しない。
- **証明書が無い**と serve.js は起動時に落ちる（HTTPS 終端なので必須）。`journalctl` に出る。
- **天気/Home Assistant が network を要する**が、無くても PE で黙るだけ。だから unit は network を
  必須依存にせず `After=network.target` の順序付けだけ与えている。

## macOS / Windows

これから（上表）。OS 別バックエンド（§7-3）の検証に使った VM ラボ（osx-kvm / tiny10）でそのまま実地確認する。
plist / スケジュールタスクも「秘密は env へ・無くても起動」の同じ約束で書く。
