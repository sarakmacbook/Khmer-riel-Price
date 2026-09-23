# 📈 WingRate — Live KHR/USD Tracker for Wing Bank

A real-time USD/KHR exchange-rate tracker using **Wing Bank's** published rates
([wingbank.com.kh/en/exchange-rate](https://www.wingbank.com.kh/en/exchange-rate)).
It includes a price-history chart, a P2P unit-price calculator, an installable PWA, and a Telegram bot with alerts.

**Lightweight:** 7 runtime dependencies, no chart library, and no HTML-parser library. It works with **every free Vercel storage option** (Postgres, Redis, Turso, MongoDB and Blob).
It runs on the free **Vercel Hobby + Neon** tier. You can also self-host it on a VPS with one command.

---

## ✨ Features

| | |
|---|---|
| 💹 **Live rate** | Bank **Buys (Bid)** / **Sells (Ask)** USD/KHR, with a live "checked Xs ago" indicator |
| 📊 **Price history** | Day · Week · Month · Year · All. Switch between Buy (Bid) and Sell (Ask). Daily snapshots for Week and longer |
| 🧮 **Tiny calculator** | **Sell Ads** ÷ bank ask, **Buy Ads** ÷ bank bid, 5 decimal places |
| 🔔 **Telegram alerts** | Get alerts when the rate changes, or goes above/below a target. Use a webhook URL *or* a bot token + chat ID |
| 🤖 **Telegram bot** | `/rate`, `/alert`, `/stop`, `/start` |
| 📱 **PWA** | Add to home screen on iOS and Android, with browser notifications |
| 🌙 **Dark mode** | Always on, indigo theme |

---

## ▲ Option 1 — Deploy on Vercel (free)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYOUR_USERNAME%2Fwingrate)

1. **Import** this repo on Vercel (button above, or **New Project → Import**). It works right away and shows the live rate.
2. **Recommended — connect any database** for price history and saved Telegram alerts:
   Project → **Storage** → pick **any** of the free options below → connect it to the project (region: **Singapore** if offered) → **Redeploy**.
   WingRate **detects the database automatically** from the env vars the integration adds, and creates its tables/keys on first use.
3. Open **`https://your-app.vercel.app/api/status?check=1`**. It shows which database was detected (`storage.kind`), whether it's reachable, and a live Wing Bank test.

| Without a database | With any database |
|---|---|
| ✅ Live rate, calculator, PWA, test alerts | ✅ Everything, plus **price history** and **saved/automatic Telegram alerts** |

### 🗄️ Supported databases (all Vercel free-tier options)

| Database | Add it in Vercel | Env vars detected automatically | Notes |
|---|---|---|---|
| **Neon** (Postgres) | Storage → Neon | `DATABASE_URL` / `POSTGRES_URL` | Best all-rounder; daily snapshots computed in SQL |
| **Supabase** (Postgres) | Storage → Supabase | `POSTGRES_URL` | Free projects pause after ~1 week without traffic |
| **Prisma Postgres** | Storage → Prisma | `DATABASE_URL` (`postgres://…`) | The `prisma+postgres://` Accelerate URL is ignored automatically |
| **Nile** (Postgres) | Storage → Nile | `POSTGRES_URL` / `DATABASE_URL` | |
| **AWS Aurora Postgres** | Storage → AWS | any `…DATABASE_URL` / `…POSTGRES_URL` | Needs a password connection string (IAM-only auth isn't supported) |
| **Upstash Redis** | Storage → Upstash | `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) | Uses the HTTP REST API. About 2 commands per refresh |
| **Redis Cloud** | Storage → Redis | `REDIS_URL` | Built-in TCP/TLS client, no extra package |
| **Turso** (libSQL/SQLite) | Storage → Turso | `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | Uses the HTTP protocol, one atomic round-trip per refresh |
| **MongoDB Atlas** (M0) | Storage → MongoDB Atlas | `MONGODB_URI` | Allow access from anywhere (`0.0.0.0/0`); the integration does this for you |
| **Vercel Blob** | Storage → Blob | `BLOB_READ_WRITE_TOKEN` | Everything is kept in one small **private** JSON file. It's only rewritten when the price changes, once a day, or when you save alerts |

- **Custom prefixes work too.** If you gave the connection a prefix in Vercel (for example `MYDB_POSTGRES_URL`), it's still detected.
- **More than one connected?** The priority is Postgres → Turso → MongoDB → Upstash → Redis → Blob. Set `STORAGE=upstash` (or `postgres`, `turso`, `mongodb`, `redis`, `blob`, `memory`) to choose one yourself.
- **Every backend** saves a new history row only when the price changes, plus one daily snapshot, and handles several Vercel instances at once safely (you get 1 row and 1 Telegram alert per change). All six were tested with two app instances sharing one database.
- **Not supported:** MotherDuck (an analytics DuckDB with a heavy native driver), Convex (needs its own deployed backend functions), and Edge Config (read-only for apps; writing needs a Vercel API token).

> **Free-tier usage tips.** A refresh is checked at most once per `REFRESH_SECONDS` (default 60), and each warm instance reads the stored rate at most every 5–10 s (every 10 min for Blob).
> - **Operation-limited plans** (Upstash commands, Prisma operations, Blob operations): if you get near the limit, raise `REFRESH_SECONDS`, e.g. to `300`. Wing Bank only changes its rate a few times a day.
> - **Neon:** an external pinger hitting the site every minute, around the clock, keeps the database's compute running constantly, which uses up its free compute hours.

**Optional environment variables** (Project → Settings → Environment Variables, then redeploy):

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | Any random string. Protects `/api/cron/update-rate` |
| `TELEGRAM_BOT_TOKEN` | Turns on the Telegram bot and default alerts |
| `SITE_URL` | e.g. `https://your-app.vercel.app`. Used for links in alerts |
| `WINGBANK_URL` | Only needed if Wing Bank blocks Vercel (see troubleshooting below) |
| `STORAGE` | Force a backend when several databases are connected |

**Telegram bot on Vercel:** open this once in your browser:
`https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-app.vercel.app/api/bot/webhook`

### 🩺 Vercel troubleshooting

Open **`/api/status?check=1`** on your deployment. It reports the database status, your Vercel region, and a live Wing Bank test with its timing.

| What you see | Cause → fix |
|---|---|
| Page says **"Fetching the rate… up to 30s"** on first load | Normal. Wing Bank's server takes 5–15s to respond. After that, visitors get the cached rate instantly |
| `wingbank.kind: "timeout"` | Wing Bank was slow. It retries automatically, or you can raise `SCRAPE_TIMEOUT_MS` |
| `wingbank.kind: "blocked"` | Wing Bank's F5 firewall rejects Vercel's IPs. Either **self-host with `install.sh`** (a VPS IP usually works), or set `WINGBANK_URL` to a proxy that returns Wing Bank's page |
| `storage.reachable: false` | Wrong or expired credentials. Reconnect the storage integration and redeploy. **The live rate still works in the meantime** (in-memory fallback) |
| `storage.kind: "memory"` but you connected a database | The integration's env vars aren't in this deployment. **Redeploy** after connecting, and check the variables are enabled for Production |
| No history on the chart | No database connected (see step 2), or the database is new. History builds up from now on |
| Deploy fails: *"Hobby accounts are limited to daily cron jobs"* | Keep the `vercel.json` cron at once a day (the default) |

### How it stays fresh on the free tier

Vercel Hobby only allows cron jobs **once a day**, so WingRate refreshes **lazily**:

```
Browser polls /api/rate ─► Vercel CDN (cached 5s with a database, 30s without)
                              ▼
                        Function returns the stored rate instantly
                              ▼  if the last check was more than REFRESH_SECONDS (60) ago
                        Re-checks Wing Bank in the background (after the response is sent)
                        → stores only price changes → sends Telegram alerts
```

For Telegram alerts even when nobody has the site open, add a free pinger such as
[cron-job.org](https://cron-job.org) that runs every minute and calls `https://your-app.vercel.app/api/cron/update-rate?secret=YOUR_CRON_SECRET`.

---

## 🚀 Option 2 — One-click VPS install

**You need:** Ubuntu 20.04+ / Debian 11+ (or a `dnf`-based distro), about 1 GB RAM, and root access.
A domain is optional, but it's needed for HTTPS and for Telegram bot commands.

**Pick one. Each command downloads *all* project files and installs everything:**

```bash
# A) Self-contained installer hosted by your deployed site (every file is embedded in install.sh)
curl -fsSL https://your-app.vercel.app/install.sh | sudo bash

# B) Straight from your GitHub repo (no git needed; downloads the repo archive)
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/wingrate/main/install.sh \
  | sudo GITHUB_REPO=YOUR_USERNAME/wingrate bash

# C) From any .zip / .tar.gz of the project
curl -fsSL https://your-app.vercel.app/install.sh | sudo ARCHIVE_URL=https://example.com/wingrate.zip bash

# D) Clone and run
git clone https://github.com/YOUR_USERNAME/wingrate.git && cd wingrate && sudo ./install.sh
```

The files are installed to `/opt/wingrate` (change this with `INSTALL_DIR=`). The installer asks three questions (domain, Telegram token, update interval), and you can press **Enter** to skip any of them.
To run it unattended, set them up front: `sudo DOMAIN=rate.example.com TELEGRAM_BOT_TOKEN=123:abc UPDATE_INTERVAL=60 ./install.sh`

> **After changing the code**, run `bash scripts/build-installer.sh` and commit the result. This regenerates
> `public/install.sh` (all files embedded) and `public/wingrate.zip`, which your site then serves.

**What `install.sh` does:**
1. Installs `curl`, `git`, `openssl`, **Docker** and **Docker Compose** if they're missing
2. Writes `.env` with a random database password and cron secret (file mode `600`)
3. Checks your domain's DNS and opens firewall ports (`ufw` / `firewalld`)
4. Starts **PostgreSQL**, the **app** (which creates its tables automatically), an **updater** that checks Wing Bank every `UPDATE_INTERVAL` seconds, and **Caddy** for automatic HTTPS when you set a domain
5. Waits for the health check and fetches the first rate
6. Verifies your Telegram token, registers bot commands, and sets the webhook

It's **safe to re-run**: your secrets and data are kept.

```bash
sudo ./install.sh status      # health + latest rate
sudo ./install.sh logs        # live logs
sudo ./install.sh update      # pull latest (git / GITHUB_REPO / embedded) + rebuild
sudo ./install.sh restart
sudo ./install.sh             # change domain / token / interval
sudo ./install.sh uninstall   # asks before deleting data
```

To back up the database:
```bash
docker compose exec db pg_dump -U postgres app_db > backup.sql
```

---

## 🤖 Telegram

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token.
2. Add the token (in the Vercel env vars, or when `install.sh` asks), then set the webhook (Vercel) — the VPS installer does this for you.
3. Send `/start` to your bot to get your **chat ID**, then send `/alert` to subscribe.
4. Or, on the website, click the **✈️ icon next to the bell** to set up a webhook URL or bot token + chat ID, choose a trigger (on change / above / below), and **send a test alert**.

| Command | What it does |
|---|---|
| `/start` | Help text and your chat ID |
| `/rate` | Current Wing Bank bid and ask |
| `/alert` | Subscribe to rate-change alerts |
| `/stop` | Unsubscribe |

---

## ⚙️ Environment variables

| Variable | Default | Where | Description |
|---|---|---|---|
| *database vars* | — | all | **Optional.** Any supported database (see the table above) is auto-detected. Needed for history and saved alerts |
| `STORAGE` | auto | all | Force `postgres` \| `turso` \| `mongodb` \| `upstash` \| `redis` \| `blob` \| `memory` |
| `TZ_OFFSET_HOURS` | `7` | all | Time zone used to group daily snapshots (Cambodia = UTC+7) |
| `REDIS_PREFIX` | `wingrate:` | redis | Key prefix, if you share the Redis database with other apps |
| `MONGODB_DB` | from URI, or `wingrate` | mongodb | Database name |
| `WINGBANK_URL` | Wing Bank en,km | all | Comma-separated source URLs (e.g. a proxy) |
| `SCRAPE_TIMEOUT_MS` | `45000` | all | Total time allowed for one Wing Bank fetch |
| `TELEGRAM_BOT_TOKEN` | — | all | Bot token from @BotFather |
| `CRON_SECRET` | — | all | Protects `/api/cron/update-rate` (Bearer header or `?secret=`) |
| `SITE_URL` | — | all | Public URL, used for links in alerts |
| `REFRESH_SECONDS` | `60` | all | Minimum seconds between Wing Bank checks (minimum 10) |
| `NEXT_PUBLIC_POLL_SECONDS` | `5` | all | How often the browser polls. Set at **build time** |
| `DOMAIN`, `UPDATE_INTERVAL`, `POSTGRES_PASSWORD`, `APP_PORT`, `APP_BIND`, `COMPOSE_PROFILES` | auto | VPS | Written by `install.sh` |

---

## 💻 Local development

```bash
npm install
docker run -d --name wingrate-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app_db -p 5432:5432 postgres:15-alpine
cp .env.example .env
npm run dev          # tables are created on the first request
```

---

## 🔌 API

| Endpoint | Description |
|---|---|
| `GET /api/rate` | `{ rate, bid, ask, timestamp, checkedAt }`, CDN-cached for 5s |
| `GET /api/rate/history?range=day\|week\|month\|year\|all` | `[{ bid, ask, t }]`, CDN-cached for 60s |
| `GET /api/cron/update-rate` | Force a Wing Bank refresh and send alerts. Needs `CRON_SECRET` |
| `GET/POST /api/telegram/settings` | Read/save alert settings |
| `POST /api/telegram/test` | Send a test alert |
| `POST /api/bot/webhook` | Telegram bot webhook |
| `GET /api/status?check=1` | Diagnostics: database, region, live Wing Bank test |
| `GET /api/health` | Health check |

---

## 📁 Project structure

```
├── vercel.json             # region (Singapore) + daily cron
├── install.sh              # one-click VPS installer & manager
├── scripts/build-installer.sh  # builds public/install.sh (self-contained) + public/wingrate.zip
├── docker-compose.yml      # db + app + updater + caddy (VPS)
├── Dockerfile · Caddyfile
├── public/                 # PWA manifest, service worker, icons
└── src/
    ├── app/page.tsx                   # dashboard UI
    ├── app/api/...                    # API routes
    ├── components/PriceChart.tsx      # dependency-free SVG chart
    ├── components/TelegramAlertModal.tsx
    ├── db/                            # Drizzle schema + Postgres pool
    ├── lib/store/                     # storage adapters (auto-detected)
    │   ├── env.ts                     #   detects the database from env vars
    │   ├── postgres.ts · turso.ts · mongodb.ts
    │   ├── redis.ts · redis-client.ts #   Upstash REST + Redis TCP (no deps)
    │   ├── blob.ts · memory.ts
    ├── lib/rates.ts                   # lazy refresh, change-based storage
    ├── lib/scraper.ts                 # dependency-free Wing Bank scraper
    └── lib/alerts.ts · telegram.ts    # Telegram notifications
```

---

## 🩺 Troubleshooting

| Problem | Fix |
|---|---|
| Vercel deploy fails with "Hobby accounts are limited to daily cron jobs" | Keep the `vercel.json` cron at once a day (the default) |
| `/api/rate` returns 503 | Open `/api/status?check=1`. The response includes `kind` (timeout / blocked / layout) and a hint |
| Rate isn't updating | Wing Bank may have changed its page layout or blocked the server's IP (see `src/lib/scraper.ts`) |
| Bot doesn't reply | Check `https://api.telegram.org/bot<TOKEN>/getWebhookInfo`. The webhook must be HTTPS |
| Chart is empty | A new install has no history yet. It builds up automatically |

---

## ⚠️ Disclaimer

Not affiliated with Wing Bank. Rates are read from Wing Bank's public website and may be delayed or inaccurate. **Not financial advice.**

<sub>✨ Built with Claude (Anthropic)</sub>
