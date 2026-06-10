# deploy/ — 導入（自動起動）

佇か本体（`server/`）を OS の仕組みで**黙って起動・自動再起動**させる設置物。

これは「到達」の軸であって「観察」の軸ではない（connectors/README.md §7-3 の区別）：OS 別バックエンドが
「この OS で家が見えるか」を広げたのに対し、ここは「`git clone`＋node＝開発者の作法」を**エンドユーザー
配布**へ引き上げる。両者は独立。

| OS | 仕組み | 自動起動ユニット |
|---|---|---|
| Linux | systemd **user** サービス（`systemd/tatazuka.service`） | ✅ landed（2026-06-09・実機 Linux で動作確認） |
| macOS | launchd（LaunchAgent・`launchd/com.tatazuka.server.plist`） | ✅ landed（2026-06-09・osx-kvm Catalina で動作確認） |
| Windows | Task Scheduler（ログオン+時刻トリガ・`windows/tatazuka.xml` ＋ラッパー `windows/tatazuka-launch.ps1`） | ✅ **landed**（2026-06-10・実機 tiny10／Win10・PS5.1・node20 で全 e2e 実証：自走起動→HTTPS 200→**クラッシュ→別PIDで自動復活**＋node不在 fail-soft 127） |

上表の「landed」は**自動起動ユニットが効くこと**を指す。**インストーラとは別**。次節で分ける。

## 導入は二層に分かれる：自動起動ユニット ↔ エンドユーザー導入

「導入」と一口に言うが、実は層が二つある。混同すると「動いた」の意味を取り違える。

| 層 | 何をするか | ここでの状態 |
|---|---|---|
| **① 自動起動ユニット**（OS別） | 既に用意された佇か本体を、OS の仕組みで黙って起動・自動再起動・ログイン/起動時に立ち上げる | ✅ **Linux＋macOS＋Windows 全 landed**（各実機で起動＋クラッシュ自動復活を実証／上表） |
| **② エンドユーザー導入**（installer / bootstrap） | 前提（node ランタイム・repo 取得・証明書）を**一発で**揃え、①のユニットを登録する | ⬜ まだ。今は手順を**手で**踏む |

①が証明したのは「**plist / unit を置けば serve.js が自動で立ち上がり、落ちても復活する**」ことだけ。
②の前提——node を入れる・repo を持ってくる・HTTPS 証明書を作る——は、各 OS 節の「前提」に手順として
並べてあるが、**パッケージ化された一発インストーラはまだ無い**。たとえば macOS の検証では node を
prebuilt tarball で置き・repo を rsync で送り・証明書を openssl で焼いた（節参照）が、これは
「①ユニットが効くことの**実証**」であって「②インストーラ」ではない。

なぜ分けて書くか：①は OS ごとに薄く・枯れていて安い（既存 seam の内側）。②は「どの node を・どう入れ・
証明書をどう信頼させ・どう更新するか」という**配布の本丸**で、OS 横断の設計が要る別議題（README §7-3 が
「到達の本丸は導入」と言うのはこの②）。①が landed しても②は終わっていない。

> 検証が「手で前提を並べる」形になっているのは、ラボが**最小構成の VM**（観察プローブの裏取り用に
> 削り込んだもの）だからでもある。②の installer は、素直な実機/標準環境を相手に別途設計する。

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

## macOS（launchd LaunchAgent）

`launchctl` だけで完結する（root 不要）。LaunchAgent は **per-user・ログイン時起動**＝systemd `--user` の対。
plist は `~` も EnvironmentFile も展開しないので、起動を**ラッパー** `launchd/tatazuka-launch.sh` に一段噛ませ、
そこで env を外出し読み込み・node を解決する（「秘密は env へ・無くても起動」を移植）。

