#!/bin/bash

# WingRate One-Click VPS Installer
# This script installs Docker, configures the environment, and launches the application.

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}   🚀 WingRate One-Click VPS Installer ${NC}"
echo -e "${BLUE}==================================================${NC}"

# 1. Install Docker and Docker Compose
echo -e "${GREEN}[1/6] Checking for Docker...${NC}"
if ! command -v docker &> /dev/null; then
    echo "Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    rm get-docker.sh
else
    echo "Docker is already installed."
fi

if ! command -v docker-compose &> /dev/null; then
    echo "Docker Compose not found. Installing..."
    sudo apt-get update
    sudo apt-get install -y docker-compose
fi

# 2. Gather Configuration
echo -e "${GREEN}[2/6] Configuration...${NC}"
read -p "Enter your Telegram Bot Token: " BOT_TOKEN
read -p "Enter your Domain (e.g., rate.yourdomain.com): " DOMAIN

if [ -z "$BOT_TOKEN" ] || [ -z "$DOMAIN" ]; then
    echo -e "${RED}Error: Bot Token and Domain are required!${NC}"
    exit 1
fi

# 3. Setup .env file
echo -e "${GREEN}[3/6] Configuring environment...${NC}"
cat <<EOF > .env
DATABASE_URL=postgresql://postgres:postgres@db:5432/app_db
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
NEXT_PUBLIC_SITE_URL=https://$DOMAIN
EOF

# 4. Launch Application
echo -e "${GREEN}[4/6] Launching application with Docker Compose...${NC}"
sudo docker-compose up -d --build

# 5. Set Telegram Webhook
echo -e "${GREEN}[5/6] Registering Telegram Webhook...${NC}"
WEBHOOK_URL="https://api.telegram.org/bot$BOT_TOKEN/setWebhook?url=https://$DOMAIN/api/bot/webhook"
RESPONSE=$(curl -s "$WEBHOOK_URL")
echo "Telegram Response: $RESPONSE"

# 6. Setup Cron Job for Rates
echo -e "${GREEN}[6/6] Setting up automated rate updates (Cron)...${NC}"
CRON_JOB="*/5 * * * * curl -s https://$DOMAIN/api/cron/update-rate > /dev/null 2>&1"
(crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -

echo -e "${BLUE}==================================================${NC}"
echo -e "${GREEN}✅ Installation Complete!${NC}"
echo -e "🌐 Your site: ${BLUE}https://$DOMAIN${NC}"
echo -e "🤖 Bot is now active."
echo -e "⏰ Rates will update every 5 minutes via Cron."
echo -e "${BLUE}==================================================${NC}"
echo -e "💡 NOTE: You must set up a reverse proxy (like Caddy or Nginx)"
echo -e "   to point $DOMAIN to port 3000 and enable HTTPS."
