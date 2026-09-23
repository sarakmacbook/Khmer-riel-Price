#!/usr/bin/env bash
# =============================================================================
#  WingRate — one-click VPS installer
#
#  Usage:
#    sudo ./install.sh              # install / reconfigure (safe to re-run)
#    sudo ./install.sh update       # pull latest code + rebuild
#    sudo ./install.sh status       # show container status + health
#    sudo ./install.sh logs         # follow app logs
#    sudo ./install.sh restart      # restart all services
#    sudo ./install.sh uninstall    # stop & remove containers (asks about data)
#
#  Where do the project files come from? (first match wins)
#    1. The folder install.sh is in (git clone / unzipped download)
#    2. An existing install in $INSTALL_DIR (/opt/wingrate)
#    3. ARCHIVE_URL=...   any .zip / .tar.gz of the project
#    4. GITHUB_REPO=owner/repo   downloads the repo archive (no git needed)
#    5. Files embedded inside this script (single-file installer,
#       build it with: bash scripts/build-installer.sh)
#
#  Remote one-liners:
#    curl -fsSL https://your-app.vercel.app/install.sh | sudo bash             # self-contained
#    curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/install.sh \
#      | sudo GITHUB_REPO=OWNER/REPO bash
#
#  Non-interactive (all optional):
#    sudo DOMAIN=rate.example.com TELEGRAM_BOT_TOKEN=123:abc UPDATE_INTERVAL=60 ./install.sh
# =============================================================================
set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-}"      # e.g. yourname/wingrate
REPO_URL="${REPO_URL:-}"            # e.g. https://github.com/yourname/wingrate.git
ARCHIVE_URL="${ARCHIVE_URL:-}"      # e.g. https://example.com/wingrate.zip
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/wingrate}"

# ---------- pretty output ----------
if [ -t 1 ]; then
  B='\033[1m'; G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; C='\033[0;36m'; N='\033[0m'
else
  B=''; G=''; Y=''; R=''; C=''; N=''
fi
step() { echo -e "\n${C}${B}==>${N} ${B}$*${N}"; }
ok()   { echo -e "  ${G}✔${N} $*"; }
warn() { echo -e "  ${Y}!${N} $*"; }
die()  { echo -e "\n${R}✖ $*${N}" >&2; exit 1; }

# ---------- helpers ----------
has_tty() { [ -r /dev/tty ] && [ -w /dev/tty ] && (exec </dev/tty) 2>/dev/null; }

# ask VAR "Question" "default"   — skips if VAR already set in the environment
ask() {
  local var="$1" q="$2" def="${3:-}" ans=""
  if [ -n "${!var:-}" ]; then return; fi
  if has_tty; then
    if [ -n "$def" ]; then
      read -r -p "  $q [$def]: " ans </dev/tty || true
    else
      read -r -p "  $q: " ans </dev/tty || true
    fi
  fi
  printf -v "$var" '%s' "${ans:-$def}"
}

get_env() { [ -f .env ] && grep -E "^$1=" .env | tail -n1 | cut -d= -f2- || true; }
rand_hex() { openssl rand -hex "${1:-24}" 2>/dev/null || head -c "${1:-24}" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

dc() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"
  else die "Docker Compose not found"; fi
}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    if [ -f "$0" ] && command -v sudo >/dev/null 2>&1; then
      exec sudo -E bash "$0" "$@"
    fi
    die "Please run as root, e.g.:  curl -fsSL <url>/install.sh | sudo bash"
  fi
}

# ---------- locate / fetch project ----------
is_project_dir() { [ -f "$1/docker-compose.yml" ] && [ -f "$1/package.json" ] && [ -d "$1/src" ]; }