```sh
# 0) 前提：~/tatazuka に repo・node・証明書（server/certs/）が揃っている
#    - node は Homebrew でも prebuilt tarball でも可。tarball なら ~/opt/node を実体へ symlink:
#        ln -sfn ~/opt/node-vXX.X.X-darwin-x64 ~/opt/node
#      （ラッパーが PATH に ~/opt/node/bin を足す。macOS 10.15 Catalina は node 18 系が上限）
#    - 証明書：mkcert でも openssl でも可（HTTPS 終端に必須）:
#        openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=localhost" \
#          -keyout ~/tatazuka/server/certs/key.pem -out ~/tatazuka/server/certs/cert.pem

# 1) env（要るものだけ。空でもルールベースで起動する）
mkdir -p ~/.config/tatazuka
cp ~/tatazuka/deploy/systemd/tatazuka.env.example ~/.config/tatazuka/tatazuka.env
chmod 600 ~/.config/tatazuka/tatazuka.env
$EDITOR ~/.config/tatazuka/tatazuka.env

# 2) plist を実パスに展開して設置（__REPO__ / __HOME__ を置換）
mkdir -p ~/Library/LaunchAgents
sed -e "s|__REPO__|$HOME/tatazuka|g" -e "s|__HOME__|$HOME|g" \
  ~/tatazuka/deploy/launchd/com.tatazuka.server.plist \
  > ~/Library/LaunchAgents/com.tatazuka.server.plist

# 3) 読み込み＋起動（Catalina 以降の bootstrap 形）
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tatazuka.server.plist
#   旧形なら: launchctl load -w ~/Library/LaunchAgents/com.tatazuka.server.plist

# 4) 確認
launchctl print gui/$(id -u)/com.tatazuka.server | head        # 状態（PID / KeepAlive 等）
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:8443/
tail -f ~/Library/Logs/tatazuka.log                            # 起動ログ
```

運用：

```sh
launchctl kickstart -k gui/$(id -u)/com.tatazuka.server        # 設定変更を反映（再起動）
launchctl bootout gui/$(id -u)/com.tatazuka.server             # 停止＋自動起動オフ
#   旧形なら: launchctl unload -w ~/Library/LaunchAgents/com.tatazuka.server.plist
```

- **node の場所**はラッパーが `~/opt/node/bin:/usr/local/bin:/opt/homebrew/bin` を PATH に足して探す。
  別の場所なら `tatazuka-launch.sh` を直すか symlink を張る。
- **証明書が無い**と serve.js は起動時に落ちる（HTTPS 終端なので必須）。`~/Library/Logs/tatazuka.log` に出る。
- LaunchAgent はログイン時に起動するので、**自動ログインを切っている mac では手動ログインまで佇かは出ない**
  （システム全体の起動時に出したいなら LaunchDaemon だが、per-user の佇かには LaunchAgent が素直）。

### 配布メモ（層②の mac 版）— .app / .dmg と Gatekeeper

「.dmg を配って Applications にドラッグすれば動く」を素直に作れるか、の現実：

- **`.app` を組むこと自体は IDE 不要**。`.app` は実体ただの決まった構造のフォルダ
  （`Foo.app/Contents/MacOS/起動バイナリ`＋`Info.plist`＋`Resources/`）で、シェルで組める。
  **node を `Resources/` に同梱**すれば、ユーザー側は何も入れなくていい（repo＋node バイナリを入れ、
  `Contents/MacOS/` の起動スクリプトが serve.js を叩く）。ここまでは「ファイルを並べる」だけ。
- **“警告なしでドラッグ起動”の壁は Gatekeeper**。今どきの macOS は署名・公証されてないアプリを隔離する。
  素直に動かすには **Apple Developer 登録（年 $99）＋ Developer ID 証明書**で `codesign` →
  `notarytool` で**公証**→staple が要る（これらは Apple の command-line ツール。フル Xcode IDE は不要だが
  **有料アカウントは必須**）。公証しないなら、ユーザーが**右クリック→開く**か `xattr -d com.apple.quarantine`
  で隔離を外す一手間で動く＝「摩擦ゼロ配布」だけが署名待ち。**コンパイル環境の話ではない**。
