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

# Optional — 🗄 database menu in Telegram
TELEGRAM_ADMIN_CHAT_ID=          # only this chat may change the database
DB_CONFIG_FILE=/app/.data/wingrate-db.json   # where the choice + backup link are remembered
ADMIN_SECRET=change-me           # protects POST/DELETE /api/database

# Optional — 🔗 backup database (mirror + automatic failover).
# Any BACKUP_/SECONDARY_/REPLICA_/FALLBACK_ prefixed name works:
# BACKUP_DATABASE_URL=postgresql://user:pass@backup-host:5432/app_db
```

### 3. Launch with Docker Compose
```bash
docker-compose up -d --build
```

### 3b. 🗄 Connect any database later (no rebuild)

The bot ships with a database menu, so you are **not stuck** with the Postgres
container from `docker-compose.yml`:

1. Send `/database` to your bot.
2. Tap **🔌 Connect database** → pick Postgres / Turso / MongoDB / Upstash / Redis / Vercel Blob.
3. Paste the connection string (e.g. `postgresql://user:pass@host:5432/db`).

The new database is tested first (tables are created automatically), then the
site, chart, cron and alerts switch to it immediately. **🧪 Test connection**
re-checks the current one and **⏏️ Disconnect** returns to the environment
database (or to memory). The choice is stored in the `app_data` volume, so it
survives `docker-compose up -d --build`.

### 3c. 🔗 Keep a second database as a live backup (failover)

Send **`/link <type> <url>`** (or the 🗄 menu → **🔗 Link backup**) to add a
*second* database next to the one in use:

- every price tick and alert is **mirrored** into it, so it is always current;
- if the primary stops answering, the very next request is served by the backup
  (the rate, the chart, the cron and Telegram alerts keep working);
- the primary is re-checked every 30 s and traffic returns to it automatically,
  copying back the rows recorded while it was down;
- **🧬 Sync data** (or `POST /api/database {"action":"sync"}`) copies history +
  alerts between the two databases at any time — safe to run repeatedly, it
  never duplicates rows; **⬆️ Promote backup** swaps their roles;
- **⏏️ Unlink** stops mirroring and deletes nothing.

```bash
# optional: the same thing over HTTP (ADMIN_SECRET required)
curl -X POST https://your-domain.com/api/database -H "x-admin-secret: $ADMIN_SECRET" \
  -H 'content-type: application/json' \
  -d '{"action":"link","backup":{"kind":"postgres","url":"postgresql://user:pass@backup:5432/app_db"}}'
curl https://your-domain.com/api/database/link        # health of both databases
```

### 3d. 📤📥 Back up (or move) the data with /export and /import

Send **`/export`** and the bot posts the active database into the chat as a file:
`wingrate-export-*.json` (price history **+** alert subscriptions) or
**`/export csv`** for a spreadsheet of the history.

To restore or move it, send that file back to the bot as a **document** (or reply
**`/import`** to it). The bot reads the file, shows what it holds, and asks:

- **⬇️ Merge** — adds only what is missing (safe to repeat: importing the same
  file twice copies nothing, rows are de-duplicated on `(time, bid, ask)`);
- **♻️ Replace** — erases the stored history (and the alerts, when the file has
  them) first, then writes the file. Asks for a second confirmation.

Nothing is written before you confirm, imports above `IMPORT_MAX_MB` (default
5 MB) are refused before downloading, and a JSON export that contains alert
credentials can be deleted from the chat with the 🧹 button afterwards. Working
files, not just backups: the CSV opens in Excel/Numbers/Google Sheets, and rows
a backend cannot read (bad time, missing rate) are reported instead of failing.

### 4. Set up Telegram Webhook
To make the bot work, you must tell Telegram where to send messages:
```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://your-domain.com/api/bot/webhook"
```

### 5. Set up Rate Updates (Cron Job)
The Docker Compose poller checks Wing Bank every 10 seconds. If you run the app
without Docker Compose, use a cron job to check once per minute (the fastest
standard cron cadence):
```bash
crontab -e
```
Add this line:
```cron
* * * * * curl -fsS https://your-domain.com/api/cron/update-rate > /dev/null 2>&1
```

If you set `CRON_SECRET`, include the bearer header in the cron command:
```cron
* * * * * curl -fsS -H "Authorization: Bearer YOUR_CRON_SECRET" https://your-domain.com/api/cron/update-rate > /dev/null 2>&1
```

## 🌐 Domain & SSL
We recommend using **Nginx Proxy Manager** or **Caddy** to handle SSL (HTTPS), as Telegram Webhooks require HTTPS.

### Example Caddyfile:
```caddy
your-domain.com {
    reverse_proxy localhost:3000
}
```
