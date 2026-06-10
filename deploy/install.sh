#!/usr/bin/env bash
# 佇か（tatazuka）ワンライナー導入 — Linux（systemd user）／ macOS（launchd LaunchAgent）。
# 署名の壁を避けるリモートスクリプト導入（deploy/README「層② の落とし所」）。
#
#   curl -fsSL https://raw.githubusercontent.com/AideaHandesen-dvs/tatazuka/main/deploy/install.sh | bash
#
# やること：node を用意 → repo 取得 → 証明書を作る → 自動起動ユニット登録（①）→ 起動。
# root 不要・env 無くても起動（PE）・冪等（何度流しても壊さない）。流す前にこのスクリプトを読んでくれ。
#
# オプション：
#   --mkcert       ローカル CA で証明書（見る端末に CA を入れれば警告ゼロ。mkcert は無ければ取得）
#   --tailscale    Tailscale Serve（近日）
#   --force-cert   既存の証明書を作り直す
#   --port N       待受ポート（既定 8443）
#   --branch NAME  取得する git ブランチ（既定 main）
#   --uninstall    ユニットを止めて外す（repo/証明書/env は残す）
set -euo pipefail

REPO_SLUG="AideaHandesen-dvs/tatazuka"
NODE_VER_LINUX="v20.20.2"     # Linux は node 20 LTS
NODE_VER_MAC_NEW="v20.20.2"   # macOS 11+ は node 20
NODE_VER_MAC_OLD="v18.20.5"   # macOS 10.15 Catalina 等は node 18 が上限
MKCERT_VER="v1.4.4"
NODE_MIN=18

BRANCH="main"
CERT_MODE="openssl"     # openssl | mkcert | tailscale
FORCE_CERT=0
DO_UNINSTALL=0
PORT="${PORT:-8443}"

REPO_DIR="$HOME/tatazuka"
CFG_DIR="$HOME/.config/tatazuka"

c_say='\033[1;36m'; c_warn='\033[1;33m'; c_err='\033[1;31m'; c_0='\033[0m'
say(){ printf "${c_say}佇か${c_0} %s\n" "$*"; }
warn(){ printf "${c_warn}佇か${c_0} %s\n" "$*" >&2; }
die(){ printf "${c_err}佇か NG${c_0} %s\n" "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mkcert) CERT_MODE=mkcert ;;
    --tailscale) CERT_MODE=tailscale ;;
    --force-cert) FORCE_CERT=1 ;;
    --uninstall) DO_UNINSTALL=1 ;;
    --port) PORT="${2:?--port に値が要る}"; shift ;;
    --branch) BRANCH="${2:?--branch に値が要る}"; shift ;;
    -h|--help) sed -n '2,22p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "不明なオプション: $1" ;;
  esac
  shift
done

case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "未対応 OS: $(uname -s)" ;;
esac

# ============================ ユニット（OS 別） ============================
unit_install(){
  if [ "$OS" = linux ]; then
    command -v systemctl >/dev/null 2>&1 || die "systemd が要る（systemctl が無い）"
    local ud="$HOME/.config/systemd/user"
    mkdir -p "$ud"
    cp "$REPO_DIR/deploy/systemd/tatazuka.service" "$ud/tatazuka.service"
    # node を ~/opt/node に入れた場合、ユニットの `env node` が見つかるよう PATH を補う drop-in。
    if [ -n "${NODE_OPT_BIN:-}" ]; then
      mkdir -p "$ud/tatazuka.service.d"
      cat > "$ud/tatazuka.service.d/10-node-path.conf" <<EOF
[Service]
Environment=PATH=$NODE_OPT_BIN:/usr/local/bin:/usr/bin:/bin
EOF
    fi
    systemctl --user daemon-reload
    systemctl --user enable --now tatazuka
  else
    # macOS：plist を実パスに展開して LaunchAgent に置き bootstrap。node PATH と env はラッパーが見る。
    local la="$HOME/Library/LaunchAgents/com.tatazuka.server.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    sed -e "s|__REPO__|$REPO_DIR|g" -e "s|__HOME__|$HOME|g" \
      "$REPO_DIR/deploy/launchd/com.tatazuka.server.plist" > "$la"
    launchctl bootout "gui/$(id -u)/com.tatazuka.server" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$la"
    launchctl kickstart -k "gui/$(id -u)/com.tatazuka.server" 2>/dev/null || true
  fi
}
unit_uninstall(){
  if [ "$OS" = linux ]; then
    systemctl --user disable --now tatazuka 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/tatazuka.service"
    rm -rf "$HOME/.config/systemd/user/tatazuka.service.d"
    systemctl --user daemon-reload 2>/dev/null || true
  else
    launchctl bootout "gui/$(id -u)/com.tatazuka.server" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/com.tatazuka.server.plist"
  fi
}

