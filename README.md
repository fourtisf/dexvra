# Dexvra — Multi-Chain Token Listing & Discovery

Phase 1 build of the token listing & discovery platform described in
[`docs/HANDOFF.md`](docs/HANDOFF.md). The UI/UX source of truth is the
prototype at [`docs/prototype/fourtis-discovery.html`](docs/prototype/fourtis-discovery.html) —
open it in a browser and click around before touching the code.

## Status

- **Phase 1 (this)** — read-only discovery: all 14 views, live market data with
  seed-data fallback, PWA install. ✅
- **Phase 2** — wallet auth (SIWS), persistent watchlist, Telegram alerts. ⏳
- **Phase 3** — paid listings, verification, ad bookings, admin panel. ⏳

## Stack

- **Next.js 14 (App Router) + TypeScript.** Styling is the prototype's CSS
  ported verbatim to `src/app/globals.css` (design tokens in `:root`) rather
  than a Tailwind rewrite — this keeps the UI pixel-identical to the
  prototype, which the handoff makes the hard requirement. Swapping to
  Tailwind later is possible but cosmetic.
- **No database yet** — Phase 1 is read-only. Watchlist/alerts/listings live in
  `localStorage` (same as the prototype's in-memory state) and move to
  Postgres in Phase 2/3 per the handoff's Prisma sketch.
- **Cache** — in-memory TTL cache behind a small interface
  (`src/lib/cache.ts`); swap in Redis (Upstash) by implementing `KVCache`.

## Data providers (`src/lib/providers/`)

| Need | Provider | Notes |
|---|---|---|
| Prices, mcap, vol, liq, txns, new pairs | GeckoTerminal free API | per-period stats (5m/1h/6h/24h), no key needed |
| Robinhood Chain launches | [pools.trade](https://pools.trade) | the launchpad itself — see below |
| Fear & Greed | alternative.me | free |
| Scanner — EVM | GoPlus Security API | free tier, no key |
| Scanner — Solana | RugCheck API | free tier |

All third-party data flows through the provider layer; the UI never talks to
providers directly, so swapping DexScreener/Birdeye/Helius in later touches
nothing outside `src/lib/providers/`. When every provider is unreachable the
API falls back to the prototype's 20 seed tokens and the boards show a
**demo data** pill instead of **live**.

## pools.trade — Robinhood Chain launches

[pools.trade](https://pools.trade) is the launchpad Robinhood Chain tokens
launch on. It is integrated in all three packages because it closes a hole the
other providers structurally cannot:

- **DexScreener does not index Robinhood Chain at all.** Auto-listing discovery
  runs on DexScreener, so Robinhood tokens were invisible to it — a fully
  supported chain (listing packages, trade engine, bonding-curve path) that
  could never be auto-discovered.
- **GeckoTerminal only knows a token once it has a liquidity pool.** A launch
  still on its bonding curve has none, so a freshly listed Robinhood token
  rendered with the figures captured at listing time until it graduated.

| Where | File | What it does |
|---|---|---|
| Web | `src/lib/providers/poolstrade.ts` | fills live figures for listings GeckoTerminal returns nothing for; GT still wins wherever it answers |
| Web | `src/app/api/launches/route.ts` | `GET /api/launches?limit=50&bonding=1` — the public tracking feed |
| Listing bot | `bot/src/poolstrade.js` + `bot/src/discovery.js` | auto-listing discovery and listing-form autofill now see Robinhood tokens |
| Trade bot | `tradebot/poolstrade.js` | the launchpad record behind a token's trade card (socials, volume, launch time, curve progress) |

**It never touches the money path.** A buy or sell is priced, routed and signed
entirely from chain state in `tradebot/core.js` — the bonding-curve contract
while a token is on the curve, the V2/V3 router once it has graduated. pools.trade
supplies display metadata only, and two tests in `tradebot/poolstrade.test.js`
assert that `core.js` neither imports the module nor reads its graduation flag.
That split is what lets this integration be relaxed about a schema we do not
control: a wrong or stale response can make a card show a stale market cap; it
cannot change what a trade does.

### Verifying the endpoint

pools.trade indexes through Uniswap's launches API, and **that request shape is
not published as a stable public contract** — the defaults below are our best
reading of it and were not verified against the live API. So every part of the
request is an env var, and the parser accepts many spellings of each field.
Check it against the real thing before relying on it:

```bash
cd bot && npm run poolstrade:check
```

It makes one read-only request and prints what came back, per-field coverage,
and exactly which env var to set if anything did not parse. `✅ every field
parsed` means no configuration is needed.

| Var | Default | Purpose |
|---|---|---|
| `POOLS_TRADE_ENABLED` | `1` | `0` disables it everywhere (fail-open, no other effect) |
| `POOLS_TRADE_API` | `https://interface.gateway.uniswap.org/v2` | base URL |
| `POOLS_TRADE_LIST_PATH` | `data.v2.DataApiService/ListLaunches` | RPC path |
| `POOLS_TRADE_BODY` | *(built from the vars below)* | whole request body as JSON, when the default shape is wrong |
| `POOLS_TRADE_CHAIN_ID` | `4663` | Robinhood Chain |
| `POOLS_TRADE_CONTRACTS` | `uniswap-cca,uniswap-bonding-curve` | launchpad contracts to list |
| `POOLS_TRADE_LIST_KEY` | `launches,tokens,items,data,…` | response key holding the rows (first match wins) |
| `POOLS_TRADE_PAGE_SIZE` / `POOLS_TRADE_MAX_PAGES` | `100` / `3` | pagination |
| `POOLS_TRADE_CACHE_MS` | `60000` | one scan costs one round trip, not one per candidate |
| `POOLS_TRADE_OUR_CHAIN` | `robinhood` | our chain id for everything it returns |

Set them in the web's `.env.local`, the bot's `.env` and the trade bot's `.env`
— each package reads its own. Every one is optional; unset means the default.

## Chains

Config-driven in `src/config/chains.ts` — label, color, provider network ids,
explorer + buy deeplinks (Jupiter/Uniswap/Pancake/STON.fi), and address
validation per chain. Adding a chain is one entry there; nothing else
hardcodes chain ids. Robinhood Chain currently has no market-data provider
coverage (`geckoNetwork: null`) — its tokens appear once paid listings exist.

The brand name is a placeholder: change it once in `src/config/brand.ts`.

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
npm run gen:icons  # regenerate all brand assets (favicons, logo, OG) from the SVG mark
```

## Environment (later phases)

Phase 1 needs no env vars. Phases 2/3 add: `DATABASE_URL`, `REDIS_URL`,
`TREASURY_WALLET`, `HELIUS_KEY`, `GOPLUS_KEY`, `TELEGRAM_BOT_TOKEN`,
`ADMIN_WALLETS` (see handoff §9).

## Telegram bot integration (`bot/`)

The Dexvra Telegram bot (`bot/`, its own package — see [`bot/README.md`](bot/README.md))
sells Listing / Xpress / Trending / Banner packages, verifies on-chain payment
(temp wallet + poll + sweep), and auto-posts to the Dexvra channels **and X**.

**X auto-posting** — every listing (paid *and* free auto-listing), plus banner
ads and pump alerts, is tweeted from
[@dexvralisting](https://x.com/dexvralisting). Trending Token, the Top Gainers
board and rank-up alerts are deliberately excluded — only listings, and
follow-ups to listings, belong on a listing feed. It needs four OAuth
1.0a keys (`X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`)
in the bot's `.env`; leave them blank and X posting stays off with no other
effect. Setup, verification (`npm run x:check`) and troubleshooting:
[`bot/X-AUTOPOST.md`](bot/X-AUTOPOST.md).
It writes approved listings and trending/banner bookings back through a
token-guarded **internal API** (`/api/internal/*`) so the Next.js process stays
the sole writer of `data/listings.json`.

Set `INTERNAL_API_TOKEN` (a shared secret, **≥ 24 chars**) in `.env.local`; the
bot's `.env` gets the same value. Until it's set, every `/api/internal/*` route
returns 401 (fails closed). Generate one with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Trade bot (`tradebot/`)

The **Dexvra Trade Bot** (`tradebot/`, its own package — see
[`tradebot/README.md`](tradebot/README.md)) is the custodial, Maestro-style,
multi-chain Telegram trading bot migrated from the Robinfun repo: one-tap
buy/sell by contract address on Robinhood Chain / Ethereum / Base / BNB /
Arbitrum / Solana, snipe, copy-trading, TP/SL/limit/DCA orders, referrals, and
visitor + trade ops-reporting to a private admin channel (`report.js`,
`REPORT_CHANNEL_ID`). It is a **separate Telegram bot and process** from
`bot/` (its own token via `TRADEBOT_TOKEN`, its own `data/` store) — run it
with `cd tradebot && npm install && npm start`.

## Durable storage — MongoDB (optional)

Both the web app and the bot persist to local JSON files under `data/` by
default. Set **`MONGO_URI`** (in the web's `.env.local` **and** the bot's `.env`,
pointing at the **same** database) to mirror that state into MongoDB, so it
survives a VPS reset / container replace and the site + bot share one store:

- **Web** (`src/lib/mongo.ts`) mirrors `listings` and `banners` into a `web`
  collection; on a fresh container with no local file, the store restores from
  the mirror.
- **Bot** (`bot/src/db/mongo.js`) mirrors every JSON store (the /start audience,
  orders, templates, group + banner config, dedup latches) into a `kv`
  collection and restores missing files at boot.

Fail-open: unset or unreachable → both fall back to local files (no outage).
Optional `MONGO_DB` overrides the database name (default: from the URI).
