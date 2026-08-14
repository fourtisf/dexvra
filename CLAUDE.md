# Dexvra — working notes

## Repo layout

| Path | What it is | Runs as |
| --- | --- | --- |
| `src/`, root `package.json` | Next.js 14 web app (dexvra.io) | PM2 `dexvra`, port 3005 |
| `bot/` | Telegram bot — listings, trending, banners, group buy bot, raids | PM2 `dexvra-bot` **and** `dexvra-adminbot` |
| `tradebot/` | The trade bot, a separate process in the same repo | its own PM2 process |

Production server: the repo is checked out at **`/opt/dexvra`**. Never write
`/path/to/dexvra` in an instruction — it has been pasted literally into a live
shell before.

## Release flow — `main` is what the server runs

**Every change ends up on `main`, and the server only ever deploys `main`.**
Feature branches exist to build and review on; they are never the thing a
server checks out.

1. Build on a branch (`claude/<topic>`), commit there.
2. Run the full suite for whatever you touched — **it must be green before the
   merge, not after**:
   ```bash
   cd bot && npm test          # bot/       (~930 tests)
   npm test                    # web app, from the repo root
   cd tradebot && npm test     # tradebot/
   ```
3. Merge into `main` and push `main`.
4. Deploy on the server **from `main`** — see [`bot/DEPLOY.md`](bot/DEPLOY.md).
5. **Verify what is running before believing anything about it.** Every process
   prints its commit at boot.

A branch left unmerged after it is deployed is the failure mode this rule
exists to prevent: the server sits on a branch, the next change is cut from
`main`, and the two silently diverge.

If a pull request for a branch has already been merged, do not add commits to
that branch — restart it from the current `main` and open a new one.

### The whole deploy, all four processes

```bash
cd /opt/dexvra && git checkout main && git pull origin main
cd /opt/dexvra/bot && pm2 restart ecosystem.config.js --update-env   # dexvra-bot + dexvra-adminbot
pm2 restart dexvra-tradebot --update-env                             # tradebot/ — its OWN process
# web app (only if src/ or the repo root changed):
cd /opt/dexvra && npm run build && pm2 restart dexvra
pm2 ls
```

### Step 5 is not optional

```bash
pm2 logs dexvra-bot      --lines 50 --nostream | grep '\[boot\] build'
pm2 logs dexvra-tradebot --lines 50 --nostream | grep '\[boot\]'
```

The sha printed must equal `git rev-parse --short HEAD`. A `+dirty` suffix means
the checkout has uncommitted changes and is **not** what `main` says it is.

This exists because a pull that never reached the server and a change that did
not work are indistinguishable from Telegram, and an evening was spent debugging
the first while assuming the second. Do not report a fix as deployed, and do not
start diagnosing why one "did not work", until the sha matches.

## A third party will move, and it must not cost a user money

Three outages in two days, all one shape: Jupiter retired
`quote-api.jup.ag/v6` and every Solana buy died with the word `fetch failed`,
five wallets at a time, under a green ✅ receipt. pump.fun moved to
`frontend-api-v3` and snipe discovery went blind while `/health` printed 🟢.
Then `/swap` began failing on a base whose `/quote` answered fine.

Each was found by a human typing `npm run preflight:solana` **after** a user
complained. So the rules below are not style — every one of them is an outage
that already happened.

- **Never one hardcoded host.** A base LIST, current first, legacy kept so a
  rollover in either direction needs no deploy. `<THING>_API` env pins one host
  and skips discovery — an override *and* a skip, the contract
  `<CHAIN>_V4_POOLMANAGER` already has. `solana.js` `JUP_BASES` / `_overBases`
  is the reference; copy it, do not write a fourth private idea of failure.
- **Fail over on a TRANSPORT error only.** An HTTP status means the host is
  there and answered; the same request gets the same status everywhere else, so
  retrying it just doubles the latency of a request that was always going to
  fail.
- **Never discard the reason.** undici's `fetch failed` puts the syscall code in
  `err.cause`; an HTTP error puts the explanation in the response body. Both were
  being thrown away, and both cost a round of guessing —
  `Jupiter swap-build failed (500)` was true, useless, and hiding
  *"Token account … is owned by … instead of the user"*. `netErr()` and
  `jupWhy()` exist for this.
- **"It answered with nothing" and "it did not answer" are different facts.**
  `pumpfunNew` returned `[]` for both, so a 403, a 429, a dead host and a quiet
  launchpad were indistinguishable. Return `{ items, ok, why }` — `pumpfunNewX`
  and `core.dsPairsX` are the shape.
- **A loop that RAN is not a loop that WORKS.** The Solana snipe's early
  `return` on an empty feed counted as a successful tick, so a feed dead for days
  rendered a green tick — the state that looks most like a healthy one.
  `lastFeedOkAt` (the feed answered) and `lastLaunchAt` (it had something) are
  both needed; one alone lies.