if [ "$DO_UNINSTALL" = 1 ]; then
  unit_uninstall
  say "ユニットを外した（$OS）。repo（$REPO_DIR）・証明書・env は残してある（消すなら手で）。"
  exit 0
fi

# ============================ 1) node ============================
have_node(){ command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MIN" ]; }
node_ok_at(){ [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MIN" ]; }
NODE_OPT_BIN=""   # ~/opt/node に入れた場合だけ埋まる
if have_node; then
  say "node 既存を使う（$(node -v)）"
elif node_ok_at "$HOME/opt/node/bin/node"; then
  NODE_OPT_BIN="$HOME/opt/node/bin"; export PATH="$NODE_OPT_BIN:$PATH"
  say "node 既存を使う（~/opt/node: $(node -v)）"
else
  arch="$(uname -m)"
  if [ "$OS" = linux ]; then
    case "$arch" in x86_64) plat=linux-x64;; aarch64|arm64) plat=linux-arm64;; armv7l) plat=linux-armv7l;; *) die "未対応 arch: $arch";; esac
    nver="$NODE_VER_LINUX"; ext=tar.xz; tarflag=-xJf
  else
    case "$arch" in arm64) plat=darwin-arm64; nver="$NODE_VER_MAC_NEW";; x86_64)
        plat=darwin-x64
        if [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 11 ]; then nver="$NODE_VER_MAC_NEW"; else nver="$NODE_VER_MAC_OLD"; fi ;;
      *) die "未対応 arch: $arch";; esac
    ext=tar.gz; tarflag=-xzf
  fi
  tb="node-${nver}-${plat}.${ext}"
  say "node 不在 → prebuilt 取得（${nver} ${plat}）"
  mkdir -p "$HOME/opt"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/${nver}/${tb}" -o "$tmp/$tb" || die "node 取得失敗"
  tar $tarflag "$tmp/$tb" -C "$HOME/opt"
  ln -sfn "$HOME/opt/node-${nver}-${plat}" "$HOME/opt/node"
  rm -rf "$tmp"
  NODE_OPT_BIN="$HOME/opt/node/bin"; export PATH="$NODE_OPT_BIN:$PATH"
  have_node || die "prebuilt node が動かない"
  say "node 用意した（$(node -v) @ ~/opt/node）"
fi

# ============================ 2) repo ============================
if [ -d "$REPO_DIR/.git" ]; then
  say "repo 既存 → 更新（git pull）"
  git -C "$REPO_DIR" pull --ff-only 2>/dev/null || warn "git pull できず。既存のまま進む。"
elif [ -f "$REPO_DIR/server/serve.js" ]; then
  say "repo 既存（非 git）→ そのまま使う"
elif command -v git >/dev/null 2>&1 && git clone --depth 1 --branch "$BRANCH" "https://github.com/${REPO_SLUG}.git" "$REPO_DIR" 2>/dev/null; then
  say "repo 取得（git clone $BRANCH）"
else
  say "repo 取得（tarball）"
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.tar.gz" -o "$tmp/r.tgz" || die "repo 取得失敗"
  tar -xzf "$tmp/r.tgz" -C "$tmp"
  mkdir -p "$REPO_DIR"
  cp -a "$tmp/tatazuka-${BRANCH}/." "$REPO_DIR/"
  rm -rf "$tmp"
fi
[ -f "$REPO_DIR/server/serve.js" ] || die "repo が壊れてる（server/serve.js が無い）"

# ============================ 3) 証明書 ============================
CERTS="$REPO_DIR/server/certs"
mkdir -p "$CERTS"
hn="$(hostname -s 2>/dev/null || hostname)"
if [ -f "$CERTS/cert.pem" ] && [ -f "$CERTS/key.pem" ] && [ "$FORCE_CERT" = 0 ]; then
  say "証明書は既存を使う（作り直すなら --force-cert）"
