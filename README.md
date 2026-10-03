# WingRate ⚡ — KHR/USD Live Tracker

Real-time **USD/KHR exchange rate tracker** scraped from **[Wing Bank](https://www.wingbank.com.kh/en/exchange-rate)** — the priority (and only) rate source — with an all-time price chart, tiny P2P calculator, browser + Telegram alerts, PWA install, and a **one-command VPS installer**.

---

## ✨ Features

- 🏦 **Wing Bank-only rate source** — official Bid (Bank Buys) / Ask (Bank Sells) / Mid, no third-party or market fallback
- 📊 **Live dashboard** — 1-second polling with change flash + up/down trend arrow
- 📈 **Price history chart** — switch between **Buy (Bid)** and **Sell (Ask)**, ranges: **Day · Week · Month · Year · All** (daily snapshots)
- 🧮 **Tiny calculator** — `Sell Ads` / `Buy Ads` unit-price converter: divides your KHR amount by the live Wing Bank ask/bid price (opens at `40` KHR)
- 📲 **PWA** — add to home screen on **Android & iPhone** (manifest + service worker + icon)
- 🔔 **Browser notifications** — fire the moment the bank rate moves
- 🤖 **Telegram** — bot commands + webhook alerts (`only on price move` / `rate above` / `rate below`), with a **custom alert message** template, configured from the UI next to the bell icon
- 🗄 **Connect a database from Telegram** — `/database` menu to connect, switch, test or disconnect Postgres · Turso · MongoDB · Upstash · Redis · Vercel Blob at runtime, no redeploy or env edits
- ⏱ **All-time tick history** in any supported database, written by a background cron every 5 minutes
- ▲ **Vercel-deployable** and **Docker-compose** self-hostable

---

## 🚀 One command — `install.sh` does everything

The whole stack — **including downloading/linking every project file** — is
set up by a single command. No manual clone, build, table creation or config.

**Run from anywhere (the script fetches ALL files itself):**

```bash
curl -fsSL https://raw.githubusercontent.com/<you>/wingrate/main/install.sh \
  | sudo bash -s -- https://github.com/<you>/wingrate.git
```

**Or, if you already cloned the repo:**

```bash
cd wingrate && sudo bash install.sh
```

It will **prompt you for two things**:

1. **Telegram Bot Token** (from [@BotFather](https://t.me/BotFather))
2. **Your domain** (e.g. `rate.yourdomain.com`)

…and then it runs all seven steps automatically:

| Step | What `install.sh` does |
| ---- | ---------------------- |
| **0/7** | **Links to all project files** — `git clone`s the repo into `~/wingrate` when you're not already inside the project |
| **1/7** | Installs **Docker** + **Docker Compose** (+ git if missing) |
| **2/7** | Prompts for your bot token and domain |
| **3/7** | Generates `.env` (`DATABASE_URL`, `POSTGRES_URL`, `TELEGRAM_BOT_TOKEN`, `NEXT_PUBLIC_SITE_URL`) |
| **4/7** | Runs `docker-compose up -d --build` — starts **PostgreSQL 15**, the **Next.js app** (port 3000), and the **rate-updater sidecar** |
| **5/7** | Registers your **Telegram webhook** → `https://<domain>/api/bot/webhook` |
| **6/7** | Installs the **crontab entry** that hits `/api/cron/update-rate` every 5 minutes |
| **7/7** | Creates all database tables automatically (`drizzle-kit push` inside the container) |

When it finishes you'll see:

```
✅ Installation Complete!
🌐 Your site: https://rate.yourdomain.com
🤖 Bot is now active.
⏰ Rates will update every 5 minutes via Cron.
```

> ⚠️ **HTTPS is still on you:** point your domain at port **3000** with a
> reverse proxy (**Caddy** or **Nginx**) so HTTPS works — Telegram webhooks and
> the PWA/notifications require an `https://` origin.

### Verify

```bash
docker-compose ps
curl https://yourdomain.com/api/health
```

---

## 🐳 Manual Docker install (same result as install.sh)

```bash
git clone https://github.com/<you>/wingrate.git && cd wingrate

# 1. environment
cp .env.example .env       # then edit the three values

# 2. launch Postgres + app + rate sidecar
docker-compose up -d --build

# 3. create tables
docker-compose exec app npx drizzle-kit push

# 4. tell Telegram where to send updates
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://your-domain.com/api/bot/webhook"

# 5. rate updates (install.sh already does this)
(crontab -l 2>/dev/null; echo "*/5 * * * * curl -s https://your-domain.com/api/cron/update-rate > /dev/null 2>&1") | crontab -
```

Docker Compose services: `db` (postgres:15-alpine) · `app` (port 3000) · `cron` (curl loop every 300s).

---

## 💻 Local development

```bash
cp .env.example .env       # DATABASE_URL must point at your Postgres
npm install
npx drizzle-kit push       # create tables
npm run dev                # http://localhost:3000
```

Background rate writer for dev:

```bash
bash scripts/update-rates.sh    # curls /api/cron/update-rate every 5 min
```

---

## 🔌 API reference

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| GET | `/api/rate` | Live Wing Bank rate (rate, bid, ask) |
| GET | `/api/rate/history?range=day\|week\|month\|year\|all` | Chart series (daily snapshots, bid & ask) |
| GET | `/api/health` | Health check |
| GET/POST | `/api/telegram/settings` | Read / save Telegram alert configuration |
| POST | `/api/telegram/test` | Send a test alert to Telegram |
| GET/POST/DELETE | `/api/database` | Read the active database · connect/switch one · disconnect (writes need `ADMIN_SECRET`/`CRON_SECRET`) |
| POST | `/api/bot/webhook` | Telegram bot updates — `/start` `/rate` `/alert` `/stop` `/database` `/connect` |
| GET/POST | `/api/cron/update-rate` | Scrape rate → store tick → fire Telegram alerts |

---

## ⚙️ Environment variables

| Variable | Purpose |
| -------- | ------- |
| `DATABASE_URL` | PostgreSQL connection string (`postgresql://postgres:postgres@db:5432/app_db` in Docker) |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather — powers `/rate`, alerts, webhook |
| `NEXT_PUBLIC_SITE_URL` | Public URL used for links inside alerts |
| `CRON_SECRET` | Optional — protects `/api/cron/update-rate` (`Bearer <secret>`) |
| `TELEGRAM_WEBHOOK_SECRET` | Optional — when set, `/api/bot/webhook` only accepts updates carrying this `X-Telegram-Bot-Api-Secret-Token` (register it with `setWebhook&secret_token=…`) |
| `TELEGRAM_API_URL` | Optional — Bot API base, defaults to `https://api.telegram.org` (useful behind a proxy) |
| `TELEGRAM_TIMEOUT_MS` | Optional — per-request Telegram timeout, default `10000` |
| `TELEGRAM_ADMIN_CHAT_ID` | Optional — only this chat may use the Telegram 🗄 `/database` menu. Set it to lock the bot down (without it the first chat that runs `/database` becomes the owner) |
| `DB_CONFIG_FILE` | Optional — file where the database picked in Telegram is remembered, default `<cwd>/.data/wingrate-db.json` |
| `DB_CONFIG_JSON` | Optional — the same document inline (`{"mode":"custom","spec":{"kind":"postgres","url":"…","token":"…"}}`) for read-only filesystems / serverless. A saved config file wins over it |
| `ADMIN_SECRET` | Optional — secret required by `POST`/`DELETE /api/database` (`x-admin-secret` header or `Bearer`). Without it (or `CRON_SECRET`), changing the database over HTTP is disabled and only Telegram can do it |

> **Telegram alerts work with any storage backend.** Alert settings and bot
> subscriptions are read/written through the same storage layer as the price
> history (Postgres · Turso · MongoDB · Upstash/Redis · Vercel Blob · memory),
> so `/api/telegram/settings`, `/api/telegram/test`, `/api/bot/webhook` and the
> automatic rate alerts no longer require PostgreSQL specifically. Without any
> database they still work for the lifetime of the process — connect one to make
> them permanent.

> **Alerts fire only when the price actually moves** — a notification is sent
> when the Wing Bank buy **or** sell rate changes (up or down), never on the
> same price twice and never on the very first tick (there is no previous
> price to compare). **Custom messages**: in the bell menu you can replace the
> default layout with your own text (max 1200 chars) using the codes
> `{bid}` `{ask}` `{diff}` `{arrow}` `{time}` `{link}` — leave it blank for the
> standard message, and use *Send Test Alert* to preview exactly what you'll receive.

---

## ▲ Deploy to Vercel — lightweight build

The project is tuned to deploy small and cold-start fast:

- ⚡ **Code-split chart** — Recharts + the Telegram modal are `next/dynamic` lazy chunks, so first paint ships only the dashboard shell (no 500 KB chart in the initial JS)
- 🗜 **Optimized PWA icons** — 1 MB → **5 KB** (192px) and 117 KB → **6 KB** (512px), cutting ~1.1 MB from the deploy artifact
- 🐘 **Serverless-safe Postgres** — one cached pool (`max: 3`) reused across warm invocations, auto-TLS for Neon/Supabase, works with `POSTGRES_URL` **or** `DATABASE_URL`
- 🧹 **No `@vercel/postgres` / `telegraf` in the bundle** — the DB client uses plain `pg`, Telegram uses `fetch`
- ⏰ **Hobby-safe cron** — `vercel.json` ships a **daily** schedule (`0 0 * * *`), which is the finest cron Vercel Hobby allows (5-minute crons are a **Pro** feature)

### Steps

1. Push to GitHub → import at [vercel.com/new](https://vercel.com/new).
2. Add a database from the **Storage** tab: **Neon / Supabase / Turso / Upstash(KV)** — any of them works; its integration sets the env vars automatically.
3. Deploy and **open the site once** — tables/keys are created automatically (no `drizzle-kit push` on Vercel) and daily history is seeded.
4. Set `TELEGRAM_BOT_TOKEN`, `NEXT_PUBLIC_SITE_URL`, optional `CRON_SECRET` (needs a redeploy afterwards).
5. Register the webhook:
   ```bash
   curl -X POST https://your-app.vercel.app/api/bot/webhook   # (Telegram side)
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-app.vercel.app/api/bot/webhook"
   ```

> 📌 `vercel.json` ships a **5-minute cron**. The **Vercel Hobby plan rejects
> schedules more frequent than daily** — if the deploy fails validation,
> change it to `0 0 * * *` (daily) on Hobby, or use **Pro**. Live ticks are
> still recorded whenever a visitor has the dashboard open.

---

## 💾 Every Vercel free-tier database works for price history

The app auto-detects whichever store your deployment provides — set **one**
group of env vars and price history just works (priority order):

| # | Database | Free tier | Env vars | Setup |
| - | -------- | --------- | -------- | ----- |
| 1 | **Turso / libSQL** | 500 DBs, 9 GB | `TURSO_DATABASE_URL`/`LIBSQL_URL`, `TURSO_AUTH_TOKEN` | Tables auto-created on first tick |
| 2 | **Upstash Redis / Vercel KV** | 10k cmds/day | `UPSTASH_REDIS_REST_URL`/`…TOKEN` or `KV_REST_API_URL`/`KV_REST_API_TOKEN` | Keys auto-created, writes throttled to fit the free quota |
| 3 | **Neon / Supabase / Vercel Postgres** | generous free Postgres | `POSTGRES_URL` \| `POSTGRES_PRISMA_URL` \| `DATABASE_URL` \| `SUPABASE_DB_URL` | **Tables auto-created on first request** — no `drizzle-kit push` needed on Vercel |
| 4 | **No database** | — | — | Live rate still works (scraped); history kept in memory |

> 🔌 After connecting a database integration in Vercel, just (re)deploy and open
> the site once: the schema is created automatically and a year of daily
> snapshots is seeded immediately. Verify with `GET /api/health` — it reports
> `store`, which env vars were detected, and the connection status.

Verify which one is active: `GET /api/health` → `{"ok":true,"store":"upstash",…}`,
or the `x-store` header on `GET /api/rate/history`.

> 📌 **Anything can change at runtime.** The site, chart, cron, alerts and bot
> subscriptions all read the *active* store — the one the env vars select, or the
> one connected from Telegram. See the next section.

## 🗄 Connect any database from Telegram — no redeploy

Send **`/database`** to your bot: you get a menu to connect, switch between,
test and disconnect databases while the app is running. Everything (dashboard,
chart, history, cron, price alerts, bot subscriptions) follows the switch
immediately — the old builds were stuck with whichever database the
environment variables pointed at.

| Action | How |
| ------ | --- |
| Open the menu | `/database`, `/db` or `/storage` |
| Connect | **🔌 Connect database** → tap a type → **paste the connection string** (or `/connect <type> <url> [token]`) |
| Switch | **🔌 Connect database** again and paste another one — the previous database stays untouched |
| Test | **🧪 Test connection** (re-connects and reports latency + row count) |
| Disconnect | **⏏️ Disconnect** → *use no database (in-memory)* or *use the environment database* |

```bash
# Examples of /connect (the type is optional when the URL is unambiguous)
/connect postgres postgresql://user:pass@host:5432/dbname
/connect https://my-db-org.turso.io eyJhbGciOi...          # Turso/libSQL + token
/connect mongodb+srv://user:pass@cluster.mongodb.net/wingrate
/connect upstash https://xxx.upstash.io AX...token
/connect rediss://default:pass@host:6379
/connect blob vercel_blob_rw_xxxxxxxx_yyyyyyyy
```

**How it behaves**

- 🔎 **Safe by design** — the new database is probed (connect → create
  tables/keys → read) *before* anything switches. A typo leaves the working
  database untouched.
- 💾 **Remembers the choice** — saved to `DB_CONFIG_FILE`
  (`<cwd>/.data/wingrate-db.json` in Docker, via the `app_data` volume). When
  the working directory is read-only it falls back to a namespaced file in
  `$TMPDIR` and tells you so; `DB_CONFIG_JSON` pins a choice permanently for
  serverless deploys. **Resolution order:** config file → `DB_CONFIG_JSON` → env auto-detection.
- 🔒 **Owner only** — set `TELEGRAM_ADMIN_CHAT_ID` to the allowed chat id, or
  leave it unset and the first chat that runs `/database` claims ownership
  (the claim is stored with the config). Other chats get a "only the bot owner"
  reply.
- 🧹 **No credentials left behind** — passwords/tokens are masked in every reply
  and the message you pasted them in is deleted when Telegram permits it.
- 🐳 **Docker** — the choice lives in the `app_data` volume, so
  `docker-compose up -d --build` keeps it. **Vercel** — write a choice once and
  it applies to the instance handling the webhook; set `DB_CONFIG_JSON` (or
  reuse the same database through env vars) if you want every cold instance on it.
- 🧰 **Same thing over HTTP** (for the dashboard or scripts):

```bash
# read (no secret needed, secrets are masked)
curl https://your-app.vercel.app/api/database

# connect / switch (needs ADMIN_SECRET or CRON_SECRET)
curl -X POST https://your-app.vercel.app/api/database \
  -H "x-admin-secret: $ADMIN_SECRET" -H 'content-type: application/json' \
  -d '{"kind":"postgres","url":"postgresql://user:pass@host:5432/db"}'

# disconnect (mode=memory default, mode=auto = back to the env database)
curl -X DELETE "https://your-app.vercel.app/api/database?mode=auto" -H "x-admin-secret: $ADMIN_SECRET"
```

`GET /api/health` and `GET /api/status` report the active store, how it was
chosen (`environment variables` / `connected via Telegram` / `restored from the
saved config file`) and where the choice is saved.

---

## 🗂 Project structure

```
install.sh                  ← one-command VPS installer (everything)
docker-compose.yml          ← db + app + rate-sidecar
Dockerfile
INSTALL.md                  ← detailed deployment guide
scripts/update-rates.sh     ← dev rate-writer loop
public/                     ← PWA manifest, service worker, icons
src/
  app/                      ← pages + API routes
  components/               ← UI (TelegramAlertModal, …)
  db/                       ← Drizzle schema & client
  lib/
    scraper.ts              ← Wing Bank scraper (cheerio)
    telegram.ts             ← Telegram send helpers (messages, buttons, callbacks)
    bot-database.ts         ← 🗄 Telegram database menu (connect/switch/test/disconnect)
    db-config.ts            ← runtime database choice: file / DB_CONFIG_JSON / ownership
    db-actions.ts           ← connect · disconnect · test (shared by bot & API)
    store/                  ← storage layer: postgres · turso · mongodb · redis · blob · memory
```

---

## 🤖 Model credit

> Built entirely by **Claude** (Anthropic) — **Claude Sonnet 4.5**, version **4.5**, API ID `claude-sonnet-4-5-20250929`.

---

**Rates are indicative only, provided by Wing Bank (Cambodia) Plc. Not financial advice.**
