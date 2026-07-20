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
| Fear & Greed | alternative.me | free |
| Scanner — EVM | GoPlus Security API | free tier, no key |
| Scanner — Solana | RugCheck API | free tier |

All third-party data flows through the provider layer; the UI never talks to
providers directly, so swapping DexScreener/Birdeye/Helius in later touches
nothing outside `src/lib/providers/`. When every provider is unreachable the
API falls back to the prototype's 20 seed tokens and the boards show a
**demo data** pill instead of **live**.

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
(temp wallet + poll + sweep), and auto-posts to the Dexvra channels + Twitter.
It writes approved listings and trending/banner bookings back through a
token-guarded **internal API** (`/api/internal/*`) so the Next.js process stays
the sole writer of `data/listings.json`.

Set `INTERNAL_API_TOKEN` (a shared secret, **≥ 24 chars**) in `.env.local`; the
bot's `.env` gets the same value. Until it's set, every `/api/internal/*` route
returns 401 (fails closed). Generate one with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

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
