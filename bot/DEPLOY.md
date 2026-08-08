# Deploying Dexvra (web internal API + Telegram bot)

The bot runs as its **own PM2 process** on the **same VPS** as the Dexvra Next.js
app (so it can reach the internal API on `127.0.0.1`). Two things ship together:

1. **Web app** — new `/api/internal/*` routes + trending-expiry + banner store
   (already on the branch). Needs `INTERNAL_API_TOKEN` + a rebuild/restart.
2. **Bot** — the new `bot/` process. Needs its `.env` + `npm install` + PM2.

Everything is on `main` once the working branch is merged. To deploy a feature
branch directly, check out that branch by name — `git branch -r` lists what
actually exists on the remote.

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

**Or deploy a branch directly** (check `git branch -r` for the name):
```bash
cd /path/to/dexvra
git fetch origin && git checkout <branch> && git pull
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

**First time on this box** there is no `dexvra` process to restart yet, and
`next start` binds **3000** while the bot polls **3005** (`DEXVRA_API_BASE`).
Nothing in Next reads a port from a config file, so set it on the process:

```bash
PORT=3005 pm2 start npm --name dexvra -- run start
pm2 save && pm2 startup      # pm2 startup makes it survive a reboot
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
npm run rpc:check         # do the chain RPC endpoints answer from THIS server?
npm test                  # unit tests
pm2 start ecosystem.config.js && pm2 save
pm2 logs dexvra-bot       # watch it come up
```

Minimum `.env` values:
```
BOT_TOKEN=<@BotFather token>
INTERNAL_API_TOKEN=<same value as the web app>   # >= 24 chars or the API 401s
BOT_USERNAME=<your bot's @handle, no @>          # NOT derived from BOT_TOKEN
DEXVRA_API_BASE=http://127.0.0.1:3005
SITE_URL=https://dexvra.io
ADMIN_IDS=<your numeric Telegram id>          # admins pay 0 → free end-to-end test
LOG_CHANNEL=<a private channel id>            # without it every failure below is invisible
ANNOUNCE_CHANNEL=@yourchannel                 # the defaults are the ORIGINAL operator's
TRENDING_CHANNEL=@yourtrending                #   channels — your bot is not admin there,
LISTING_CHANNEL=@yourlisting                  #   so posts fail with one WARN and no post
GROUP_CHAT=                                   # EMPTY turns the mirror off (omitting the
                                              #   line entirely gets @dexvragroup)
WALLET_ENC_KEY=<openssl rand -hex 32>          # encrypt stored temp-wallet keys
TREASURY_EVM=<0x… for eth/bsc/base/robinhood>
TREASURY_SOL=<solana address>
TREASURY_TRON=<tron address>
TREASURY_TON=<ton address>
```

> `BOT_USERNAME` is the one people miss. Nothing calls `getMe`, so the value is
> used verbatim to build the "➕ Add to your group" link and the `{bot}` mention
> in every template and channel post. Leave it at the default with a differently
> named bot and you are advertising somebody else's.
Leave a `TREASURY_*` blank to skip the sweep for that chain (funds then stay in
the per-order temp wallet under `.keys/`, recoverable — set them before real
volume). Leave the four `X_*` keys blank to keep X posting off; fill them in
and every listing is tweeted too — see [`X-AUTOPOST.md`](X-AUTOPOST.md), then
verify on the server with `npm run x:check`.

RPC endpoints are optional — every chain has keyless public defaults and a read
walks them until one answers. One **sweep** uses one node (whichever answered
its opening balance read) and never re-broadcasts to a second, so every url you
list must be a node you trust to *send*. Run `npm run rpc:check` on the server
and put a working (ideally paid) endpoint in `RPC_<CHAIN>`. Full credential
audit: [`KEYS.md`](KEYS.md).

## 5. Smoke-test end to end (free, no spend)

With your id in `ADMIN_IDS`, DM the bot `/start` → ⚡ Xpress Listing → pick a
chain → send a real contract address → Confirm. As an admin the amount is 0, so
it activates immediately: the listing should appear on the site and a post
should land in `@dexvralisting`.

## Update later

```bash
cd /path/to/dexvra && git pull
npm ci && npm run build && pm2 restart dexvra --update-env
cd bot && npm ci && pm2 restart ecosystem.config.js --update-env
```

> Restart via **`ecosystem.config.js`**, not `pm2 restart dexvra-bot`. This
> directory runs TWO processes — `dexvra-bot` (main.js) and `dexvra-adminbot`
> (adminbot.js) — and naming only the first leaves the admin bot on the old
> code after every deploy. It fails silently and confusingly: the main bot
> shows a new feature working while @dexvraadminbot has no editor entry for it,
> which reads as "the template is missing" rather than "that process is stale".
> Confirm both came back with `pm2 ls` before you call the deploy done.

## Rollback

```bash
pm2 stop dexvra-bot dexvra-adminbot   # bots only — the site keeps running
# revert web: git checkout <previous main commit> && npm ci && npm run build && pm2 restart dexvra
```

## Notes

- `.env`, `.keys/`, `data/` are gitignored — they live only on the server and
  survive `git pull`. Back up `.keys/` (temp-wallet keys) if any order hasn't
  swept yet.
- MongoDB/Redis are **not** required — the bot uses the web app's JSON store via
  the internal API and local JSON files for dedup/orders.
