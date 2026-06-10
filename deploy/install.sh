#!/usr/bin/env bash
# 佇か（tatazuka）ワンライナー導入 — Linux（macOS は近日）。
# 署名の壁を避けるリモートスクリプト導入（deploy/README「層② の落とし所」）。
#
#   curl -fsSL https://raw.githubusercontent.com/AideaHandesen-dvs/tatazuka/main/deploy/install.sh | bash
#
# やること：node を用意 → repo 取得 → 証明書を作る → systemd user ユニット登録（①）→ 起動。
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
NODE_VER="v20.20.2"     # 同梱したい LTS（node 不在時のみ prebuilt 取得）
MKCERT_VER="v1.4.4"
NODE_MIN=18

BRANCH="main"
CERT_MODE="openssl"     # openssl | mkcert | tailscale
FORCE_CERT=0
DO_UNINSTALL=0
PORT="${PORT:-8443}"

REPO_DIR="$HOME/tatazuka"
CFG_DIR="$HOME/.config/tatazuka"
UNIT_DIR="$HOME/.config/systemd/user"

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
  Linux) ;;
  Darwin) die "macOS の分岐はこれから（launchd）。今は deploy/README の macOS 節を手で。" ;;
  *) die "未対応 OS: $(uname -s)" ;;
esac
command -v systemctl >/dev/null 2>&1 || die "systemd が要る（systemctl が無い）"

# ---- uninstall ----
if [ "$DO_UNINSTALL" = 1 ]; then
  systemctl --user disable --now tatazuka 2>/dev/null || true
  rm -f "$UNIT_DIR/tatazuka.service"
  rm -rf "$UNIT_DIR/tatazuka.service.d"
  systemctl --user daemon-reload 2>/dev/null || true
  say "ユニットを外した。repo（$REPO_DIR）・証明書・env は残してある（消すなら手で）。"
  exit 0
fi

# ---- 1) node ----
have_node(){ command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MIN" ]; }
NODE_OPT_BIN=""   # ~/opt/node に入れた場合だけ埋まる（ユニットの PATH 補正用）
node_ok_at(){ [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MIN" ]; }
if have_node; then
  say "node 既存を使う（$(node -v)）"
elif node_ok_at "$HOME/opt/node/bin/node"; then
  # 前回の導入で ~/opt/node に入れてある（別シェルでは PATH に無いので拾い直す）。再取得しない。
  NODE_OPT_BIN="$HOME/opt/node/bin"; export PATH="$NODE_OPT_BIN:$PATH"
  say "node 既存を使う（~/opt/node: $(node -v)）"
else
  case "$(uname -m)" in x86_64) narch=x64;; aarch64|arm64) narch=arm64;; armv7l) narch=armv7l;; *) die "未対応 arch: $(uname -m)";; esac
  tb="node-${NODE_VER}-linux-${narch}.tar.xz"
  say "node 不在 → prebuilt 取得（${NODE_VER} ${narch}）"
  mkdir -p "$HOME/opt"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/${tb}" -o "$tmp/$tb" || die "node 取得失敗"
  tar -xJf "$tmp/$tb" -C "$HOME/opt"
  ln -sfn "$HOME/opt/node-${NODE_VER}-linux-${narch}" "$HOME/opt/node"
  rm -rf "$tmp"
  NODE_OPT_BIN="$HOME/opt/node/bin"
  export PATH="$NODE_OPT_BIN:$PATH"
  have_node || die "prebuilt node が動かない"
  say "node 用意した（$(node -v) @ ~/opt/node）"
fi

# ---- 2) repo ----
if [ -d "$REPO_DIR/.git" ]; then
  say "repo 既存 → 更新（git pull）"
  git -C "$REPO_DIR" pull --ff-only 2>/dev/null || warn "git pull できず（ローカル変更あり？）。既存のまま進む。"
elif [ -f "$REPO_DIR/server/serve.js" ]; then
  say "repo 既存（非 git）→ そのまま使う"
elif command -v git >/dev/null 2>&1; then
  say "repo 取得（git clone $BRANCH）"
  git clone --depth 1 --branch "$BRANCH" "https://github.com/${REPO_SLUG}.git" "$REPO_DIR"
else
  say "repo 取得（tarball・git 無し）"
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.tar.gz" -o "$tmp/r.tgz" || die "repo 取得失敗"
  tar -xzf "$tmp/r.tgz" -C "$tmp"
  mkdir -p "$REPO_DIR"
  cp -a "$tmp/tatazuka-${BRANCH}/." "$REPO_DIR/"
  rm -rf "$tmp"
fi
[ -f "$REPO_DIR/server/serve.js" ] || die "repo が壊れてる（server/serve.js が無い）"

