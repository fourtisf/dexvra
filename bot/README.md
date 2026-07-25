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
                    └─▶ X / Twitter                                     (optional, keyed)
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
| `src/twitter.js` | X posting (disabled unless keys present) |
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
6. **X (optional)**: paste the 4 `X_*` keys to enable auto-tweeting; leave blank
   to keep it off.
7. `npm run check` → `npm test` → `npm start`.
8. **Security**: rotate the bot token in @BotFather if it was ever shared, then
   update `.env`.

## Tests

```bash
npm run check   # boot-wiring smoke (no network)
npm test        # unit tests (pricing, units, chains, formatting, cards)
```

