# Dexvra — Multi-Chain Token Listing & Discovery

Phase 1 build of the token listing & discovery platform described in
[`docs/HANDOFF.md`](docs/HANDOFF.md). The UI/UX source of truth is the
prototype at [`docs/prototype/fourtis-discovery.html`](docs/prototype/fourtis-discovery.html) —
open it in a browser and click around before touching the code.

## Status

- **Phase 1 (this)** — read-only discovery: all 14 views, live market data with
  seed-data fallback, PWA install. ✅
- **Pons v2 / Robinhood Chain** — on-chain market data, trades and safety
  flags for the one chain no aggregator indexes. ✅
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
| Robinhood Chain market data + safety | **Pons v2 launchpad, read on-chain** | see below — no aggregator indexes chain 4663 |
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
explorer + buy deeplinks (Jupiter/Uniswap/Pancake/STON.fi/Pons), and address
validation per chain. Adding a chain is one entry there; nothing else
hardcodes chain ids. A chain with no aggregator coverage sets
`geckoNetwork: null` and names its `launchpad` instead — Robinhood Chain does
exactly that and is served by the Pons v2 provider below.

## Pons API v2 (Robinhood Chain)

Robinhood Chain (EVM L2, chain id 4663) is not indexed by GeckoTerminal,
DexScreener or GoPlus, and [Pons](https://ponsfamily.com) — the launchpad
essentially every token on it launches through — publishes no HTTP API: its
`PonsV2LaunchFactory` and the per-launch bonding curves are the source of
truth. So `src/lib/providers/pons/` reads them directly over JSON-RPC and
returns the same normalised shape every other provider does, which is why
nothing above the provider layer knows the difference.

What it reads, per listed token:

| Stage | Source | Gives us |
|---|---|---|
| Any | `getLaunchedToken(token)` on the factory | curve address, quote asset, graduation phase, creator tax, buyback flag |
| On curve | `PonsV2BondingCurve` reserves | marginal price (`quoteReserve / tokenReserve`), real quote backing, curve progress |
| Graduated | the locked Uniswap V4 pool, via `PoolManager.extsload` | `sqrtPriceX96` price and full-range depth |
| Any | `CurveBuy` / `CurveSell` logs | trades, per-period volume, txn split and price change |

Notes a reviewer should know:

- **No dependencies.** keccak-256, the ABI codec and the JSON-RPC client are
  in `src/lib/evm/` (~300 lines) rather than pulling in ethers/viem, keeping
  the app's runtime dependency set at next + react. They're covered by known
  vectors in the test below.
- **The trade window fills incrementally.** There is no indexer to ask, so
  each refresh spends a bounded number of `eth_getLogs` calls catching up to
  the head and reaching further back. A market reports
  `statsCoverageMinutes`, and `providers/index.ts` keeps the listing's own
  figure for any period longer than that — a cold start never publishes a
  partial "24h" as if it were complete.
- **It degrades, it doesn't guess.** A launch quoted in an ERC-20 rather than
  native ETH gets no USD figures (no reference price); a pool slot that reads
  back zero is dropped rather than priced; an unreachable RPC is an error, not
  a "not a Pons launch".
- **Scanner.** `/api/scan` falls back to Pons for EVM addresses GoPlus can't
  place, and reports contract facts — fixed supply minted to the curve, no
  deployer privileges, permanently locked graduated liquidity, creator tax,
  curve progress — instead of heuristics.
- **API.** `GET /api/pons?address=0x…` returns the full launch record:
  phase, curve progress, threshold, price, market cap, liquidity and whether
  the position is permanently locked.

```bash
npm run test:pons   # offline: fake JSON-RPC node, no network required
```

The brand name is a placeholder: change it once in `src/config/brand.ts`.

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
npm run gen:icons  # regenerate all brand assets (favicons, logo, OG) from the SVG mark
npm run test:pons  # offline unit tests for the Pons v2 provider
```

## Environment (later phases)

Phase 1 needs no env vars. Phases 2/3 add: `DATABASE_URL`, `REDIS_URL`,
`TREASURY_WALLET`, `HELIUS_KEY`, `GOPLUS_KEY`, `TELEGRAM_BOT_TOKEN`,
`ADMIN_WALLETS` (see handoff §9).

The Pons provider works with no configuration on the public RPC, which is
rate-limited and carries no SLA. Point it at a dedicated endpoint for
production:

| Var | Default | Purpose |
|---|---|---|
| `PONS_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | Robinhood Chain JSON-RPC |
| `PONS_FACTORY` | `0x7eD598…1EC7e` | `PonsV2LaunchFactory` address |
| `PONS_EXPLORER` | `https://robinhoodchain.blockscout.com` | explorer links |
| `PONS_APP` | `https://ponsfamily.com` | Buy / curve deeplinks |
| `PONS_LOG_CHUNK_BLOCKS` | `10000` | max block span per `eth_getLogs` |
| `PONS_LOG_CHUNKS_PER_REFRESH` | `6` | log requests per curve per refresh |
| `PONS_HISTORY_MINUTES` | `1440` | trade window kept and backfilled towards |
| `PONS_BLOCK_SECONDS` | `0.25` | fallback block time (measured at runtime) |
| `PONS_RPC_TIMEOUT_MS` | `9000` | per-request timeout |

A faster RPC wants a bigger `PONS_LOG_CHUNK_BLOCKS` and more chunks per
refresh — that's the one knob that decides how quickly a cold start reaches
full 24h coverage.
