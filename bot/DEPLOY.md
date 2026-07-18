# Deploying Dexvra (web internal API + Telegram bot)

The bot runs as its **own PM2 process** on the **same VPS** as the Dexvra Next.js
app (so it can reach the internal API on `127.0.0.1`). Two things ship together:

1. **Web app** — new `/api/internal/*` routes + trending-expiry + banner store
   (already on the branch). Needs `INTERNAL_API_TOKEN` + a rebuild/restart.
2. **Bot** — the new `bot/` process. Needs its `.env` + `npm install` + PM2.

Everything is on branch **`claude/hello-v3wb0n`**.

---

## 0. Prereqs (on the server)

- Node.js ≥ 18, `pm2` (`npm i -g pm2`)
- The Dexvra web app already deployed (e.g. PM2 name `dexvra`, port `3005`)
- The bot is an **admin** in `@dexvraio`, `@dexvratrending`, `@dexvralisting`

## 1. Generate the shared internal token (once)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use this **same value** for `INTERNAL_API_TOKEN` in BOTH the web `.env.local`
and the bot `.env`.

## 2. Get the code on the server

**If you merged to `main`** (recommended):
```bash
cd /path/to/dexvra
git fetch origin && git checkout main && git pull
```

**Or deploy the branch directly:**
```bash
cd /path/to/dexvra
git fetch origin && git checkout claude/hello-v3wb0n && git pull
```

## 3. Web app — enable the internal API

```bash
cd /path/to/dexvra
# add to .env.local (gitignored):
#   INTERNAL_API_TOKEN=<the value from step 1>
npm ci
npm run build
pm2 restart dexvra --update-env       # --update-env picks up the new token
```
Verify (should be 401 without the token, 200 with it):
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3005/api/internal/listings
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>" \
  http://127.0.0.1:3005/api/internal/listings
```

## 4. Bot — configure + start

```bash
cd /path/to/dexvra/bot
cp .env.example .env      # then edit .env (see below)
npm ci
npm run check             # boot-wiring smoke (no network)
npm test                  # unit tests
pm2 start ecosystem.config.js && pm2 save
pm2 logs dexvra-bot       # watch it come up
```

Minimum `.env` values:
```
BOT_TOKEN=<@BotFather token>
INTERNAL_API_TOKEN=<same value as the web app>
DEXVRA_API_BASE=http://127.0.0.1:3005
SITE_URL=https://dexvra.io
ADMIN_IDS=<your numeric Telegram id>          # admins pay 0 → free end-to-end test
WALLET_ENC_KEY=<openssl rand -hex 32>          # encrypt stored temp-wallet keys
TREASURY_EVM=<0x… for eth/bsc/base/robinhood>
TREASURY_SOL=<solana address>
TREASURY_TRON=<tron address>
TREASURY_TON=<ton address>
```
Leave a `TREASURY_*` blank to skip the sweep for that chain (funds then stay in
the per-order temp wallet under `.keys/`, recoverable — set them before real
volume). Leave the `X_*` keys blank to keep X posting off.

## 5. Smoke-test end to end (free, no spend)

With your id in `ADMIN_IDS`, DM the bot `/start` → ⚡ Xpress Listing → pick a
chain → send a real contract address → Confirm. As an admin the amount is 0, so
it activates immediately: the listing should appear on the site and a post
should land in `@dexvralisting`.

## Update later

```bash
cd /path/to/dexvra && git pull
npm ci && npm run build && pm2 restart dexvra --update-env
cd bot && npm ci && pm2 restart dexvra-bot --update-env
```

## Rollback

```bash
pm2 stop dexvra-bot          # bot only — the site keeps running
# revert web: git checkout <previous main commit> && npm ci && npm run build && pm2 restart dexvra
```

## Notes

- `.env`, `.keys/`, `data/` are gitignored — they live only on the server and
  survive `git pull`. Back up `.keys/` (temp-wallet keys) if any order hasn't
  swept yet.
- MongoDB/Redis are **not** required — the bot uses the web app's JSON store via
  the internal API and local JSON files for dedup/orders.
