# Dexvra Telegram Bot

The Dexvra sales bot — sells and fulfils **Xpress Listing**, **Listing &
Trending** (Diamond → Bronze), **Trending** (3H–48H), and **Banner Ad**
packages. It verifies on-chain payment with a temp-wallet-per-order poll, writes
the resulting paid listing/booking into the Dexvra website (via its internal
API), and auto-posts to the Dexvra channels + X.

Runs as its **own process** (own `package.json`) alongside the Next.js web app.

## Architecture

```
Telegram user ──▶ bot (Telegraf, long-polling)
                    │  multi-step form → chain → PAYMENT (temp wallet + poll + sweep)
                    │
                    ├─▶ dexvra web app  POST /api/internal/listings   (approved listing)
                    │                   POST /api/internal/trending    (time-boxed slot)
                    │                   POST /api/internal/banners      (banner booking)
                    │                   POST /api/internal/upload       (logo/creative)
                    │      (Bearer INTERNAL_API_TOKEN — the web app stays the sole
                    │       writer of data/listings.json, no cross-process races)
                    │
                    ├─▶ @dexvralisting / @dexvraio / @dexvratrending   (Bot API posts)
                    └─▶ X @dexvralisting    every listing (paid + free auto),
                                            banner ads, and pump alerts quoting
                                            their listing tweet  (4 keys — see
                                            X-AUTOPOST.md; off until they're set)
```

Payment model (matches fourtisbot): the bot generates a **fresh receiving
wallet per order**, shows the address + amount, and on **Confirm** polls the
chain (~3s, up to 5 min) until the balance arrives, then **sweeps** to your
treasury and activates the purchase. Supported chains: Solana, BSC, Ethereum,
Base, Robinhood, Tron, TON.

> Security note: unlike the reference bot, temp-wallet private keys are stored
> **only** on disk under `.keys/` (AES-256-GCM encrypted when `WALLET_ENC_KEY`
> is set) — never dumped to a Telegram channel. Set treasury addresses so funds
> don't accumulate in temp wallets.

## Run

```bash
cd bot
cp .env.example .env      # fill in BOT_TOKEN + INTERNAL_API_TOKEN (+ treasuries)
npm install
npm run check             # boot-wiring smoke test (no network)
npm run x:check           # is X auto-posting configured + do the keys work?
npm start                 # node main.js (long-polling)
```

`INTERNAL_API_TOKEN` must equal the web app's value (see the root `README.md`).
The bot must be an **admin** in all three channels.

### Production (PM2, same VPS as the web app)

```bash
pm2 start main.js --name dexvra-bot --cwd /path/to/dexvra/bot
pm2 save
```

## Layout

| Path | Role |
|---|---|
| `main.js` | entry — dotenv, process guards, boot |
| `src/bot.js` | middleware chain, session, rate-limit, launch |
| `src/config/` | `chains.js` (registry), `constants.js` (env), `packages.js` (pricing mirror) |
| `src/api/dexvra.js` | internal-API client |
| `src/handlers/` | `start`, `listing`, `trending`, `banner`, `text`, `menu`, `registry` |
| `src/payments/` | temp-wallet gen, balance poll, sweep, confirm handler (per-chain adapters) |
| `src/channels/` | Bot-API channel posting + post formatters |
| `src/twitter.js` | X posting — every post type (disabled unless keys present) |
| `src/services/` | trending poster, trending sweeper, pump checker |

## Admin bot & editable templates

Every user-facing message **and** channel-post layout is an editable template
(`src/templates.js`, built-in defaults). `@dexvraadminbot` (a separate process,
`ADMIN_BOT_TOKEN`) lets admins edit them + upload the `/start` banner image at
runtime — the main bot auto-refreshes within ~30s, **no redeploy**.