- **Moving a base is not moving an API.** The host failover was right and still
  left `prioritizationFeeLamports: 'auto'` — v6's spelling — going to a v1
  endpoint. The query path happened to be identical; the POST body was not.
- **Probe with a fresh address, never a shared one.** The preflight built its
  swap for the address derived from the standard BIP39 test mnemonic; a stranger
  had created a token account under a foreign owner, Jupiter rightly refused, and
  the operator was told not to trade. `Keypair.generate()` has no history.

### The watchdog is the point

`upstreams.js` holds the probe list, and **both** the preflight script and the
running bot use it — two copies of "is Jupiter up" would eventually disagree,
which is exactly what two pump.fun hosts in two processes already cost.

It sweeps every `UPSTREAM_CHECK_MS` (default 10 min) and posts to the ops
channel **on the transition only** — a broken upstream posting every sweep is a
channel nobody reads by the second hour. **A recovery is an alert too**, or the
operator cannot tell a fixed outage from a forgotten one. A bot that boots
*into* an outage reports it on the first sweep, because the transition it would
otherwise wait for already happened while it was down.

`UPSTREAM_CHECK=0` disables it; the floor on the interval is 60s.

When adding a probe: say what the USER loses (`costs`), not which host is down.
"lite-api.jup.ag ENOTFOUND" does not tell an operator whether to stop the bot or
finish dinner. Mark `critical` only when users cannot trade — an alert where
everything is critical has no priority in it.

```bash
cd tradebot && npm run preflight:solana    # the same probes, on demand
```

### Config a fix depends on

A code change that needs a new `.env` value is not finished when it is merged —
it is finished when the value is set. Say so explicitly, with the exact variable
name, and expect the behaviour to be unchanged until then. `data/`, `.env` and
`.keys/` live only on the server, so nothing here can set them.

Uniswap v4 used to be the standing example of this and no longer is. It needed
`<CHAIN>_V4_POOLMANAGER` to price and `<CHAIN>_V4_UNIVERSAL_ROUTER` +
`<CHAIN>_V4_PERMIT2` to trade, and until an operator pasted all three a live
pool read as "Dexvra can't route through that yet". `tradebot/v4.js` now
observes all of it from the chain's own logs — the PoolManager from the pool's
Initialize log, the router from the senders of that manager's Swap logs, Permit2
from its deterministic address (verified by `getCode`) — and caches it per
chain. The env vars still exist and still win when set; they are an override and
a discovery skip, not a prerequisite. `<CHAIN>_V4_AUTODISCOVER=0` pins a chain
to env alone.

## Two bot processes, one config

`bot/` runs **two** PM2 processes: `dexvra-bot` (`main.js`) and
`dexvra-adminbot` (`adminbot.js`). Always restart via the ecosystem file:

```bash
cd /opt/dexvra/bot && pm2 restart ecosystem.config.js --update-env && pm2 ls
```

`pm2 restart dexvra-bot` leaves the admin bot on the old code. It fails
silently and confusingly — the main bot shows a new feature working while
@dexvraadminbot has no menu entry for it, which reads as "the feature is
missing" rather than "that process is stale". Confirm both are `online`.

## Admin-editable templates beat code defaults

`bot/src/templates.js` holds a built-in default for every message; anything an
admin saved in @dexvraadminbot lives in `data/templates.json` and **wins**.
So changing a default in code does nothing on a box where that template was
edited. Say so when shipping copy changes: the operator has to hit
**♻️ Reset default** on that template to pick the new copy up.

The same applies to `data/` generally — it is gitignored, lives only on the
server, and survives `git pull`. So do `.env` and `.keys/`.

## What does not need a web rebuild

If a change touches only `bot/`, there is no `npm run build` and no
`pm2 restart dexvra`. Check before telling anyone to rebuild:

```bash
git diff --name-only <base>..HEAD | grep -v '^bot/'
```

Empty output means bot-only.

## The raid reads X by default — and an explicit `0` still wins

"bisa baca like rt komen dan updated realtime" (2026-08-12). The reading code
was already complete — `bot/src/raid/` has the paid API, the guest GraphQL
source and the embed source, tried in that order. **Nothing was missing and
nothing needed cloning.** What was wrong is that all three shipped OFF:
`X_BEARER_TOKEN` blank, `RAID_FREE_METRICS=0`, `RAID_GUEST_METRICS=0`. So
`xMetrics.anySource()` was false on a stock box, every raid launched crew-only,
and the like/reply/repost numbers could never move. From inside Telegram that
is indistinguishable from a broken feature: the goals are on the card and the
counts sit still.