# Extract an archive (zip or tar.gz) into $INSTALL_DIR, flattening a single top-level folder.
# Existing .env and database volumes are kept.
extract_into_install_dir() {
  local archive="$1" tmp
  tmp="$(mktemp -d)"
  if [ "$(head -c 2 "$archive")" = "PK" ]; then
    if ! command -v unzip >/dev/null 2>&1; then
      command -v apt-get >/dev/null 2>&1 && apt-get update -qq >/dev/null 2>&1
      pkg_install unzip
    fi
    unzip -q "$archive" -d "$tmp"
  else
    tar -xzf "$archive" -C "$tmp"
  fi
  local root="$tmp"
  if [ "$(find "$tmp" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ] && [ -d "$(find "$tmp" -mindepth 1 -maxdepth 1)" ]; then
    root="$(find "$tmp" -mindepth 1 -maxdepth 1)"
  fi
  is_project_dir "$root" || die "Downloaded archive does not look like WingRate (no docker-compose.yml / package.json / src)."
  mkdir -p "$INSTALL_DIR"
  # Replace code, keep .env
  find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name .env ! -name .git -exec rm -rf {} +
  cp -a "$root"/. "$INSTALL_DIR"/
  rm -rf "$tmp"
  chmod +x "$INSTALL_DIR/install.sh" 2>/dev/null || true
}

download_project() {
  local tmpfile; tmpfile="$(mktemp)"
  if [ -n "$ARCHIVE_URL" ]; then
    step "Downloading project archive"
    curl -fsSL "$ARCHIVE_URL" -o "$tmpfile" || die "Could not download $ARCHIVE_URL"
    extract_into_install_dir "$tmpfile"; ok "Extracted $ARCHIVE_URL → $INSTALL_DIR"
  elif [ -n "$GITHUB_REPO" ] || [ -n "$REPO_URL" ]; then
    local repo="$GITHUB_REPO"
    [ -z "$repo" ] && repo="$(echo "$REPO_URL" | sed -E 's#^(https?://|git@)github\.com[:/]##; s#\.git$##')"
    step "Downloading github.com/$repo ($BRANCH)"
    if curl -fsSL "https://codeload.github.com/$repo/tar.gz/refs/heads/$BRANCH" -o "$tmpfile"; then
      extract_into_install_dir "$tmpfile"; ok "Downloaded $repo → $INSTALL_DIR"
    elif [ -n "$REPO_URL" ] && command -v git >/dev/null 2>&1; then
      git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" || die "git clone failed"
      ok "Cloned $REPO_URL"
    else
      die "Could not download github.com/$repo (is the repo public and the branch '$BRANCH'?)"
    fi
  elif [ "${HAS_PAYLOAD:-0}" = "1" ]; then
    step "Unpacking embedded project files"
    payload > "$tmpfile" || die "Embedded payload is corrupt"
    extract_into_install_dir "$tmpfile"; ok "Unpacked → $INSTALL_DIR"
  else
    die "Project files not found.
   Run install.sh from inside the project folder, or tell it where to download them:
     sudo GITHUB_REPO=yourname/wingrate ./install.sh
     sudo ARCHIVE_URL=https://example.com/wingrate.zip ./install.sh
   Or use the self-contained installer:  bash scripts/build-installer.sh"
  fi
  rm -f "$tmpfile"
}

enter_project_dir() {
  local script_dir=""
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fi
  if [ -n "$script_dir" ] && is_project_dir "$script_dir"; then
    cd "$script_dir"
  elif is_project_dir "."; then
    :
  elif [ -n "$ARCHIVE_URL$GITHUB_REPO$REPO_URL" ] || { [ "${HAS_PAYLOAD:-0}" = "1" ] && ! is_project_dir "$INSTALL_DIR"; }; then
    download_project
    cd "$INSTALL_DIR"
  elif is_project_dir "$INSTALL_DIR"; then
    cd "$INSTALL_DIR"
  else
    download_project
    cd "$INSTALL_DIR"
  fi
  PROJECT_DIR="$(pwd)"
}

# ---------- system packages ----------
pkg_install() {
  if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q "$@" >/dev/null
  elif command -v yum >/dev/null 2>&1; then yum install -y -q "$@" >/dev/null
  fi
}

install_packages() {
  step "Checking system packages"
  local pkgs="curl git openssl ca-certificates unzip tar"
  local missing=""
  for p in curl git openssl; do command -v "$p" >/dev/null 2>&1 || missing="1"; done
  if [ -n "$missing" ]; then
    if command -v apt-get >/dev/null 2>&1; then
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq && apt-get install -y -qq $pkgs >/dev/null
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q $pkgs >/dev/null
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q $pkgs >/dev/null
    else
      die "Unsupported OS: please install curl, git and openssl manually."
    fi
  fi
  ok "curl, git, openssl available"
}

install_docker() {
  step "Checking Docker"
  if ! command -v docker >/dev/null 2>&1; then
    echo "  Installing Docker (this takes a minute)..."
    curl -fsSL https://get.docker.com | sh >/dev/null
    ok "Docker installed"
  else
    ok "Docker already installed ($(docker --version | cut -d, -f1))"
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true

  if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
    echo "  Installing Docker Compose plugin..."
    if command -v apt-get >/dev/null 2>&1; then apt-get install -y -qq docker-compose-plugin >/dev/null
    elif command -v dnf >/dev/null 2>&1; then dnf install -y -q docker-compose-plugin >/dev/null
    else die "Please install the Docker Compose plugin manually."; fi
  fi
  ok "Docker Compose available"
}

# ---------- configuration ----------
configure() {
  step "Configuration"
  echo "  (Press Enter to accept defaults. Everything can be changed later by re-running this script.)"
  echo

  # Load previous values on re-run
  DOMAIN="${DOMAIN:-$(get_env DOMAIN)}"
  TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$(get_env TELEGRAM_BOT_TOKEN)}"
  UPDATE_INTERVAL="${UPDATE_INTERVAL:-$(get_env UPDATE_INTERVAL)}"
  APP_PORT="${APP_PORT:-$(get_env APP_PORT)}"
  POSTGRES_PASSWORD="$(get_env POSTGRES_PASSWORD)"
  CRON_SECRET="$(get_env CRON_SECRET)"

  local _domain_default="$DOMAIN"; DOMAIN=""
  ask DOMAIN "Domain for HTTPS (e.g. rate.example.com) — leave empty to use http://IP:PORT" "$_domain_default"

  local _tok_default="$TELEGRAM_BOT_TOKEN"; TELEGRAM_BOT_TOKEN=""
  ask TELEGRAM_BOT_TOKEN "Telegram bot token from @BotFather (optional)" "$_tok_default"

  local _int_default="${UPDATE_INTERVAL:-60}"; UPDATE_INTERVAL=""
  ask UPDATE_INTERVAL "How often to fetch Wing Bank rate, in seconds" "$_int_default"
  [[ "$UPDATE_INTERVAL" =~ ^[0-9]+$ ]] && [ "$UPDATE_INTERVAL" -ge 10 ] || { warn "Invalid interval, using 60"; UPDATE_INTERVAL=60; }

  APP_PORT="${APP_PORT:-3000}"
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(rand_hex 24)}"
  CRON_SECRET="${CRON_SECRET:-$(rand_hex 24)}"

  DOMAIN="$(echo "$DOMAIN" | sed -E 's#^https?://##; s#/.*$##' | tr '[:upper:]' '[:lower:]')"

  PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_SERVER_IP")"

  if [ -n "$DOMAIN" ]; then
    SITE_URL="https://$DOMAIN"
    COMPOSE_PROFILES="https"
    APP_BIND="127.0.0.1"   # only reachable through Caddy
  else
    SITE_URL="http://$PUBLIC_IP:$APP_PORT"
    COMPOSE_PROFILES=""
    APP_BIND="0.0.0.0"
  fi

  umask 077
  cat > .env <<EOF