- **佇か特有の捻り二つ**：
  1. 佇かは前面アプリでなく**裏で常駐するサーバ**。ダブルクリックで窓が開くアプリより、上の
     **LaunchAgent（裏で起きてる）**の形が本質に合う。consumer 向けに化粧するなら「**初回起動で
     LaunchAgent＋証明書を仕込む `.app`**」＝層②の installer を `.app` で包む絵になる。
  2. 表示は**別端末（スマホ/タブレット）のブラウザに逃がす**設計（CLAUDE.md）なので、サーバ証明書を
     **見る側の端末に信頼させる**一手が要る——普通の mac アプリには無い、佇か固有の導入課題。

つまり層②の mac 版は「.app を作れるか」ではなく「**公証（有料 Developer ID）＋常駐の仕込み＋他端末の証明書信頼**」が本体。①（LaunchAgent）が landed でも、ここは未着手のまま。

## Windows（Task Scheduler ログオン時タスク）

管理者権限なしで完結する（`RunLevel=LeastPrivilege`・自ユーザーのログオン時に起動）＝systemd `--user` /
LaunchAgent の対。タスク XML は env も `~` も展開しないので、launchd と同様に起動を**ラッパー**
`windows/tatazuka-launch.ps1` に一段噛ませ、そこで env を外出し読み込み・node を解決する
（「秘密は env へ・無くても起動」を移植）。

```powershell
# 0) 前提：%USERPROFILE%\tatazuka に repo・node・証明書（server\certs\）が揃っている
#    - node は公式 msi でも scoop でも prebuilt zip でも可。zip なら展開先を
#      %USERPROFILE%\opt\node に置く（ラッパーがそこと Program Files\nodejs を探す）。
#    - 証明書：mkcert でも openssl でも可（HTTPS 終端に必須）:
#        openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=localhost" `
#          -keyout "$env:USERPROFILE\tatazuka\server\certs\key.pem" `
#          -out   "$env:USERPROFILE\tatazuka\server\certs\cert.pem"

# 1) env（要るものだけ。空でもルールベースで起動する＝Linux/macOS と同じ場所・同じ形式）
$cfg = "$env:USERPROFILE\.config\tatazuka"
New-Item -ItemType Directory -Force -Path $cfg | Out-Null
Copy-Item "$env:USERPROFILE\tatazuka\deploy\systemd\tatazuka.env.example" "$cfg\tatazuka.env"
notepad "$cfg\tatazuka.env"        # 要る TZ_* のコメントを外す

# 2) タスク XML を実値に展開して取り込む（__REPO__ / __USER__ を置換）
#    schtasks /XML は UTF-16 を要求する（UTF-8 だと "unable to switch the encoding"）。
#    置換と同時に prolog を UTF-16 へ書き換え、-Encoding Unicode（UTF-16 LE）で書き出す。
$repo = "$env:USERPROFILE\tatazuka"
(Get-Content "$repo\deploy\windows\tatazuka.xml" -Raw) `
  -replace '__REPO__', $repo -replace '__USER__', "$env:USERDOMAIN\$env:USERNAME" `
  -replace 'encoding="UTF-8"', 'encoding="UTF-16"' |
  Set-Content "$env:TEMP\tatazuka.xml" -Encoding Unicode
schtasks /Create /TN tatazuka /XML "$env:TEMP\tatazuka.xml" /F

# 3) 起動（ログオン時に自動だが、初回はその場で叩いて確認）
schtasks /Run /TN tatazuka

