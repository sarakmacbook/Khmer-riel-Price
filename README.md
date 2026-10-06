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
- 🔗 **Backup database & automatic failover** — link a second database (any supported kind): every write is mirrored into it, it takes over within the same request if the primary goes down, and the app returns to the primary automatically — `/link`, `/sync`, `/promote`, or `POST /api/database`
- 📤 **Export & import from Telegram** — `/export` sends the whole database to the chat as a **JSON** (history + alert subscriptions) or **CSV** file; `/import` reads such a file back, showing what it holds and offering **merge** (idempotent, never duplicates) or **replace** — a backup you can keep, move to another deployment, or open in a spreadsheet
- ⏱ **All-time tick history** in any supported database, checked every 10 seconds by the VPS/Docker poller (and while the dashboard is open)
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
| **6/7** | Installs a **once-per-minute fallback cron**; the Docker poller itself checks every 10 seconds |
| **7/7** | Creates all database tables automatically (`drizzle-kit push` inside the container) |

When it finishes you'll see:

```
✅ Installation Complete!
🌐 Your site: https://rate.yourdomain.com
🤖 Bot is now active.
⏰ Rates are checked every 10 seconds; Telegram alerts are sent as soon as a change is detected.
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

# Docker's included cron service polls every 10 seconds. For a non-Docker
# deployment, add this once-per-minute fallback to the host crontab:
(crontab -l 2>/dev/null; echo "* * * * * curl -fsS https://your-domain.com/api/cron/update-rate > /dev/null 2>&1") | crontab -
```