- **`bot/src/raid/sourceFlag.js` is the single owner** of "is this keyless
  source on?". Absent or blank → ON. `RAID_FREE_METRICS=0` / `=false` / `=off`
  → OFF, and that must stay expressible: both modules carry real warnings (X
  blocks datacenter IPs hardest; the embed source's reply count is the whole
  CONVERSATION, so it can disagree with the number X prints on the post).
- **Blank ≠ false here**, deliberately, unlike `bool()` in
  `src/config/constants.js`. A `.env` carrying a bare `RAID_GUEST_METRICS=` is
  "never decided", not "refused".
- ⚠️ **A server whose `.env` was copied from the old template still says `=0`,
  and that wins.** The default change alone does nothing there — set both to
  `1` (or delete the lines) and restart with `--update-env`. This is the
  "config a fix depends on" rule above, and it is the single most likely reason
  the counts still look frozen after a deploy.
- **The two keyless sources are NOT independent fallbacks.** Both are gated by
  X's IP reputation, so a datacenter block takes them out together. Only the
  paid token (metered per app, not per IP) and the 🤝 Crew goal (zero X
  requests) are genuinely independent. The fallback chain reads more reassuring
  than it is.

**Realtime is `RAID_MOVE_BUMP_SEC`, now 0** (floor 0, was 60 with a floor of
20). When a like/reply/repost/crew join lands, the card is re-posted on the
NEXT poll instead of being edited in place — **an in-place edit notifies
nobody**, so from anywhere in the chat except directly on the card, a raid
that is progressing looked exactly like one that had stalled. Zero is safe
because the flood bound is `RAID_POLL_SEC`: a bump can only happen inside a
tick, and a tick that saw nothing move sends nothing. Chatter is a different
event and keeps its full `RAID_BUMP_MINUTES`.

**X rotates its GraphQL hash, so the seed is expected to be stale.**
`xGuest.js` resolves the operation id in three tiers — `X_GUEST_QUERY_ID` →
one discovered from x.com's own JS bundle → the built-in seed — and discovery
runs only after a 404 has proved the current id stale, at most once per six
hours. A rotation therefore publishes its own fix instead of silently costing
every group its repost count. Do **not** "fix" a 404 by editing the seed. A
pinned `X_GUEST_QUERY_ID` is never overruled (it is the escape hatch), so clear
it once a rotation passes or it becomes the stale one.

```bash
cd bot && npm run raid:check     # which source answers from THIS box, and why not
```

Whether X answers is a property of the server's egress today, not of the code,
so it has to be measured on the box.

## Auto-raid — the project posts, the raid starts itself

Ported to match FourtisRaid's panel (2026-08-13). 👤 X account names the
project's account, 🤖 toggles the watching, 🗑 Remove clears the target and
❓ How it works explains the three things this feature keeps being asked.

**There are TWO ways in, and the cheap one is the one that always works.** The
watcher polls each watched handle (`AUTORAID_POLL_SEC`, 60s) and raids a new
original post. A PASTED LINK does the same with **zero X requests** — the bot
already reads every group message for crew enrolment, so an admin pasting the
project's post IS the signal, and it works on an account X hides.

**X serves logged-out timelines SELECTIVELY, per account.** Two public accounts
read from one IP can give different answers, and no free source gets past that
— it is an authorization decision about the ACCOUNT, not about the box. Only
`X_BEARER_TOKEN` reads any account. Measure before concluding:

```bash
cd bot && npm run raid:timeline -- @yourproject   # probes a CONTROL account too
```

The control read is what separates "X is unreachable from this server" from
"X won't serve THIS account" — they need different answers and used to get one
shrug.

Rules that are load-bearing, each one a way a raid fires on the wrong post:

- **The first look only SEEDS.** Empty cursor = never looked; the first read
  records the newest post WITHOUT raiding it. Switching accounts resets it —
  snowflakes are one global sequence, so a stale cursor would instantly
  "detect" half the new account's history.
- **The cursor advances BEFORE the raid starts.** A missed auto-raid is a
  shrug; a double raid is the group spammed. A cursor that cannot be SAVED does
  not raid at all.
- **`auto(g)` mutates in place and returns the same object.** The spread form
  replaced `g.autoRaid` on every call, so a reference taken at the top of a
  function stopped pointing at the record the moment a nested call re-derived
  it — the cursor was written to a discarded object and the next tick raided the
  same post again. Caught by a test, not by reading.
- **The clear-words are matched BEFORE `parseHandle`.** `none`, `off`, `clear`,
  `stop`, `remove` are all VALID X handles, so parsing first starts watching
  `@none` — with the account being deleted replaced by a stranger's.
- **`lastCheckedAt` and `lastOkAt` are both needed.** The first is written on
  every tick whether or not X answered (so a stale value means the BOT stopped);
  only the second says X actually answered. With one, a bot blind for hours
  still rendered a green tick — the state that looks most like a healthy one.
