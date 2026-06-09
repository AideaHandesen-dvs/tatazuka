#!/bin/bash
# 佇か launchd ラッパー（macOS）。
#
# launchd の LaunchAgent は plist 内で ~ も EnvironmentFile も展開しない。そこで起動を
# このラッパーに一段噛ませ、$HOME 基準で env を外出し読み込み・node を解決してから serve.js を exec する。
# systemd unit の EnvironmentFile=-（無くても起動）/ %h と同じ約束を macOS に移植したもの。
#
# 秘密（TZ_HASS_TOKEN / ANTHROPIC_API_KEY 等）は plist でなく ~/.config/tatazuka/tatazuka.env に置く。

# env を外出し（無ければルールベースで起動＝PE）。set -a で export 込みに。
set -a
[ -f "$HOME/.config/tatazuka/tatazuka.env" ] && . "$HOME/.config/tatazuka/tatazuka.env"
set +a

# launchd の最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin）を補い、よくある node の場所を足す。
# prebuilt tarball を使う場合は ~/opt/node → 実体に symlink しておく（deploy/README.md 参照）。
export PATH="$HOME/opt/node/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

exec node "$HOME/tatazuka/server/serve.js"
