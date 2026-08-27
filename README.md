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
| Prices, mcap, vol, liq, txns, logos, pair addresses, project links | **DexScreener** (primary) | one call per chain, per-period stats (5m/1h/6h/24h), no key |
| Same, when DexScreener is unreachable | GeckoTerminal free API | fallback only; also the sole source of the per-pool trades feed |
| Fear & Greed | alternative.me | free |
| Scanner — EVM | GoPlus Security API | free tier, no key |
| Scanner — Solana | RugCheck API | free tier |

Both market providers implement one interface (`LiveMarket` in
`src/lib/providers/market.ts`), so `providers/index.ts` merges either without
branching. All third-party data flows through the provider layer; the UI never
talks to providers directly. When every provider is unreachable the API falls
back to the seed listings and the boards show a **demo data** pill instead of
**live**.

### Charts — DexScreener

Token pages embed the DexScreener chart (`src/lib/dexscreener.ts` builds every
DexScreener URL; nothing else hardcodes one). The embed is keyed by pair
address, but DexScreener also resolves a bare token address to that token's top
pair — so a listing charts on its very first render, before the provider hands
back a pool. Only a chain DexScreener doesn't index (see
`dexscreenerChain` in `src/config/chains.ts`) falls back to the sparkline.

### Logos — every listing has one

There is no emoji fallback on the board any more. `src/lib/logo.ts` resolves a
token's logo through an ordered candidate list and `<TokenLogo>` walks it:

1. the admin-set logo (upload or pasted URL) — always wins;
2. the image DexScreener returns for the token;
3. DexScreener's deterministic logo CDN path, derived from chain + address;
4. a ticker monogram drawn on the token's gradient — no network needed, so a
   coin is filled even offline, while an image is still loading, or when every
   source 404s.

The monogram is the only fallback: a token never borrows an unrelated glyph.

## Chains

Config-driven in `src/config/chains.ts` — label, color, provider network ids
(`dexscreenerChain`, `geckoNetwork`), explorer + buy deeplinks
(Jupiter/Uniswap/Pancake/STON.fi), and address validation per chain. Adding a
chain is one entry there; nothing else hardcodes chain ids. Robinhood Chain has
no coverage on either provider (`dexscreenerChain: null`, `geckoNetwork: null`)
— its listings show the sparkline and a monogram until one indexes it.

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