- **A blind or stalled panel DROPS the ready line**, never rewords it. "The next
  post starts a raid" under "the bot can't see X" is two lines contradicting
  each other, and the false one is the reassuring one.
- **`settings.postUrl` has ONE writer** — the 🔗 Target post step.
  `startRaid(…, { tweetUrl })` lets auto-raid and a pasted link raid THEIR post
  without touching what the admin configured. A field the bot writes on an
  admin's behalf is one they cannot explain or remove.
- **The link route checks cheap → expensive**: regex on text already in memory →
  the group's config → is it the watched account? → is the sender an admin,
  LAST. That last one is a network round trip and this runs on every group
  message. A member's paste is ignored SILENTLY.
- **`xBundle.js` owns the queryId sweep** for both GraphQL callers. A bundle is
  megabytes; two sweeps would download the same bytes twice and get the host
  blocked twice as fast.

```bash
cd bot && node scripts/run-tests.js test/raidAuto.test.js   # 25 tests, no network
```

## The buy card had TWO ideas of "whale" and only one reached the artwork

A live card, 2026-08-13: header **MEGA BUY**, eight ordinary Dexvra icons under
it, the ordinary "New Buy" GIF, and
`Position: 23,507,098.11 $Plumber · $14,922 (+6913050524503.39%)`. Three
complaints, two causes.

**The label and the artwork answered different questions.** `tierFor(buy.usd)`
gives the headline from what was SPENT (`whale` ≥ $1,000, `mega` ≥ $5,000),
while the icon, the clip and the pin all keyed off `whaleCheck()` — whether the
BUYER is a whale by HOLDINGS (≥ $50,000). A $14,922 buy from a wallet holding
$14,922 is a mega buy by one measure and an ordinary buyer by the other, so the
card contradicted its own headline in two places at once.

- **`tierKey(usd)` is the single owner of the size thresholds** — `"buy"` |
  `"whale"` | `"mega"` — and the label, the icon (`buyIconFor`) and the clip
  kind all read it. **Never key artwork off `tierFor()`**: that returns the
  ADMIN-EDITABLE label, so an operator renaming or translating "MEGA BUY" would
  silently take the whale icon and the whale GIF away with it.
- **Pinning deliberately did NOT move with them.** A pin writes to somebody
  else's group; widening it to every mega buy would start pinning in every
  existing customer's chat without them asking. It stays on the whale-by-WALLET
  verdict. Same reasoning as `autoPinWhale` shipping off.
- The whale card itself is still the wallet verdict. Only the ARTWORK follows
  size — that is what "a big buy should look big" means.

**The Position percentage was two different sources subtracted.** `held` is an
on-chain balance read; `tokenAmount` is parsed out of the swap. Both land in a
float64 and agree to ~11 significant digits, so a first-ever buy does **not**
subtract to exactly zero — it leaves a residue (~0.0003 on a 23.5M bag, i.e.
1.4e-11 of it), and `bought / residue` is a thirteen-digit percentage. The tell
was on the card: the 💎 row and the Position row printed the **same** token
amount, so there was no previous position at all.

`POSITION_NOISE_FLOOR` (1e-6 of the holding) reads anything below it as that
residue and renders `new position`. It is a **precision floor, not a cap**: a
genuinely tiny prior position still prints its real, huge percentage, because
extreme-but-true is a different thing from fabricated. If you ever compare two
quantities from different feeds, assume the low digits disagree.

**And the balance behind it is read `{ fresh: true }`.** `holdingOf` caches a
success for two minutes, justified by "a wallet's holding barely moves between
two buys seconds apart" — true of every wallet except the ONE that just traded,
whose balance moved by exactly the amount the row is reporting. The cache was
pure harm on this path: `buyerPosition` is already resolved once per BUY (outside
the group loop), so a cached hit could only ever be a second buy by the same
wallet inside the window — printing the previous balance under the new buy, and
disagreeing with any explorer the group checked. A cached MISS still
short-circuits, because that one exists so a dead RPC costs one six-second
timeout rather than one per buy.

**Position is ONE token at the pool price, never a portfolio.** Solscan's "Total
Value" sums SOL plus every token in the wallet, so the two legitimately differ
and comparing them proves nothing. `walletHoldings.js` says so at the top and it
is worth repeating here: the comparable number on an explorer is the tracked
token's own balance line.

```bash
cd bot && node scripts/run-tests.js test/whaleAlert.test.js test/buyMonitor.test.js
```

## Conventions

- Tests live beside the code they cover, in `bot/test/`, `tradebot/*.test.js`
  and `src/**/*.test.ts`. A behaviour change without a test that would have
  caught the old behaviour is not finished.
- Comments explain **why**, and name the failure the code is shaped around.
  Match the density of the file you are editing.
- Operator-facing strings in @dexvraadminbot are **Indonesian**; user-facing
  bot copy and channel posts are English.