# ---- Generated by install.sh on $(date -u +"%Y-%m-%d %H:%M UTC") — re-run install.sh to change ----
DOMAIN=$DOMAIN
SITE_URL=$SITE_URL
NEXT_PUBLIC_SITE_URL=$SITE_URL
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
UPDATE_INTERVAL=$UPDATE_INTERVAL

# Secrets (auto-generated)
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
CRON_SECRET=$CRON_SECRET

# Networking
APP_PORT=$APP_PORT
APP_BIND=$APP_BIND
COMPOSE_PROFILES=$COMPOSE_PROFILES

# How often the server may re-check Wing Bank when visitors are on the site (seconds)
REFRESH_SECONDS=$UPDATE_INTERVAL
EOF
  umask 022
  ok ".env written (secrets auto-generated, file permissions 600)"
}

check_dns() {
  [ -z "$DOMAIN" ] && return
  step "Checking DNS for $DOMAIN"
  local resolved
  resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')"
  if [ -z "$resolved" ]; then
    warn "$DOMAIN does not resolve yet. Create an A record → $PUBLIC_IP"
    warn "HTTPS will start working automatically once DNS propagates."
  elif [ "$resolved" != "$PUBLIC_IP" ]; then
    warn "$DOMAIN points to $resolved but this server is $PUBLIC_IP"
    warn "Update the A record, otherwise the HTTPS certificate cannot be issued."
  else
    ok "$DOMAIN → $PUBLIC_IP"
  fi
}