else
  case "$CERT_MODE" in
    tailscale) die "--tailscale はこれから。今は無印（openssl）か --mkcert で。" ;;
    mkcert)
      if ! command -v mkcert >/dev/null 2>&1; then
        case "$(uname -m)" in x86_64) ma=amd64;; aarch64|arm64) ma=arm64;; *) die "mkcert 未対応 arch";; esac
        [ "$OS" = darwin ] && mp="darwin" || mp="linux"
        say "mkcert 取得（${MKCERT_VER} ${mp}-${ma}）"
        mkdir -p "$HOME/opt/bin"
        curl -fsSL "https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VER}/mkcert-${MKCERT_VER}-${mp}-${ma}" -o "$HOME/opt/bin/mkcert" || die "mkcert 取得失敗"
        chmod +x "$HOME/opt/bin/mkcert"; export PATH="$HOME/opt/bin:$PATH"
      fi
      say "mkcert で証明書（ローカル CA を install）"
      mkcert -install >/dev/null 2>&1 || warn "mkcert -install に失敗（CA 未登録でも server 証明書は作る）"
      mkcert -cert-file "$CERTS/cert.pem" -key-file "$CERTS/key.pem" localhost 127.0.0.1 ::1 "$hn" "$hn.local"
      ;;
    openssl)
      command -v openssl >/dev/null 2>&1 || die "openssl が無い（--mkcert を使うか openssl を入れて）"
      # SAN は config ファイル方式（LibreSSL 2.8.3＝-addext 非対応 でも通る portable な書き方）。
      # 有効期間は 397 日（Apple platform の 398 日上限に合わせる＝iOS/Safari で弾かれない）。
      say "openssl で自己署名証明書（SAN: localhost / $hn.local 他・397日）"
      tmpc="$(mktemp)"
      cat > "$tmpc" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $hn.local
[v3]
subjectAltName = @alt
basicConstraints = CA:FALSE
[alt]
DNS.1 = localhost
DNS.2 = $hn
DNS.3 = $hn.local
IP.1 = 127.0.0.1
EOF
      openssl req -x509 -newkey rsa:2048 -nodes -days 397 \
        -keyout "$CERTS/key.pem" -out "$CERTS/cert.pem" -config "$tmpc" 2>/dev/null \
        || die "openssl 証明書生成に失敗"
      rm -f "$tmpc"
      ;;
  esac
  chmod 600 "$CERTS/key.pem"
fi

# ============================ 4) env（PE：無くても起動） ============================
mkdir -p "$CFG_DIR"
if [ ! -f "$CFG_DIR/tatazuka.env" ]; then
  cp "$REPO_DIR/deploy/systemd/tatazuka.env.example" "$CFG_DIR/tatazuka.env"
  chmod 600 "$CFG_DIR/tatazuka.env"
fi
if [ "$PORT" != "8443" ]; then
  if grep -q '^PORT=' "$CFG_DIR/tatazuka.env"; then sed -i.bak "s/^PORT=.*/PORT=$PORT/" "$CFG_DIR/tatazuka.env" && rm -f "$CFG_DIR/tatazuka.env.bak"
  else printf 'PORT=%s\n' "$PORT" >> "$CFG_DIR/tatazuka.env"; fi
fi

# ============================ 5) ユニット登録＆起動 ============================
unit_install

# ============================ 6) 確認 ============================
sleep 2
code="$(curl -sk -o /dev/null -w '%{http_code}' "https://localhost:$PORT/" 2>/dev/null || echo 000)"
if [ "$code" = 200 ]; then say "起動確認 OK（HTTPS $code）"; else
  warn "HTTPS $code（証明書 or 起動を確認）"
  [ "$OS" = linux ] && warn "  ログ: journalctl --user -u tatazuka -e" || warn "  ログ: tail ~/Library/Logs/tatazuka.log"
fi
echo
say "佇か、常駐開始。見る端末のブラウザから↓へ（同じ LAN）："
printf "       \033[1mhttps://%s.local:%s/\033[0m\n" "$hn" "$PORT"
if [ "$OS" = linux ]; then say "ログ: journalctl --user -u tatazuka -f ／ ログアウト後も常駐: loginctl enable-linger \$USER"
else say "ログ: tail -f ~/Library/Logs/tatazuka.log"; fi
say "外す: bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/main/deploy/install.sh) --uninstall"
[ "$CERT_MODE" = openssl ] && say "※ 自己署名なので端末に証明書警告が出る。警告ゼロにするなら --mkcert（端末に CA を入れる）。"
exit 0