- Overrides persist in `data/templates.json` (gitignored); banner in `data/banner`.
- Admins only (`ADMIN_IDS` / `ADMIN_USERNAMES`), private chat.
- Editable: Welcome, all prompts, payment card, success/error messages, and the
  Listing / Trending / Pump / Banner **channel-post layouts** (with
  `{placeholder}` substitution — the editor shows each template's placeholders).
- Run it: `pm2 start ecosystem.config.js` starts both `dexvra-bot` and
  `dexvra-adminbot`. Then DM `@dexvraadminbot` → `/start`.

See [`.env.example`](.env.example) for every setting.

## Premium (custom) emoji on the trending board

The pinned **Dexvra Trending** board renders its rank numbers 1️⃣–9️⃣ and the
Solana / BSC / Ethereum / Base / Tron / Plasma / Sui logos as **Telegram premium
custom emoji** — built in, no admin setup (`src/config/premiumEmoji.js`).

Two things have to be true for them to actually animate in the channel:

1. **A Telegram Premium USER account posts the board.** Regular bots cannot send
   custom emoji — Telegram strips them silently and viewers see only the plain
   fallback char. So the board goes out over GramJS/MTProto:
   `node scripts/gramjs-login.js` once on the server (needs `API_ID`/`API_HASH`
   from [my.telegram.org/apps](https://my.telegram.org/apps)), logged in with an
   account that **has Telegram Premium** and can post in `@dexvratrending`.
   Run it on its own — it asks for phone → code → 2FA one at a time, and the
   code arrives as a Telegram **message**, not an SMS. The script is quiet by
   default (`--verbose` for the full GramJS connection log): Telegram migrates
   the login to the account's home DC right after the code is requested, which
   times out GramJS's keep-alive ping and prints a scary
   `TIMEOUT` / `AUTH_KEY_UNREGISTERED (caused by users.GetUsers)` wall. That is
   harmless — the session simply isn't bound to a user until you enter the code
   — but it used to bury the prompt and made people ctrl-C a working login.
   It ends by telling you whether the account has Premium.
2. **The viewer's own client**: non-Premium viewers always see the fallback
   emoji. That is Telegram's behaviour, not a bug.

**Diagnosing "it's still plain unicode":** DM `@dexvraadminbot` → `/premium`
(or 🔥 Trending board → 💎 Premium status). It names the actual cause —
no session / revoked session / **account isn't Premium** / can't post in the
channel — instead of a generic "not connected".

Behaviour when premium isn't available: the board still publishes, just with the
fallback emoji, and it **upgrades itself** to premium on the next cycle once the
account is fixed (no restart, no duplicate board). If Telegram refuses the emoji
mid-flight the same message is re-sent without them over the same transport, so
the channel never ends up with two boards.

**Customising:** 🔥 Trending board in the admin bot — tap a rank or a chain and
send an emoji. Send a *premium* emoji and that slot becomes premium (it's stored
as `[fallback](emoji/<id>)`). A plain emoji that has a known premium twin is
promoted automatically (`PREMIUM_EMOJI_PROMOTE=0` to disable). Markers:
💎 premium · ✅ your plain emoji · ▫️ built-in default. "↩️ Restore premium
defaults" clears every override.

## Force post (see a post without waiting for the event)

Every channel post normally fires on a real event — a paid order, a rank change,
a pump — so checking a template or a freshly uploaded clip meant waiting for one.
`@dexvraadminbot` → **🚀 Force post to channel** publishes any type on demand:
Xpress listing · Listing + Trending · Trending · Rank-up · Pump · Banner ad.

It runs the production path (same template, same banner/clip, same layout) and
builds the post from your newest **approved** listing, so it carries a real logo,
price and links. It is a **public** post — the confirm screen names the exact
channels, and the result card links each message so you can delete a test.

The admin bot only *queues* the request (`data/forcepost/`); the **main** bot
publishes it within ~3 s. That split is deliberate: `@dexvraadminbot` isn't a
channel admin, and a second GramJS client on the same session would risk
`AUTH_KEY_DUPLICATED` and revoke the premium login. A request the main bot never
picks up **expires after 5 minutes** rather than surprising the channel later.

## Top Gainers banner (`@dexvraadminbot` → 📊 Banner Top Gainers)

Generates a premium banner of the **live 24h top movers** across every Dexvra
listing and posts it to a channel — the fourtis "gainers banner" idea, rebuilt
here with no designed JPGs and no Python: every pixel is drawn by
`src/gainersBanner.js` with `@napi-rs/canvas`.

**They are drawn as dexvra.io, not as a crypto flyer.** The banners use the site's
own design tokens (`helpers/canvasKit.js → SITE`, copied value-for-value from
`globals.css`): the `#090C12` page under its mint and violet blooms, `#101624`
cards with hairline borders, the real logo mark from `components/Logo.tsx`, the
site's two typefaces — **Space Grotesk** for display and **JetBrains Mono** for
every stat and wide-tracked micro-label — and the board's own change pill drawn
to the `.chg.up` spec. No glowing titles, no metallic medallions, no sparkles:
someone who knows the site should recognise the artwork before reading a word.

**Six layouts:**

| id | layout | slots |
|---|---|---|
| `hero1` | 👑 #1 Spotlight — one hero card, the move as the headline | 1 |
| `podium` | 🏆 Top 3 Podium — three tall cards, the winner raised | 3 |
| `cards4` | 🃏 Top 4 Cards — 2×2, identity left / the move right | 4 |
| `list5` | 📋 Top 5 List — the board itself, with real columns (the default) | 5 |
| `rail8` | 🎞 Top 8 Rail — two columns of four | 8 |
| `grid10` | 🔟 Top 10 Grid — two compact columns of five | 10 |

See them without a bot token: `node scripts/gainers-preview.js` writes all six to
`/tmp` from sample data (`--live` uses the real sources, `OUT_DIR=…` to redirect).

**The data is real, or there is no post.** `src/gainers.js` reads the site board
(`/api/tokens` — the exact rows dexvra.io shows) and keeps only rows marked
`source: "live"`, so the site's demo/seed listings (real addresses, frozen
figures) can never reach a channel. If the web process is unreachable it prices
the approved listings itself via `marketdata.fetchMarket`. A token with no live
24h change is **left off**, absurd pool percentages (>5000%) are dropped, and a
day where nothing qualifies posts **nothing** — with the reason shown in the
panel. The layout follows how many real gainers there are (three movers on the
Top-5 layout draws three rows, titled "TOP 3 GAINERS"), so a thin day never
publishes empty slots.

**In the panel:** pick a layout → preview the real artwork *and* the exact
caption → **📤 Post to channel**. Also there:

- **✏️ Swap a token** — replace any slot with a contract address / dexvra.io /
  DexScreener link. Its live 24h change is required, so a hand-picked slot can't
  become a made-up number; the re-render is labelled as no longer purely the live
  ranking.
- **📡 Check live data** — what each source returns and how many rows pass the
  filters, without rendering anything.
- **⚙️ Settings** — target channel, default layout + 🎲 random rotation, daily
  auto-post time & timezone, minimum gain %, minimum liquidity, date line, market
  cap in the caption, pin, and a custom **background artwork** upload.

The **caption is a template** like every other post — edit it under
📢 Channel Posts → *"Post: Top Gainers banner"*. Its `{list}` placeholder is the
ranked block, and each rank badge is the same one the trending board uses, so a
premium emoji set there animates here too.

**Daily auto-post is OFF until you turn it on** (a deploy must never start
posting to a public channel by itself). Once on, `services/gainersPoster.js`
posts once per local day at the configured `HH:MM`; the day is claimed *before*
the send, and released again if nothing was published, so a failure retries and a
success never double-posts.

Same two-process split as force post: the admin bot renders and queues
(`data/gainerspost/`), the **main** bot publishes within ~3 s. A job the main bot
never collects **expires after 10 minutes** — a stale leaderboard posted an hour
late is worse than no post.

## Go-live checklist

1. **Web app**: set `INTERNAL_API_TOKEN` (≥24 chars) in the Next app's `.env.local`
   and restart it (`pm2 restart dexvra --update-env`).
2. **Bot `.env`**: same `INTERNAL_API_TOKEN`; set `BOT_TOKEN`; point
   `DEXVRA_API_BASE` at the Next app (default `http://127.0.0.1:3005`).
3. **Treasuries**: set `TREASURY_EVM` / `TREASURY_SOL` / `TREASURY_TRON` /
   `TREASURY_TON` so funds sweep out of temp wallets. Set `WALLET_ENC_KEY`
   (`openssl rand -hex 32`) to encrypt stored keys at rest.
4. **Channels**: make the bot an **admin** in `@dexvraio`, `@dexvratrending`,
   `@dexvralisting`.
4b. **Premium emoji** (trending board): `node scripts/gramjs-login.js` with a
   **Telegram Premium** account that can post in those channels, then verify with
   `/premium` in `@dexvraadminbot`. Skipping this only costs the animation — the
   board still posts with plain fallback emoji.
5. **Admins**: add your Telegram id to `ADMIN_IDS` (admins pay 0 — use the free
   test order to verify listing → post end-to-end without spending).
6. **X auto-posting**: paste the 4 OAuth 1.0a keys — `X_API_KEY`,
   `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` — from
   console.x.com → your app → *Keys and tokens*, with app permissions set to
   **Read and write before** the access token is generated. Verify with
   `npm run x:check`. Full walkthrough + troubleshooting:
   [`X-AUTOPOST.md`](X-AUTOPOST.md). Leave the four blank to keep X off.
7. `npm run check` → `npm test` → `npm start`.
8. **Security**: rotate the bot token in @BotFather if it was ever shared, then
   update `.env`.

## Tests

```bash
npm run check   # boot-wiring smoke (no network)
npm test        # unit tests (pricing, units, chains, formatting, cards)
```