open_firewall() {
  step "Firewall"
  local ports
  if [ -n "$DOMAIN" ]; then ports="80 443"; else ports="$APP_PORT"; fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    for p in $ports; do ufw allow "$p/tcp" >/dev/null; done
    ok "ufw: opened $ports"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    for p in $ports; do firewall-cmd --permanent --add-port="$p/tcp" >/dev/null; done
    firewall-cmd --reload >/dev/null
    ok "firewalld: opened $ports"
  else
    ok "No active host firewall detected (make sure your cloud provider allows: $ports)"
  fi
}

# ---------- launch ----------
launch() {
  step "Building & starting containers (first build takes 2–5 minutes)"
  if [ -z "$DOMAIN" ]; then dc stop caddy >/dev/null 2>&1 || true; dc rm -f caddy >/dev/null 2>&1 || true; fi
  dc up -d --build --remove-orphans
  ok "Containers started"

  step "Waiting for the app to become healthy"
  local i
  for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then
      ok "App is healthy"
      break
    fi
    [ "$i" -eq 60 ] && { dc logs --tail=60 app; die "App did not become healthy. See logs above."; }
    sleep 3
  done

  step "Fetching the first Wing Bank rate"
  local r
  r="$(curl -fsS -H "Authorization: Bearer $CRON_SECRET" "http://127.0.0.1:$APP_PORT/api/cron/update-rate" 2>/dev/null || true)"
  if echo "$r" | grep -q '"success":true'; then
    ok "Rate stored: $(echo "$r" | sed -E 's/.*"bid":([0-9.]+).*"ask":([0-9.]+).*/bid \1 · ask \2/')"
  else
    warn "First fetch failed (Wing Bank may be blocking or down). The updater keeps retrying every ${UPDATE_INTERVAL}s."
  fi
}

setup_telegram() {
  [ -z "$TELEGRAM_BOT_TOKEN" ] && return
  step "Configuring Telegram bot"
  local me
  me="$(curl -fsS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe" 2>/dev/null || true)"
  if ! echo "$me" | grep -q '"ok":true'; then
    warn "Telegram rejected the bot token — check it with @BotFather. Skipping."
    return
  fi
  BOT_USERNAME="$(echo "$me" | sed -E 's/.*"username":"([^"]+)".*/\1/')"
  ok "Bot verified: @$BOT_USERNAME"

  curl -fsS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setMyCommands" \
    -H 'Content-Type: application/json' \
    -d '{"commands":[{"command":"rate","description":"Current Wing Bank USD/KHR rate"},{"command":"alert","description":"Subscribe to rate change alerts"},{"command":"stop","description":"Stop alerts"},{"command":"start","description":"Show help & your chat ID"}]}' \
    >/dev/null 2>&1 && ok "Bot commands registered"

  if [ -z "$DOMAIN" ]; then
    warn "No domain → Telegram webhook NOT set (Telegram requires HTTPS)."
    warn "Outgoing alerts still work; bot commands (/rate, /alert) need a domain."
    return
  fi

  # Wait briefly for Caddy to obtain the certificate
  local i
  for i in $(seq 1 20); do
    curl -fsS --max-time 5 "https://$DOMAIN/api/health" >/dev/null 2>&1 && break
    sleep 3
  done

  local res
  res="$(curl -fsS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
    -d "url=https://$DOMAIN/api/bot/webhook" -d "drop_pending_updates=true" 2>/dev/null || true)"
  if echo "$res" | grep -q '"ok":true'; then
    ok "Webhook set → https://$DOMAIN/api/bot/webhook"
  else
    warn "Could not set webhook yet (HTTPS probably not ready). Re-run: sudo ./install.sh"
  fi
}

