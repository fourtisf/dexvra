# X (Twitter) auto-posting — setup

Every listing the bot produces is announced on **X** as well as Telegram, from
[@dexvralisting](https://x.com/dexvralisting).

This page is the whole setup: which keys, where they come from, where to put
them, and how to prove it works before you trust it.

---

## 1. The API keys the bot needs

**Four keys. All four. All from the same app.** They are the OAuth 1.0a set —
this is the only credential type that can post *on behalf of an account*.

| `.env` variable | X Developer Console name | Where |
|---|---|---|
| `X_API_KEY` | **Consumer Key** (shown as *API Key*) | Keys and tokens → OAuth 1.0 Keys |
| `X_API_KEY_SECRET` | **Consumer Secret** (shown as *API Key Secret*) | same row, tap the 👁 |
| `X_ACCESS_TOKEN` | **Access Token** | Keys and tokens → Access Token → **Generate** |
| `X_ACCESS_SECRET` | **Access Token Secret** | shown once, with the token above |

> **Read them once.** The Consumer Secret and both Access values are displayed a
> single time. If you closed the dialog, hit **Regenerate** and take the new pair
> — you cannot look an old secret up.

### What you do NOT need

Three things in that same console screen are *not* used by this bot. Pasting
them in place of the four above is the most common reason auto-posting silently
never starts:

| Not used | Why |
|---|---|
| **Bearer Token** | App-only auth — it can read, it cannot post as an account. |
| **OAuth 2.0 Client ID** | For the browser "Sign in with X" flow, not server posting. |
| **OAuth 2.0 Client Secret** | Same. |

### ⚠️ Permissions must be "Read and write" **before** you generate

The access token permanently carries whatever permission the app had **at the
moment it was generated**. A token minted while the app was Read-only stays
read-only forever, and every tweet fails with `403 Forbidden`.

1. App → **User authentication settings** → **Set up** / **Edit**
2. App permissions → **Read and write**
3. App type → **Web App, Automated App or Bot**
4. Callback URI + Website URL are required by the form — `https://dexvra.io` for
   both is fine; the bot never uses them.
5. **Save**, then go back to *Keys and tokens* and **Regenerate** the Access
   Token pair.

The `Access Token` row should read **`For @dexvralisting — Read and write`**. If
it says *Read only*, step 5 hasn't happened yet.

---

## 2. Put them in `.env`

On the server, in `bot/.env` (gitignored — never commit it, never paste these
values into a chat):

```dotenv
X_ENABLED=1
X_LISTING_HANDLE=dexvralisting

X_API_KEY=xxxxxxxxxxxxxxxxxxxxxx
X_API_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
X_ACCESS_TOKEN=1234567890123456789-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
X_ACCESS_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Leave the four blank and nothing breaks — the bot runs exactly as before and
simply never tweets. It says so once at boot, naming the missing variables.

### Optional second account

`X_O_API_KEY` / `X_O_API_KEY_SECRET` / `X_O_ACCESS_TOKEN` / `X_O_ACCESS_SECRET`
configure a **second** account used only for banner ads. Leave them blank for
the normal one-account setup — banner ads then go out from `@dexvralisting` too.

### Per-source switches (all default on)

| Variable | Turns off |
|---|---|
| `X_ENABLED=0` | every X post, keys or not |
| `X_AUTOLIST_ENABLED=0` | tweets for **free auto-listings** (paid ones still tweet) |
| `X_RANKUP_ENABLED=0` | rank-up alert tweets |
| `X_GAINERS_ENABLED=0` | the daily Top Gainers board tweet |
| `X_POST_TIMEOUT_MS` | (not a switch) how long a post waits for X — default 20000 |

---

## 3. Verify — before you trust it

```bash
cd bot
npm run x:check                 # masked key audit + does X accept them + which @handle
npm run x:check -- --preview    # print every X template with sample data + char count
npm run x:check -- --tweet      # publish a real test tweet, then delete it from the app
```

A green run ends with `✔ auto-posting is READY — every listing will be tweeted`.
Anything else exits non-zero and names the fix. Secrets are printed masked
(length + last 4), so the output is safe to screenshot.

The same check runs at boot and logs one line:

```
[start] X auto-posting ✔ posting as @dexvralisting
```

or, when something is wrong:

```
[start] X auto-posting is OFF — no listing will be tweeted. Missing in .env: X_ACCESS_TOKEN, X_ACCESS_SECRET…
```

---

## 4. What gets posted, and when

| Event | Tweet | Media | Quotes |
|---|---|---|---|
| Paid listing (Xpress) | `x_listing` | token logo | — |
| Paid listing (tiered) | `x_listing_tiered` | token logo | — |
| **Free auto-listing** | `x_listing` / `x_listing_tiered` | token logo | — |
| Trending activation | `x_trending` | token logo | — |
| Trending rank-up | `x_rankup` | — | the token's listing tweet |
| Pump alert | `x_pump` | — | the token's listing tweet |
| Banner ad | `x_banner` | advertiser creative | — |
| Daily Top Gainers | `x_gainers` | the rendered banner | — |

**Ordering matters.** The tweet is published *before* the Telegram post, so the
channel card can carry a live **"Announce On X"** link to it. The wait is
bounded by `X_POST_TIMEOUT_MS`; past that the Telegram post goes out without the
link and the tweet still lands (and is still recorded, so a later pump or
rank-up alert can quote it).

Nothing here can fail an order. Every X call is best-effort and returns `null`
instead of throwing — a dead X API costs you the tweet, never the sale.

### The first 7 days: no contract addresses

X refuses contract addresses from a **newly authenticated app** for its first
7 days (anti-spam, aimed at throwaway shill accounts). The listing cards carry a
`CA:` line, so they are refused during that window — as a `403`, confusingly the
same status as a read-only token.

The bot handles it: the tweet is **retried once with the `CA:` line removed**, so
the listing still reaches X with its ticker, price, market cap and token-page
link intact. The token page URL survives (X shortens every link to t.co, so it
isn't what the rule scans). Once the app passes 7 days, the full card — CA line
included — goes out again with no change on your side.

You'll see this in the log, and it is not an error to act on:

```
WARN [x] Crypto addresses are prohibited for the first 7 days… — this is X's new-app rule, NOT a key problem.
INFO [x] retrying without the contract address…
INFO [x] tweeted (listing) id=…
```

While the window is open the bot remembers it for up to an hour and posts the
CA-less card directly, so a Pay-Per-Use account isn't billed for a rejection on
every listing. The memory expires on purpose: the next post after it lapses
tries the FULL card again, and the first one that succeeds prints

```
INFO [x] contract addresses are accepted again — full listing cards resumed
```

and the CA line is back for good. No restart, no config, nothing to watch.

**Do not regenerate the access token during those 7 days** unless you have to —
the clock counts from when the app was authorised, so a fresh authorisation is
likely to restart it.

---

## 5. Editing the copy — no redeploy

All seven tweet templates live in **@dexvraadminbot → 📝 Templates → X Posts**
and take effect within ~30 seconds. Placeholders per template are listed in the
editor. Keep it under **280 characters** — a URL counts as 23 however long it
is, each emoji as 2. `npm run x:check -- --preview` prints the live count for
every template.

The channel-post templates carry the matching link lines:

- `[Announce On X 𝕏]({xUrl})` — the post's own tweet. The line **removes
  itself** when there is no tweet, so it is never a dead label.
- `𝕏 [X Alerts]({xlisting})` — Dexvra's X account, in the footer link row of
  every channel post.

`{xlisting}` resolves in **every** template, including ones that never passed it
explicitly — add it anywhere from the editor and it just works.

---

## 6. Troubleshooting

### Network egress

The server needs outbound HTTPS to **`api.x.com`** (posting) and
**`upload.twitter.com`** (media). Behind a firewall, a corporate proxy or a
container egress allowlist, X answers nothing — and the blocked request comes
back as a **403**, the same status X uses for a read-only token.

`npm run x:check` tells the two apart and will say
`could not reach api.x.com — the keys were NOT tested` rather than blaming your
credentials. If you see that, fix the network first; the keys may be perfect.

| Symptom | Cause | Fix |
|---|---|---|
| `could not reach api.x.com` | firewall / proxy / egress allowlist | allow `api.x.com` + `upload.twitter.com`; the keys were never tested |
| `Crypto addresses are prohibited for the first 7 days` | X's new-app rule — **nothing to fix** | the bot re-posts the same card without its `CA:` line; the full card returns by itself once the app is 7 days past authentication |
| `403` in `[x] tweet failed` | access token is read-only | set the app to *Read and write*, **regenerate** the token |
| `401` | the four keys aren't from one app, or were regenerated | copy all four again from the same app |
| `429` | X post cap for your tier/window | wait, or raise the tier — the bot retries on the next event |
| Boot says keys are missing but `.env` has them | the process is reading a different `.env` | the `[env] loaded …` boot line names the files actually read |
| Tweets go out from the wrong account | keys belong to another account | boot logs an explicit `X account MISMATCH` warning |
| Tweet has no image | free tier refuses v1 media upload | expected — it falls back to text-only automatically |