# 4) 確認
schtasks /Query /TN tatazuka /V /FO LIST | Select-String "状態|Status|前回|Last"
curl.exe -sk -o NUL -w "%{http_code}`n" https://localhost:8443/
Get-Content "$cfg\tatazuka.log" -Tail 20 -Wait      # 起動ログ
```

運用：

```powershell
schtasks /End /TN tatazuka ; schtasks /Run /TN tatazuka   # 設定変更を反映（停止→再起動）
schtasks /Delete /TN tatazuka /F                          # 停止＋自動起動オフ
```

- **node の場所**はラッパーが PATH→`Program Files\nodejs`→`%USERPROFILE%\opt\node`→scoop の順で探す。
  別の場所なら `tatazuka-launch.ps1` を直す。
- `tatazuka-launch.ps1` は **UTF-8 BOM 付き**で保存してある（編集時に剥がさないこと）。PowerShell 5.1 は
  BOM 無しの非 ASCII スクリプトを ANSI コードページで誤読し、日本語 Windows（CP932）では日本語の直後の
  `}` を食ってパースが壊れる（実機で確認）。BOM があれば UTF-8 と確定して読む。
- **証明書が無い**と serve.js は起動時に落ちる（HTTPS 終端なので必須）。`%USERPROFILE%\.config\tatazuka\tatazuka.log` に出る。
- 落ちても起こし直す＝**LogonTrigger の Repetition（1 分ごと）＋ `MultipleInstancesPolicy=IgnoreNew`**。
  生存中は新規起動が無視され、死んでいれば 1 分以内に立ち上げ直す（Task Scheduler の枯れた keep-alive 定石）。
  systemd `Restart=on-failure` / launchd `KeepAlive` の役。**`RestartOnFailure` は使っていない**——プロセスの
  異常終了で確実に発火しなかった（実機 tiny10 で確認・kill 後 110 秒待っても復活せず）。復活レイテンシは最大 1 分
  ＝Windows は粒度が粗く、systemd の `RestartSec=3`（秒単位）のような細かさは持てない。
- ログオン時起動なので、**自動ログオンを切っている PC では手動ログオンまで佇かは出ない**
  （ログオン前から出したいならサービス化＝別物。per-user の佇かにはログオン時タスクが素直）。

> **実機検証：全 e2e landed（2026-06-10）。** OS 別バックエンド検証に使った VM ラボ（tiny10・Win10 /
> PS5.1）で、node20 を入れて佇か本体まで通し、次を**実機実証**した：①ラッパーが実 PS5.1 で parse 通る
> ②タスク XML を実 schtasks が受理して登録できる ③登録定義がトリガ（ログオン＋時刻）・LeastPrivilege
> （管理者不要）・Hidden で正しい ④**TimeTrigger が自走して serve.js を起こし HTTPS 200**（node クライアントで
> 2350B）⑤**node を kill→1 分以内に別 PID で自動復活し再び 200**（keep-alive 蘇生）⑥node 不在時は
> **exit 127 で fail-soft しログに理由を残す**。Linux/macOS の landed（起動＋クラッシュ復活）と同等。
>
> この検証で**実機しか炙り出せないバグを 6 件**捕って直した（テンプレ初版にあった。ローカルの xmllint /
> 構文チェックでは一つも見えなかった）：(1) `${env:ProgramFiles(x86)}` が PS5.1 パーサを壊す → GetEnvironmentVariable。
> (2) BOM 無し UTF-8 を日本語 Windows（CP932）が誤読し `}` を食う → wrapper を UTF-8 BOM 付きに。
> (3) schtasks /XML は UTF-8 を蹴る（`unable to switch the encoding`）→ UTF-16 化。
> (4) `Interval` 最小 1 分で `PT3S` は範囲外 → 以下(6)で別機構へ。
> (5) `Write-Error`(Stop) が `exit 127` に届かず診断も Hidden で消える → ログ先出し＋`Out-File`。
> (6) **`RestartOnFailure` はプロセス異常終了で発火しない**（kill 後 110 秒待っても復活せず）→ 撤去し、
> **LogonTrigger＋時刻 TimeTrigger（1 分ごと無限 repetition）＋IgnoreNew** の keep-alive に置換。
> ＊LogonTrigger に repetition を付けても効かない（ログオン後に登録した同一 session では発火しない）ため、
> 時刻起点の TimeTrigger を別に立てている。復活レイテンシは最大 1 分＝Windows は再起動粒度が粗い。
>
> （`.NET`(PS5.1) の `Invoke-WebRequest` は node20 の TLS と噛み合わず接続できないが、これはクライアント側の
> 癖で serve.js の問題ではない＝node クライアントと実ブラウザ＝スマホ側は 200。検証は node クライアントで取った。）