summary() {
  echo
  echo -e "${G}${B}=====================================================${N}"
  echo -e "${G}${B}  ✅ WingRate is running!${N}"
  echo -e "${G}${B}=====================================================${N}"
  echo -e "  🌐 Website:   ${B}$SITE_URL${N}"
  [ -n "${BOT_USERNAME:-}" ] && echo -e "  🤖 Telegram:  ${B}https://t.me/$BOT_USERNAME${N}  (send /start)"
  echo -e "  ⏱  Updates:   Wing Bank rate fetched every ${UPDATE_INTERVAL}s"
  echo -e "  📁 Location:  $PROJECT_DIR"
  echo
  echo "  Manage:"
  echo "    sudo ./install.sh status     # health & containers"
  echo "    sudo ./install.sh logs       # live logs"
  echo "    sudo ./install.sh update     # pull latest & rebuild"
  echo "    sudo ./install.sh            # change domain / token / interval"
  echo "    sudo ./install.sh uninstall  # remove"
  echo
}

# ---------- sub-commands ----------
cmd_install() {
  install_packages
  install_docker
  configure
  check_dns
  open_firewall
  launch
  setup_telegram
  summary
}

cmd_update() {
  step "Updating WingRate"
  if [ -d .git ]; then
    git pull --ff-only && ok "Code updated (git)"
  elif [ -n "$ARCHIVE_URL$GITHUB_REPO$REPO_URL" ] || [ "${HAS_PAYLOAD:-0}" = "1" ]; then
    INSTALL_DIR="$PROJECT_DIR" download_project && ok "Code updated (.env kept)"
  else
    warn "No update source — rebuilding current files (set GITHUB_REPO=owner/repo to pull updates)"
  fi
  dc up -d --build --remove-orphans
  ok "Rebuilt & restarted"
  cmd_status
}

cmd_status() {
  step "Containers"
  dc ps
  step "Health"
  local port; port="$(get_env APP_PORT)"; port="${port:-3000}"
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then ok "App healthy"; else warn "App not responding on port $port"; fi
  local latest; latest="$(curl -fsS "http://127.0.0.1:$port/api/rate" 2>/dev/null || true)"
  [ -n "$latest" ] && ok "Latest rate: $latest"
}

cmd_uninstall() {
  step "Uninstalling WingRate"
  local wipe="n"
  if has_tty; then read -r -p "  Also delete the database (all rate history)? [y/N]: " wipe </dev/tty || true; fi
  if [[ "$wipe" =~ ^[Yy]$ ]]; then
    dc --profile https down -v --remove-orphans
    ok "Containers and data removed"
  else
    dc --profile https down --remove-orphans
    ok "Containers removed (database volume kept — re-run install.sh to restore)"
  fi
  local tok; tok="$(get_env TELEGRAM_BOT_TOKEN)"
  [ -n "$tok" ] && curl -fsS "https://api.telegram.org/bot$tok/deleteWebhook" >/dev/null 2>&1 && ok "Telegram webhook removed"
}

# ---------- embedded project files (filled in by scripts/build-installer.sh) ----------
# @@PAYLOAD_START@@
HAS_PAYLOAD=0
payload() { return 1; }
# @@PAYLOAD_END@@

# ---------- main ----------
main() {
  local cmd="${1:-install}"
  need_root "$@"
  echo -e "${B}🚀 WingRate installer${N}  —  KHR/USD Wing Bank rate tracker"
  enter_project_dir
  case "$cmd" in
    install)   cmd_install ;;
    update)    install_docker; cmd_update ;;
    status)    cmd_status ;;
    logs)      dc logs -f --tail=100 app updater ;;
    restart)   dc restart && ok "Restarted" ;;
    uninstall) cmd_uninstall ;;
    -h|--help|help) sed -n '2,18p' "$0" ;;
    *) die "Unknown command: $cmd (try: install | update | status | logs | restart | uninstall)" ;;
  esac
}

main "$@"