# ---- 3) 証明書 ----
CERTS="$REPO_DIR/server/certs"
mkdir -p "$CERTS"
hn="$(hostname)"
if [ -f "$CERTS/cert.pem" ] && [ -f "$CERTS/key.pem" ] && [ "$FORCE_CERT" = 0 ]; then
  say "証明書は既存を使う（作り直すなら --force-cert）"
else
  case "$CERT_MODE" in
    tailscale) die "--tailscale はこれから。今は無印（openssl）か --mkcert で。" ;;
    mkcert)
      if ! command -v mkcert >/dev/null 2>&1; then
        case "$(uname -m)" in x86_64) ma=amd64;; aarch64|arm64) ma=arm64;; *) die "mkcert 未対応 arch";; esac
        say "mkcert 取得（${MKCERT_VER} ${ma}）"
        mkdir -p "$HOME/opt/bin"
        curl -fsSL "https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VER}/mkcert-${MKCERT_VER}-linux-${ma}" -o "$HOME/opt/bin/mkcert" || die "mkcert 取得失敗"
        chmod +x "$HOME/opt/bin/mkcert"
        export PATH="$HOME/opt/bin:$PATH"
      fi
      say "mkcert で証明書（ローカル CA を install）"
      mkcert -install >/dev/null 2>&1 || warn "mkcert -install に失敗（CA 未登録でも server 証明書は作る）"
      mkcert -cert-file "$CERTS/cert.pem" -key-file "$CERTS/key.pem" localhost 127.0.0.1 ::1 "$hn" "$hn.local"
      ;;
    openssl)
      command -v openssl >/dev/null 2>&1 || die "openssl が無い（--mkcert を使うか openssl を入れて）"
      say "openssl で自己署名証明書（SAN: localhost / $hn.local 他）"
      openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
        -subj "/CN=$hn.local" \
        -addext "subjectAltName=DNS:localhost,DNS:$hn,DNS:$hn.local,IP:127.0.0.1" \
        -keyout "$CERTS/key.pem" -out "$CERTS/cert.pem" 2>/dev/null \
        || die "openssl 証明書生成に失敗"
      ;;
  esac
  chmod 600 "$CERTS/key.pem"
fi

# ---- 4) env（PE：無くても起動） ----
mkdir -p "$CFG_DIR"
if [ ! -f "$CFG_DIR/tatazuka.env" ]; then
  cp "$REPO_DIR/deploy/systemd/tatazuka.env.example" "$CFG_DIR/tatazuka.env"
  chmod 600 "$CFG_DIR/tatazuka.env"
fi
if [ "$PORT" != "8443" ]; then
  grep -q '^PORT=' "$CFG_DIR/tatazuka.env" && sed -i "s/^PORT=.*/PORT=$PORT/" "$CFG_DIR/tatazuka.env" || printf 'PORT=%s\n' "$PORT" >> "$CFG_DIR/tatazuka.env"
fi

# ---- 5) systemd user ユニット ----
mkdir -p "$UNIT_DIR"
cp "$REPO_DIR/deploy/systemd/tatazuka.service" "$UNIT_DIR/tatazuka.service"
# node を ~/opt/node に入れた場合、ユニットの `env node` が見つかるよう PATH を補う drop-in を置く
if [ -n "$NODE_OPT_BIN" ]; then
  mkdir -p "$UNIT_DIR/tatazuka.service.d"
  cat > "$UNIT_DIR/tatazuka.service.d/10-node-path.conf" <<EOF
[Service]
Environment=PATH=$NODE_OPT_BIN:/usr/local/bin:/usr/bin:/bin
EOF
fi
systemctl --user daemon-reload
systemctl --user enable --now tatazuka

# ---- 6) 確認 ----
sleep 2
code="$(curl -sk -o /dev/null -w '%{http_code}' "https://localhost:$PORT/" 2>/dev/null || echo 000)"
if [ "$code" = 200 ]; then
  say "起動確認 OK（HTTPS $code）"
else
  warn "HTTPS $code（証明書 or 起動を確認：journalctl --user -u tatazuka -e）"
fi
echo
say "佇か、常駐開始。見る端末のブラウザから↓へ（同じ LAN）："
printf "       \033[1mhttps://%s.local:%s/\033[0m\n" "$hn" "$PORT"
say "ログ: journalctl --user -u tatazuka -f ／ 外す: bash <(curl -fsSL .../deploy/install.sh) --uninstall"
[ "$CERT_MODE" = openssl ] && say "※ 自己署名なので端末に証明書警告が出る。警告ゼロにするなら --mkcert（端末に CA を入れる）。"
# ログアウト後も常駐させたいなら： loginctl enable-linger "$USER"
exit 0
