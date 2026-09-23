#!/bin/bash

# ============================================================
#  🚀 WingRate — One-Click Installer
#
#  This script does EVERYTHING:
#    [0/7] Link to ALL project files (git clone) if run remotely
#    [1/7] Install Docker + Docker Compose (+ git)
#    [2/7] Ask for your Telegram Bot Token and domain
#    [3/7] Write .env
#    [4/7] docker-compose up -d --build  (Postgres + app + rate sidecar)
#    [5/7] Register the Telegram webhook
#    [6/7] Install the 5-minute rate-update cron
#    [7/7] Create database tables (drizzle-kit push)
#
#  One-liner (works from any directory, downloads all files first):
#    curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/install.sh \
#      | sudo bash -s -- https://github.com/<you>/<repo>.git
# ============================================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}   🚀 WingRate One-Click VPS Installer ${NC}"
echo -e "${BLUE}==================================================${NC}"

# Repo URL can be passed as $1 (for curl | bash) or as an env var.
REPO_URL="${1:-${REPO_URL:-}}"
APP_DIR="${APP_DIR:-$PWD}"

# ------------------------------------------------------------
# [0/7] Link to ALL project files
# ------------------------------------------------------------
echo -e "${GREEN}[0/7] Fetching project files...${NC}"
if [ -f "docker-compose.yml" ] && [ -f "package.json" ] && [ -d "src" ]; then
    echo "Project files already present in $(pwd) — skipping download."
else
    if [ -z "$REPO_URL" ]; then
        read -p "Enter your GitHub repo URL (links all files): " REPO_URL
    fi
    if [ -z "$REPO_URL" ]; then
        echo -e "${RED}Error: repo URL required when running outside the project folder.${NC}"
        echo "Usage: curl -fsSL <raw>/install.sh | sudo bash -s -- https://github.com/you/wingrate.git"
        exit 1
    fi

    # git must exist to link the files
    if ! command -v git &> /dev/null; then
        echo "Installing git..."
        apt-get update -y -qq
        apt-get install -y -qq git
    fi

    APP_DIR="${WINGRATE_DIR:-$HOME/wingrate}"
    rm -rf "$APP_DIR"
    echo "Cloning ALL project files from $REPO_URL → $APP_DIR"
    git clone --depth 1 "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
fi

# ------------------------------------------------------------
# [1/7] Install Docker and Docker Compose
# ------------------------------------------------------------
echo -e "${GREEN}[1/7] Checking for Docker...${NC}"
if ! command -v docker &> /dev/null; then
    echo "Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
else
    echo "Docker is already installed."
fi

if ! command -v docker-compose &> /dev/null; then
    echo "Docker Compose not found. Installing..."
    apt-get update -y -qq
    apt-get install -y -qq docker-compose
fi

# ------------------------------------------------------------
# [2/7] Gather Configuration
# ------------------------------------------------------------
echo -e "${GREEN}[2/7] Configuration...${NC}"
read -p "Enter your Telegram Bot Token: " BOT_TOKEN
read -p "Enter your Domain (e.g., rate.yourdomain.com): " DOMAIN

if [ -z "$BOT_TOKEN" ] || [ -z "$DOMAIN" ]; then
    echo -e "${RED}Error: Bot Token and Domain are required!${NC}"
    exit 1
fi

# ------------------------------------------------------------
# [3/7] Setup .env file
# ------------------------------------------------------------
echo -e "${GREEN}[3/7] Configuring environment...${NC}"
cat <<EOF > .env
DATABASE_URL=postgresql://postgres:postgres@db:5432/app_db
POSTGRES_URL=postgresql://postgres:postgres@db:5432/app_db
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
NEXT_PUBLIC_SITE_URL=https://$DOMAIN
EOF

# ------------------------------------------------------------
# [4/7] Launch Application
# ------------------------------------------------------------
echo -e "${GREEN}[4/7] Launching application with Docker Compose...${NC}"
docker-compose up -d --build

# ------------------------------------------------------------
# [5/7] Set Telegram Webhook
# ------------------------------------------------------------
echo -e "${GREEN}[5/7] Registering Telegram Webhook...${NC}"
WEBHOOK_URL="https://api.telegram.org/bot$BOT_TOKEN/setWebhook?url=https://$DOMAIN/api/bot/webhook"
RESPONSE=$(curl -s "$WEBHOOK_URL")
echo "Telegram Response: $RESPONSE"

# ------------------------------------------------------------
# [6/7] Setup Cron Job for Rates
# ------------------------------------------------------------
echo -e "${GREEN}[6/7] Setting up automated rate updates (Cron)...${NC}"
CRON_JOB="*/5 * * * * curl -s https://$DOMAIN/api/cron/update-rate > /dev/null 2>&1"
if ! crontab -l 2>/dev/null | grep -qF "/api/cron/update-rate"; then
    (crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -
fi

# ------------------------------------------------------------
# [7/7] Create database tables
# ------------------------------------------------------------
echo -e "${GREEN}[7/7] Creating database tables (drizzle-kit push)...${NC}"
sleep 8   # wait for Postgres to accept connections
docker-compose exec -T app npx drizzle-kit push \
    || echo -e "${YELLOW}⚠ Could not push schema yet — retry with:${NC}  docker-compose exec app npx drizzle-kit push"

echo -e "${BLUE}==================================================${NC}"
echo -e "${GREEN}✅ Installation Complete!${NC}"
echo -e "🌐 Your site:   ${BLUE}https://$DOMAIN${NC}"
echo -e "🤖 Bot webhook: ${BLUE}registered${NC}"
echo -e "⏰ Rates:       ${BLUE}updates every 5 minutes via Cron${NC}"
echo -e "📁 Files:       ${BLUE}$(pwd)${NC}"
echo -e "${BLUE}==================================================${NC}"
echo -e "💡 NOTE: Point $DOMAIN at port 3000 with a reverse proxy"
echo -e "   (Caddy/Nginx) to enable HTTPS — Telegram webhooks and the PWA"
echo -e "   require an https:// origin."
echo -e "🛠 Useful: docker-compose ps | docker-compose logs -f app"
