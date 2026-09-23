# 🚀 Deployment Guide for WingRate Tracker

This guide will help you install the WingRate Tracker on your VPS.

## 🛠 Prerequisites
- A VPS with Ubuntu 22.04+ (Recommended)
- Docker and Docker Compose installed
- A Telegram Bot Token (from @BotFather)

## ⚡ Quick Installation (One-Click)

Run the following command on your VPS to start the installation:

```bash
curl -sSL https://raw.githubusercontent.com/your-repo/wingrate/main/install.sh | bash
```
*(Note: Since this is a local project, please follow the manual steps below or use the provided `docker-compose` setup).*

## 📦 Manual Installation using Docker

### 1. Clone the project
```bash
git clone <your-repository-url>
cd wingrate
```

### 2. Configure Environment Variables
Create a `.env` file in the root directory:
```bash
nano .env
```

Add the following:
```env
DATABASE_URL=postgresql://postgres:postgres@db:5432/app_db
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
NEXT_PUBLIC_SITE_URL=https://your-domain.com
```

### 3. Launch with Docker Compose
```bash
docker-compose up -d --build
```

### 4. Set up Telegram Webhook
To make the bot work, you must tell Telegram where to send messages:
```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://your-domain.com/api/bot/webhook"
```

### 5. Set up Rate Updates (Cron Job)
The app needs to fetch rates from Wing Bank periodically. Add this to your VPS crontab:
```bash
crontab -e
```
Add this line to update the rate every 5 minutes:
```cron
*/5 * * * * curl -s https://your-domain.com/api/cron/update-rate > /dev/null 2>&1
```

## 🌐 Domain & SSL
We recommend using **Nginx Proxy Manager** or **Caddy** to handle SSL (HTTPS), as Telegram Webhooks require HTTPS.

### Example Caddyfile:
```caddy
your-domain.com {
    reverse_proxy localhost:3000
}
```
