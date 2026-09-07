# Dexvra Admin Panel — setup

The admin panel is served **only** on `dexvra.fun`, under a secret path, and is
protected by a username + password. It is invisible on the public site
(`dexvra.io`).

## 1. Generate secrets (on the VPS, in the app folder)

```bash
node scripts/gen-admin-secrets.mjs <username> '<password>'
```

Copy the printed block into `.env.local` (this file is gitignored):

```
ADMIN_USER=youradmin
ADMIN_PASS_HASH=scrypt:<32 hex>:<64 hex>
ADMIN_SESSION_SECRET=<64 hex chars>
ADMIN_PATH=admin-<32 hex chars>
ADMIN_HOSTS=dexvra.fun,www.dexvra.fun
```

The script prints your admin URL, e.g. `https://dexvra.fun/admin-<hash>`.
Keep `ADMIN_PATH` and the password private — the URL is the first line of
defense, the login is the second.

## 2. Point dexvra.fun at the app

Both `dexvra.io` (public) and `dexvra.fun` (admin) proxy to the same Next.js
app on port 3005. In your nginx server block for `dexvra.fun`:

```nginx
server {
    server_name dexvra.fun www.dexvra.fun;
    location / {
        proxy_pass http://127.0.0.1:3005;
        proxy_set_header Host $host;                 # required — the app checks the host
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    # (certbot adds the listen 443 / ssl_certificate lines)
}
```

Then issue a certificate:

```bash
sudo certbot --nginx -d dexvra.fun -d www.dexvra.fun
```

`proxy_set_header Host $host` is essential — the app decides admin-vs-public by
the `Host` header. `proxy_set_header X-Real-IP $remote_addr` is also required —
the login/submit rate limiters key on it (they deliberately ignore the
client-forgeable leftmost `X-Forwarded-For` hop).

## 3. Restart

```bash
pm2 restart dexvra --update-env    # --update-env picks up the new .env.local
```

Open `https://dexvra.fun/<ADMIN_PATH>` → log in.

## What the panel does

- **Pending submissions** — tokens submitted via the public "List Token" form
  land here; Approve puts them live, Reject hides them.
- **All listings** — change a token's tier (Diamond…Bronze/Xpress), toggle its
  Trending feature, unlist, or delete.
- **Pons launches · Robinhood** — tokens the Pons v2 factory has just launched,
  read straight off chain. Nothing here is listed yet; pick a tier and press
  **List it** to promote one, and the row is filled in from on-chain data
  (ticker, name, logo, price, market cap, creator tax). Dexvra stays
  paid-listing only — this only removes the copy-paste.
- **Add listing** — add a token directly (goes live immediately). Live market
  data (price, chart, trades) is fetched by contract address automatically.

Listings persist in `data/listings.json` (gitignored, survives restarts and
`git pull`). Public changes propagate within ~30s (the market cache TTL).

## Telegram listing bot (optional)

Posts every new Pons launch, and every listing that goes LIVE, to a channel.
Leave the variables unset and the whole thing stays a no-op.

Add to `.env.local`:

```
TELEGRAM_BOT_TOKEN=123456:ABC…      # from @BotFather
TELEGRAM_CHAT_ID=@yourchannel       # or -100… for a private channel
CRON_SECRET=<64 hex chars>          # openssl rand -hex 32
SITE_URL=https://dexvra.io          # used in the "View on Dexvra" link
```

Add the bot to the channel as an **administrator** (Telegram won't let it post
otherwise). LIVE announcements fire straight from the admin panel; new launches
need the heartbeat on a schedule:

```bash
crontab -e
# every 10 minutes
*/10 * * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://dexvra.io/api/cron/pons >/dev/null
```

(On Vercel, a `crons` entry in `vercel.json` pointing at `/api/cron/pons` works
the same way — Vercel sends `Authorization: Bearer $CRON_SECRET` for you.)

The first run adopts the current head **without posting**, so wiring up the bot
never dumps the backlog into the channel. After that it posts at most
`PONS_BOT_MAX_POSTS` (default 8) per run, oldest first, and never repeats a
launch or a listing — the markers live in `data/notify.json`.

Check it by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://dexvra.io/api/cron/pons
# {"ok":true,"posted":0,"initialized":true,...}   ← first run
# {"ok":true,"posted":2,"pending":0}              ← afterwards
```

## Notes on security

- Session is an HttpOnly, SameSite=Strict, Secure (in prod) signed cookie
  (HMAC-SHA256, 8h expiry). No session = no access.
- Login is rate-limited (6 tries / 15 min per IP).
- `/panel` and `/api/admin/*` return 404 on the public domain, and 404 if the
  secret path isn't used on the admin domain.
- `/api/cron/pons` returns 503 until `CRON_SECRET` is set, and 401 without it —
  it is never callable anonymously.
- Never commit `.env.local` or `data/`.