Docker Compose services: `db` (postgres:15-alpine) · `app` (port 3000) · `cron` (curl loop every 10s by default; configurable with `RATE_UPDATE_INTERVAL_SECONDS`).

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
bash scripts/update-rates.sh    # every 10 sec by default (override RATE_UPDATE_INTERVAL_SECONDS)
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
| GET/POST/DELETE | `/api/database` | Read the active database · connect/switch one · disconnect · **link/unlink a backup, copy data, promote the backup** (writes need `ADMIN_SECRET`/`CRON_SECRET`) |
| GET | `/api/database/link` | Backup database health: which side is serving, rows/latency on both, failover counters, sync state (`?fresh=1` forces a real re-check) — safe to poll, no secrets |
| POST/DELETE | `/api/database/link` | Link a backup database (`{kind,url,token}` + options) · unlink (writes need the admin secret) |
| POST | `/api/bot/webhook` | Telegram bot updates — `/start` `/rate` `/alert` `/stop` `/database` `/connect` `/link` `/sync` `/promote` `/unlink` `/export` `/import` |
| GET/POST | `/api/cron/update-rate` | Scrape rate → store tick → fire Telegram alerts → repair the backup if it fell behind |

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
| `BACKUP_DATABASE_URL`, `SECONDARY_*`, `REPLICA_*`, `FALLBACK_*` | Optional — a **second database** described purely by env vars (e.g. `BACKUP_DATABASE_URL`, `SECONDARY_TURSO_DATABASE_URL` + `SECONDARY_TURSO_AUTH_TOKEN`, `FALLBACK_MONGODB_URI`). Detected separately from the primary, so `BACKUP_DATABASE_URL` never becomes the primary by accident |
| `DB_BACKUP_JSON` | Optional — the linked backup inline for read-only filesystems: `{"kind":"postgres","url":"postgresql://…","options":{"mirror":true}}` |
| `LINK_MIRROR` / `LINK_AUTO_FAILOVER` / `LINK_AUTO_RETURN` / `LINK_AUTO_RESYNC` | Optional — turn individual link behaviours off (`0`/`false`) |
| `LINK_PROBE_SECONDS` | Optional — how often a failed primary is re-checked while the backup serves, default `30` |
| `LINK_STATUS_TTL_MS` | Optional — cache for the two-sided status probe, default `5000` |
| `LINK_COPY_LIMIT` / `LINK_RESYNC_LIMIT` | Optional — max history rows per manual copy (default `20000`) and per automatic catch-up (default `5000`) |
| `LINK_MAX_LAG_SECONDS` | Optional — how far behind the backup may get before the cron repairs it, default `900` |
| `EXPORT_LIMIT` | Optional — max history rows in one `/export` file, default `50000` (the newest rows win, and the file says it was truncated) |
| `EXPORT_MAX_MB` | Optional — upload budget for an export, default `20` (the export is shrunk to fit rather than failing Telegram's 50 MB limit) |
| `IMPORT_MAX_MB` | Optional — largest file `/import` accepts, default `5` (Telegram itself caps bot downloads at 20 MB) |
| `TELEGRAM_FILE_TIMEOUT_MS` | Optional — timeout for uploading/downloading a file, default `60000` |

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
- ⏰ **Hobby-safe cron** — `vercel.json` ships a **daily** schedule (`0 0 * * *`) so free Hobby deployments remain deployable; use a Pro cron or external scheduler for unattended minute-level checks

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

> 📌 Wing Bank does not push rate changes to the app, so alerts are sent as
> soon as polling detects a change. With the dashboard open, the rate source is
> checked about every **10 seconds**. The VPS/Docker poller also runs every 10 seconds.
> Vercel **Hobby** only permits a daily cron (and may run it up to 59 minutes
> late), so it cannot provide unattended near-real-time alerts. For background
> minute-level checks on Vercel, use **Pro** and set the cron schedule to
> `* * * * *`, or use an external scheduler to call `/api/cron/update-rate`
> once per minute.

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

## 🔗 Backup database + automatic failover

A deployment can use **two** databases instead of one:

```
        every write                        primary down?
  app ─────────────▶  primary  ◀── probe ── 30s
   │                    (Neon)                 │  yes → serve from the backup
   └─────────────▶  backup   ◀─────────────────┘         (same request)
                     (Turso)
```

| Action | How |
| ------ | --- |
| Link a backup | `/link <type> <url> [token]` (alias `/backup`), the 🗄 menu → **🔗 Link backup**, or `POST /api/database {"action":"link","backup":{…}}` |
| See the state | `/database` → “🔗 Backup database”, `GET /api/database/link`, `GET /api/status` |
| Copy data | `/sync [to\|from\|auto]`, the menu → **🧬 Sync data**, or `POST /api/database {"action":"sync"}` |
| Make it primary | `/promote` or `POST /api/database {"action":"promote"}` (swaps the two roles, keeps both databases' data) |
| Stop mirroring | `/unlink` or `DELETE /api/database?link=1` — **nothing is deleted on either side** |

**How it behaves**

- 🪞 **Live copy** — with `mirror` on (default), every tick and alert is written
  to both databases, so the second one is always current and can be used
  directly, not just in an emergency.
- ⚡ **Same-request failover** — a request that the primary fails is retried on
  the backup (read *and* write): the live rate, the chart, the cron and Telegram
  alerts keep working during an outage.
- ↩️ **Automatic return + catch-up** — the primary is re-probed (default every
  30 s); as soon as it answers, traffic goes back and the rows/alerts that were
  written to the backup are copied back into it (`autoResync`). The 10-second
  poller also repairs a backup that missed writes.
- 🧬 **Sync any two databases** — `POST /api/database` with
  `{"action":"sync","from":{…},"to":{…}}` copies history + alerts between two
  arbitrary databases (e.g. moving an old Postgres into a new Turso before
  switching over). Copies are **idempotent** (matched on timestamp/price and on
  the alert's chat/condition/target), so running one twice never duplicates
  anything; `"mode":"replace"` clears the target first, and `"dryRun":true`
  reports what a copy would do without touching it.
- 🛟 **A broken backup can never break the app** — mirror failures are logged and
  skipped (they never fail the request); if *both* databases are down the app
  falls back to the in-memory store, exactly as it does today.
- 🔒 **Same protection as the rest of the database menu** — owner-only in
  Telegram, admin secret over HTTP, connection strings always masked (a Vercel
  Blob token *is* a connection string, so it is masked too).

```bash
# link a second database (Neon) as the backup, copy this database into it,
# and keep every future write mirrored into both
curl -X POST https://your-app.vercel.app/api/database \
  -H "x-admin-secret: $ADMIN_SECRET" -H 'content-type: application/json' \
  -d '{"action":"link",
       "backup":{"kind":"postgres","url":"postgresql://user:pass@ep-x.eu-central-1.aws.neon.tech/backup"},
       "options":{"mirror":true,"autoFailover":true,"autoReturn":true,"autoResync":true},
       "syncNow":true}'

# health of both databases (no secret needed, no credentials returned)
curl https://your-app.vercel.app/api/database/link

# copy / reconcile the two databases (idempotent), or plan it first
curl -X POST https://your-app.vercel.app/api/database \
  -H "x-admin-secret: $ADMIN_SECRET" -H 'content-type: application/json' \
  -d '{"action":"sync","target":"auto","dryRun":true}'

# swap roles: the backup becomes the primary database
curl -X POST https://your-app.vercel.app/api/database \
  -H "x-admin-secret: $ADMIN_SECRET" -H 'content-type: application/json' \
  -d '{"action":"promote"}'
```

> **No env vars needed.** Linking works entirely at runtime (Telegram or API)
> and is remembered in the same config document as the primary choice
> (`DB_CONFIG_FILE` / `.data/wingrate-db.json`, or `DB_CONFIG_JSON` on
> serverless). Env-only deployments can instead set `BACKUP_DATABASE_URL` (or
> any `SECONDARY_*` / `REPLICA_*` / `FALLBACK_*` var) or `DB_BACKUP_JSON` —
> see the table below.

---

## 📤 Export & import from Telegram

`/export` writes the **active** database to a file and sends it to the chat;
`/import` reads such a file back — into whichever database is connected at that
moment. Nothing has to be redeployed or taken offline, and the files are plain
text (JSON or CSV), so they also work as an off-site backup or a way to move
data between deployments.

| Action | How |
| ------ | --- |
| Export everything | `/export` (JSON: price history **+** alert subscriptions) |
| Export for a spreadsheet | `/export csv` (history only: `t,iso,bid,ask`) |
| Export alerts only | `/export json alerts` |
| Export from the menu | `/export` → **📤 Export options**, or the 📤📥 card in `/database` |
| Import | Send the file as a **document**, or **reply** `/import` to one already in the chat |
| Choose what happens | The preview card offers **⬇️ Merge** (adds only what is missing) or **♻️ Replace** (erases the history — and the alerts, when the file has them — first) |
| Keep credentials out of the chat | When the file carried alert credentials, the result card offers **🧹 Delete the file message** |

**How it behaves**

- 🔎 **Idempotent imports** — the file is written through the same copy pipeline
  as the 🔗 backup feature: history rows are de-duplicated on
  `(timestamp, bid, ask)` and alert subscriptions on their natural key
  (chat/webhook + condition + target). Importing the same file twice reports
  *“0 copied, N already there”* and changes nothing.
- 🛑 **Nothing is written before you confirm** — the file is downloaded, parsed
  and summarised first; the write only happens on the Merge/Replace button, and
  Replace asks a second time.
- 🧾 **Forgiving readers** — a JSON export from `/export`, a JSON array of
  `{t,bid,ask}` (or `{timestamp, rate}`, epoch seconds, ISO dates …), or a CSV
  with a `t,bid,ask` / `timestamp,buy,sell` header all import. Rows that cannot
  be read are counted and reported instead of failing the file.
- 🧱 **Bounded** — `EXPORT_LIMIT` rows and `EXPORT_MAX_MB` bytes per export (the
  newest rows win, and the caption says the file is truncated); imports refuse
  files above `IMPORT_MAX_MB` (default 5 MB) *before* downloading them.
- 🗄 **Works on every backend** — Postgres · Turso · MongoDB · Upstash · Redis ·
  Vercel Blob · memory (merge needs bulk insert, replace also needs erase; a
  backend that cannot erase it refuses the replace and suggests merge).
- 🔒 **Owner only** — the same rule as the 🗄 menu (`TELEGRAM_ADMIN_CHAT_ID`, or
  the first chat that claimed ownership).
- 🔐 **Credentials in the file** — a JSON export contains the alert
  subscriptions, including webhook URLs and bot tokens, so it can restore a
  deployment completely; the caption says so, masked tokens are never written,
  and you can delete the message afterwards.

```text
/export                     → 📄 wingrate-export-20261006-0042.json  (27 KB, 365 rows, 2 alerts)
/export csv                 → 📊 wingrate-rates-20261006-0042.csv    (365 rows, history only)
/import                     → how to send a file
<send the .json file>       → 📥 preview: 365 rows · 2025-10-06 → 2026-10-05 · 2 alerts · into 🐘 Neon
                              [⬇️ Merge]  [♻️ Replace]  [✖️ Cancel]
```

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
    bot-database.ts         ← 🗄 Telegram database menu (connect/switch/test/disconnect + 🔗 backup)
    bot-export.ts           ← 📤📥 Telegram /export & /import (preview card, merge/replace)
    export-file.ts          ← the export file format: encode/decode JSON + CSV, validation, limits
    db-config.ts            ← runtime database choice: file / DB_CONFIG_JSON / ownership / linked backup
    db-actions.ts           ← connect · disconnect · test · link backup · sync · promote
    link-jobs.ts            ← cron caretaker: failover catch-up + mirror repair
    store/                  ← storage layer: postgres · turso · mongodb · redis · blob · memory
    store/linked.ts         ← two databases joined: mirror, failover, auto-return, re-sync
    store/transfer.ts       ← copying history + alerts between databases (idempotent)
    store/file.ts           ← an import file exposed as a read-only store (source of the copy)
```

---

## 🧪 Tests

The backup/failover and export/import features ship with runnable checks (no
database account or bot token needed — they use the in-memory store and a local
HTTP server that speaks the Telegram Bot API):

```bash
npm run test:link          # 59 checks: env scoping, mirroring, failover, auto-return,
                           # catch-up, idempotent/merge/replace copies, masking

npm run test:export        # 89 checks for 📤📥 export/import: JSON & CSV round trips,
                           # tolerant readers, limits, merge/replace/idempotency — and the
                           # whole Telegram conversation against a local fake Bot API
                           # (document upload + download, preview card, buttons)

node scripts/fake-blob-server.mjs &   # stands in for a cloud store over HTTP
npm run test:link:live                # 25 checks end to end: two real HTTP-backed
                                      # databases, one killed mid-flight → the other serves,
                                      # the first recovers → traffic returns and data is copied back
```

---

## 🤖 Model credit

> Built entirely by **Claude** (Anthropic) — **Claude Sonnet 4.5**, version **4.5**, API ID `claude-sonnet-4-5-20250929`.

---

**Rates are indicative only, provided by Wing Bank (Cambodia) Plc. Not financial advice.**
