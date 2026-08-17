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

**The same is true of every placeholder, not just paths.** `REPORT_CHANNEL_ID=-100xxxxxxxxxx`
was offered as an example and appended to a live `.env` verbatim, where it
overrode a working default and silently stopped every ops report — `post()`
swallows its own failures by design, so nothing anywhere said why. A command
an operator can paste must contain only real values, or it must not be a
command: describe where the value comes from and let them fill it in, and make
the code reject a value that cannot possibly be right (`report.js`
`_looksLikeChatId`).

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

## Before a token migrates, only its launchpad knows it

DexScreener and GeckoTerminal index **pools**. A token on a bonding curve has no
pool, so for its entire pre-migration life — minutes to days, and the window in
which people actually ask about it — both processes were blind in the same way:

- the trade card said **"❌ Couldn't price it"** and offered a chain picker,
  about a token trading perfectly well on its launchpad;
- worse, `tokenSnapshot`'s Solana branch hardcoded `graduated: true,
  progressPct: 100` for **every** mint, so even a token DexScreener *did* index
  was badged `◆ DEX` while it sat at 12% of a curve;
- the listing form autofilled nothing — no name, ticker, logo, socials or
  overview — for a project whose whole profile is public on its pad.

`shared/launchpads/` is the fix, and it is **one module both processes require**.
That is not tidiness: `tradebot/solana.js` and `bot/src/marketdata.js` each
carried their own idea of which pump.fun host was current, they drifted, one was
left on the retired host, and Solana snipe discovery was blind for days behind a
green `/health`. `bot/src/launchpads.js` and `tradebot/launchpads.js` are thin
shims that reshape the output; neither names a host, and a test asserts they
never grow one again.

- **`pads.js` is a TABLE, and every entry is env-overridable.** These request
  shapes are not published contracts. `LAUNCHPADS=0` kills the registry;
  `LAUNCHPAD_<PAD>=0` kills one (blank ≠ false, same rule as
  `raid/sourceFlag.js`); `LAUNCHPAD_<PAD>_API` pins one host **and** skips the
  base list; `LAUNCHPAD_<PAD>_TOKEN_PATH` / `_FEED_PATH` rewrite the paths. A
  pad whose guessed path is wrong costs a line in `.env`, not a deploy — which
  is why adding a pad whose shape we cannot verify is safe. `verified: false`
  marks those, and the check script prints it.
- **`PUMPFUN_API` is honoured as an alias.** An operator's existing override
  must not be silently outvoted by a second env var with a longer name.
- **Display metadata only.** Nothing here prices, routes or authorises a swap —
  same contract as `poolstrade.js`, and it matters more here because these pads
  quote a price. `curveSnapshot()` returns `routable: false` *always*; `core.js`
  upgrades it only after Jupiter has actually quoted the mint (`_solRoutable`).
  Knowing a price and being able to fill a swap are different capabilities —
  the line `v4.js` draws between `price()` and `canSwapLive()`.
- **A dead pad must cost nothing.** Pads are asked concurrently and the caller
  waits for all of them, so one unreachable host adds its full timeout to every
  card render and every autofill. Three consecutive **transport** failures bench
  a pad for `LAUNCHPAD_BREAKER_MS`; an HTTP status never benches it (the host
  answered). A benched pad is reported in `tried`, never silently skipped.
- **Curve state is taken WHOLE from one pad.** Facts outrank readings: a
  migration pool beats a stale percentage. Taking `graduated` from one source
  and `42%` from another is a card contradicting itself in two places — exactly
  what the buy card's two ideas of "whale" already cost.
- **`onCurve` is three-valued.** `true` / `false` / `null` for "no pad said".
  Rendering the null as either one invents a fact.
- ⚠️ **`Number('')` is `0`.** The first cut of the env reader used it, so every
  default was silently replaced by zero — no caching at all, and a breaker that
  tripped after 0 failures for 0ms. Nothing errored and nothing logged.
- **The snipe keeps ONE CURSOR PER PAD.** A shared cursor lets one pad's bad
  timestamp advance past every real launch on every other pad, and the snipe
  goes quiet forever — which looks exactly like a slow day. `normalize.toMs()`
  also refuses a future timestamp; that is the first line, and first lines have
  been wrong before.

```bash
cd bot      && npm run launchpads:check            # which pads answer, and what a listing would autofill
cd tradebot && npm run launchpads:check <mint>     # the same registry, pad by pad, for one token
```

Whether a launchpad answers is a property of the server's egress today, not of
the code — these hosts block datacenter ranges — so it has to be measured on the
box. `upstreams.js` picks up the pad probes automatically (none `critical`: a
dead pad costs pre-migration data, not the ability to trade).

**Config a fix depends on:** nothing. Every pad ships on, and blank means on.
The one thing an operator has to do is hit **♻️ Reset default** on the
`review_card` template if they have ever edited it, or the "🚀 Still bonding"
line will not appear on the listing review card.

## The banner drew "$???" to 12,607 subscribers

A token listed as **牛来 ($牛来)** went out on the listing card as `$???` and again
on the pump alert as `??`. Nothing failed and nothing logged: **a font that lacks
a glyph does not throw** — it draws a box, or a question mark, and ships.

Every brand face in this repo is Latin-only — Sora, Space Grotesk, JetBrains
Mono, Liberation Sans — so every Chinese, Japanese, Korean, Thai or Arabic ticker
the bot has ever drawn came out the same way, silently, since the fonts were
added.

- **A FALLBACK CHAIN, not a second font for Chinese.** Canvas resolves a
  comma-separated family list **per glyph**, so `牛来 Finance` keeps the brand
  face for the Latin word and reaches the coverage face only for the Han
  characters. Swapping the whole face on a mixed name puts brand type on one half
  of a title and a system face on the other. Verified by measurement: with the
  chain, `牛来` measures exactly what the CJK face alone measures and `AB`
  measures exactly what Sora alone measures.
- **The chain is appended to EVERY entry in `F`**, so no renderer opts in. One
  that had to would forget on the card that needed it.
- **Discovered across a candidate LIST**, repo `assets/fonts/` first, then the
  system paths — same contract as the launchpad hosts. Installing a font package
  is the whole fix, with no deploy; `EXTRA_CANDIDATES` (Thai, Arabic, Devanagari,
  Hebrew) is listed up front for exactly that reason.
- **BOLD before Regular, per script.** These faces sit beside the 700/800 display
  weights; a regular-weight Thai word next to a heavy Latin one reads as two
  titles — the mixed-face defect one level down.
- **Emoji goes LAST in the chain.** A colour-emoji face claims some text
  codepoints, and a ticker's letters must not resolve to it ahead of a real text
  font.
- ⚠️ **The boot warning names EVERY uncovered script, not just CJK.** The first
  cut warned about Chinese alone, which would have let the next Thai ticker reach
  the channel as boxes in the same silence. A warning that covers one instance of
  a general failure is how the general failure survives being fixed.
- **Shaping is the shaper's job.** Canvas runs HarfBuzz, so Arabic joins and runs
  right-to-left and Thai stacks its marks with no code here — all the font list
  has to get right is handing it a face that HAS the glyphs. Verified by
  rendering real listing cards: `$牛来`, `$ไทยบาท` (`เพื่อญาติ Finance`, stacked
  vowels intact) and `$عملة` (`عملة رقمية Token`, bidi correct).
- Thai ascends ~25% higher than Latin at the same size (54px vs 43px at 52px
  type) because of its stacked vowel marks. The card has headroom above `symY`
  and does not clip — but a tighter layout would, and `fitText` only shrinks for
  WIDTH.
- ⚠️ **`reg()` assigns unconditionally, and the two Liberation "fallback" calls
  ran after their Sora counterparts** — so Liberation Sans silently won `x` (the
  800 display weight, i.e. the big token title on every card) and `m`. The
  artwork has been off-brand on its most prominent line for as long as the brand
  fonts have existed. `regFb()` is the guard the comment always implied.

### So it cannot happen again quietly

The chain fixes the cause. What stops the NEXT one is that a banner can no
longer ship boxes unnoticed:

- **`unrenderable(text)` asks about the STRING, not about a list of scripts.** A
  Private Use codepoint is in no font, so its advance width IS this face's notdef
  box; any character measuring the same has fallen to the same box. That caught
  Armenian, Bengali, Tamil and Georgian on a box where `coverage()` reported all
  nine sampled scripts green — the same silence as `$???`, one script family over.
  A heuristic (a real glyph could share that advance), so it drives a WARNING and
  never a rendering decision. Cached per codepoint, ASCII skipped.
- **`warnBoxes()` lives in `canvasKit`, and every renderer entry calls it** — the
  listing/trending card, the rank-up card, and `bannerTemplate.compose()`, which
  is the one function every overlay goes through, the pump alert included. A
  guard each renderer had to remember is one the fifth renderer will not have;
  `bannerFonts.test.js` fails if an entry stops calling it or grows its own copy.
- **It warns and renders anyway.** A banner with two boxes still beats no banner
  — the project is owed its listing, and a render that refused would turn a
  blemish into an outage. What must not happen again is it going out unseen.
- It posts through `log.alert`, which de-duplicates: one token drawn on the card,
  the pump alert and a rank-up is one line in the ops channel, not three.

```bash
cd bot && npm run fonts:check     # which scripts THIS box can draw, plus a sample PNG
```

Whether a glyph renders is a property of the fonts on the server, not of the
code — same as `raid:check` and `launchpads:check` — so it has to be measured on
the box.

**Config a fix depends on:** the fonts. **Three packages, and the third is the
one that gets forgotten** —

```bash
apt-get install -y fonts-noto-cjk fonts-noto-core fonts-noto-color-emoji
```

`fonts-noto-cjk` covers Chinese/Japanese/Korean, `fonts-noto-core` adds Thai,
Arabic, Devanagari and Hebrew, and **emoji lives in its own package that neither
of the other two pulls in**. An install line written from memory left it out, the
operator ran exactly what was asked, and the box came back with every text script
green and `✗ Emoji` — on a market where 🚀 in a ticker is routine.

So the mapping is in code (`PKG_FOR` / `packagesFor()`), and both the boot
warning and `fonts:check` print the exact `apt-get` line for whatever is actually
missing. "1 script(s) uncovered" is a diagnostic; a package name is an
instruction, and it cannot be recalled wrongly if it is computed.

## A Top 3 that was not the top of the Top 5

Two banners, one minute apart, from the same admin panel:

```
Top 5 (14:25)  BEHEMOTH +3981% · PATE +1538% · 牛来 +118% · SESTRI +35.3% · BOYZ +31.1%
Top 3 (14:26)  PATE +1538% · NYAN +25.3% · DOOM +18.7%
```

A Top 3 must be the first three of a Top 5. This one shared **one** token with
it, and the two it added rank *below* two the Top 5 already had.

**It was not the market moving.** PATE carried the identical `+1538%` on both, so
both readings are from the same moment. What changed is the **POOL**: the board
filter is `t.source === "live"` — whatever the website had a fresh price for at
that instant — and `sendPreview` re-sampled it on every template switch, at
`limit: countOf(id)`. Four tokens went stale between the two calls and left the
ranking without a word.

- **One sample per sitting, sliced per template.** Taken at `MAX_SLOTS` so it
  serves any layout the admin clicks next; any two previews are then prefixes of
  each other *by construction*, which no amount of re-fetching can give you.
  `SAMPLE_TTL_MS` (3 min) stops a 14:25 sample being posted at 15:40.
- ⚠️ **The session must keep the WHOLE sample, not the slice just rendered.** The
  old tail wrote `coins: stripLogos(coins)`, so a Top 3 preview left a
  three-token session and no wider layout could reuse it — that alone would have
  made the fix inert, and silently: every preview would simply have gone on
  re-sampling.
- **🔄 Refresh needed its own action.** It shared the template-pick callback,
  which now reuses the sample — so the button would have stopped refreshing while
  still saying it did. That is a worse bug than the one being fixed, because it
  is invisible.
- **`pool` was measured, returned, and never printed.** When the live rows
  collapsed, the card showed three tokens and looked entirely normal. It is on
  the preview now with the sample age, plus a warning when the pool is barely
  wider than the layout — a "top 5" drawn from six live tokens is a list, not a
  ranking.
- Posting already published `sess.coins` rather than a fresh reading, so the
  channel got the card the admin approved. That half was right and a test now
  pins it.

### And the podium was ranking noise

Same board: `$PATE` took #2 with **+1562%** on a market cap of **$52.6K**, above a
token up 126% on $40.89M. At that size one $500 buy is a four-figure percentage.
The sort was correct and the statement was false — a gain is only interesting next
to something worth gaining on.

There were two floors (gain, liquidity) and no market-cap floor at all.
`minMcapUsd` is the third, and **it ships ON at $1M** — unlike `minLiqUsd`,
because zero is what produced that banner. An existing install has no stored
value, so the default applies and **the daily post changes**: that is intended,
not a migration accident.

- **A token whose cap could not be read is left OFF.** The filter is a claim
  ("cap ≥ $1M"); a token with no cap cannot be shown to satisfy it. Same rule as
  an unreadable 24h change, same `|| 0` shape as the liquidity filter beside it.
- **Fewer real gainers beats padding.** Two tokens clearing $1M render as two, and
  the card says "Only N passed the filters" — it never reaches back down for the
  $52K one.
- **Applied before the slice**, or a "top 3" is three of whatever survived out of
  the first three rather than the best three that qualify.
- ⚠️ **The DAILY POSTER passes it too.** Wiring only the preview would show the
  admin a filtered board and publish an unfiltered one, which is worse than no
  filter. A test counts the call sites.
- Editable from ⚙️ Settings → 🏦 Min market cap, shown on the settings screen and
  in the home screen's filter summary, so an admin can see why a token they
  expected is missing.

⚠️ **`500k` set it to $1M, and the bot said ✅.** `Number("500k")` is NaN, and
`clampNum()` answers a non-finite value with the **default** — so the value asked
for was never stored, the setting was silently reset, and the reply reported
success. A ✅ carrying a number nobody asked for is worse than an error, because
nothing prompts a second look. The same two lines governed Min gain % and Min
liquidity.

- **`parseCap()` lives beside `fmtCap()` as its inverse** and returns `null`, never
  a number, on anything it cannot read. A parser that cannot fail is a parser that
  lies for its caller. Accepts `500k`, `1.5M`, `2b`, `1,000,000`, `$500k`.
- **One branch serves all three settings**, so a fourth cannot inherit the old
  shape, and an unreadable value throws — *"Nothing was changed."*
- **A clamped value is reported as clamped.** The bounds are real (a ten-trillion
  floor would empty the board for good), but storing something other than what was
  asked for and calling it ✅ is the NaN defect moved to the edges.

### Top 2 Duel

The layout ladder ran 1 · 3 · 4 · 5 · 8 · 10 — the head-to-head shape a
two-token day needs was the one missing. `duel2` fills it: winner gold and
slightly taller, runner-up silver, identity row horizontal because two columns
are wide enough to read that way. It inherits the identity rule below from day
one (one ticker size, figure scales ≥1.4×), and a test pins the ladder order —
the admin menu is built from `TEMPLATE_IDS`.

### The winner's NAME is not a ranking signal

`$巨兽BEHEMOTH` was drawn at 44px against 31px for the two cards beside it, and a
project asked why. The comment defending the scale-up says *"≥1.4× on the
**figure**"* — and the code applied it to the ticker too. All three columns are
the same width (`colW` is one value); only the height differs. So a bigger name
buys no legibility and costs the card set its typographic consistency.

`tickSize` is one value now. `pctSize` keeps the 68/44 split, because that part of
the reasoning stands. Rank is still carried six ways — elevation, the
`#1 · Top gainer` chip, the gold ring, the medal, the larger avatar, and the
figure. A name is an IDENTITY; three identities at three sizes reads as three
different designs.

### The board lost the X handle the bot already had

The caption read `#巨兽BEHEMOTH +4336%` with nothing to click. `boardCoin` reads
`t.links.twitter` (the website's row) while `listingCoins` reads `row.twitter`
(what the project typed on its listing form) — **not equivalent**, and the board
is preferred, so a token the site has no link for lost its credit entirely.

- **`enrichHandles()` fills only what is MISSING**, from the listing store, after
  the ranking has cut the pool to ≤ `MAX_SLOTS`. The board's own value always
  wins; this must never rewrite an attribution the site is asserting.
- **One request, and only when it can change something.** A failing lookup loses
  the handle, never the banner.
- ⚠️ **It REPORTS what it did.** The first cut swallowed the outcome in a
  `log.debug`, so when the caption still came back with no handles the only thing
  anyone could say was *"it did not work"* — three tokens with no X on file, a
  failed listing lookup, and a chain key that did not match all look identical
  from Telegram. `{ filled, noHandle, notListed, failed }` reaches the preview
  card and an INFO log line. A level nobody prints is the same as no line at all,
  and an outage on our side must never be reported as "the project gave no X".
- **A bare handle is a handle.** The listing form is free text, so `xHandle` now
  accepts `@velvet_capital` and `velvet_capital`, not just a URL — while still
  rejecting the words a form collects instead of a blank (`none`, `TBA`, `n/a`).
  Widening that parser must not put `@TBA` on a public post.
- ⚠️ **A bare `@handle` in Telegram is a TELEGRAM username** — tapping it opens
  Telegram's user search, not X. The caption builds an explicit
  `[@handle](https://x.com/handle)`. `sanitizeVar` deliberately leaves `_` alone;
  escaping it would 404 every handle ending in one.
- The **tweet** text keeps a plain `@handle`: X has no link labels, and
  `[@x](url)` would publish its brackets verbatim.

```bash
cd bot && node scripts/run-tests.js test/gainersSample.test.js test/gainersFilters.test.js test/gainersIdentity.test.js   # 45 tests, no network
```

**Config a fix depends on:** nothing — but `minMcapUsd` is a live setting, so an
operator who wants the old unfiltered board sets it to `0`.

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

## "Buy ngasal" — auto-snipe fired from a switch armed weeks of screens away

A user turned the COPY-TRADING master switch ON — no wallets followed, no CA
targets — and the bot bought two fresh launches at 0.0495 SOL each. What fired
was **Auto-Snipe** (`u.snipe.chains.solana` + `ethAmount 0.05` — the default is
0.01, so it had been armed through /snipe at some point and forgotten). The copy
switch is a different feature and touches none of it; `autoSnipeConsent.test.js`
pins those boundaries.

The report still named a real defect, in three parts, all fixed:

- **Arming is ANNOUNCED — and it is not a toggle any more.** The /snipe chain
  tap used to flip a feature that buys every new launch on the chain with real
  money, silently, reusing an amount set weeks earlier on another screen. The
  flow is chain FIRST now ("intinya pertama disuruh pilih chain dulu"): tapping
  an OFF chain opens Step 2, the amount screen, and only picking an amount arms
  — `armAutoSnipe()` is the ONE arming site, and the warning states the blast
  radius and the spend it was JUST given. OFF stays a one-tap stop (it is the
  🛑 button on every purchase message) and stays silent — a warning on OFF
  would teach users the message is furniture. A toggle also meant a second tap
  on an old 🛑 button silently re-armed; now it opens the amount step instead.
- **A message that spends money names its trigger.** All three auto-snipe
  purchase sites say "Auto-Snipe bought" plus "buys EVERY new launch on this
  chain while armed — this was not a CA or dev-wallet target"; the CA-target
  fill says "This was YOUR armed target". Three snipe features must be
  distinguishable from the message alone, or an unexpected buy cannot be traced
  to its switch.
- **The off switch is ON the purchase message** (`_autoSnipeKb` → the same
  `sntog` callback as the settings screen, so the button and the screen cannot
  disagree about what "off" means). The user should never have to hunt for the
  right screen while the bot keeps buying.

```bash
cd tradebot && node --test autoSnipeConsent.test.js   # 7 tests, no network
```

**Config a fix depends on:** nothing — but if the bot "buys by itself", check
/snipe first: an armed chain there is the only thing that buys without a target.

## Trade speed — the code paid round trips it did not owe

Three real serialisations on the Solana buy path, all found by reading the code
after "saya ingin buat bot lebih cepat lgi respn dan eksekusi":

- **The quote waited on chain reads it does not depend on.** `getQuote` needs two
  mints, an amount and a slippage — none of it from the chain — yet it was issued
  inside `solana.swap()`, i.e. only after `solBalance` + `splBalance` +
  `tokenMeta` had all come back. `_buySol` starts it as `quoteP` now and hands
  the promise in; `swap()` behaves exactly as before when it is absent. A buy
  that fails its balance check wastes one quote, which is the whole cost.
- **The divergence guard held a live quote for a display value** — the rule the
  guard itself was written under. "The reference runs concurrently so it costs no
  fill time" is true only while DexScreener is faster than Jupiter; when it is
  not, that unbounded `await refP` sat between pricing and signature for up to
  its own 5s timeout. Bounded by `SOL_GUARD_REF_WAIT_MS` (1200ms). Not a
  weakening: *"no reference is not a reason to block a trade"* was already the
  position two lines further down.
- **The bot's own fee sat between the fill and the receipt.** Deferring its
  *confirmation* was the first half; the *broadcast* was still awaited, and that
  is `getLatestBlockhash` plus a send the RPC **simulates first** — the fee
  transfer runs with preflight ON, unlike the swap. `feeHash` has exactly one
  reader (`feeCollected` in the ops report), so the report waits and the receipt
  does not; `res.feeHash` is filled in by the continuation so the flag stays
  truthful rather than optimistic. Both buy and sell.

**Every buy logs where its time went, phase by phase**, because every speed
change on this path had been argued from reading the code — which is how the
reference await survived being called free for as long as it did:

```
[buy] sol Ge87Etsj reads=160ms quote=8ms guard=2ms build=210ms send=170ms confirm=150ms prio=0
```

A phase that never ran is omitted, never printed as `0ms` — a zero meaning "did
not happen" reads as a finding. The line is printed on the FAILURE path too: a
buy that gave up waiting is the one whose confirm time most needs reading.

### Five wallets were throttling each other

The first thing the timings showed, five wallets into one token on one block:

```
swap=541ms  swap=527ms  swap=522ms  swap=1297ms  swap=2289ms
```

Same route, same quote, same slot — a 4.4× spread that is not the trade.
`confirmSignature` polls every 200ms, and the "~5 status reads per trade" it is
documented as costing is per **trade**: five concurrent confirmations is ~25
requests a second, arriving alongside five sends and fifteen balance reads, at an
endpoint that serves one IP far less than that. The throttling lands on the
confirmations because they are what is still running.

`getSignatureStatuses` takes an **array**, and always did. `signatureStatus()`
coalesces the polls that fall in one `SOL_STATUS_BATCH_MS` window (25ms) into a
single request, so the fifth wallet stops paying for the other four.

- **Each waiter gets ITS OWN index** out of the response. Getting that wrong
  reports four trades on one trade's outcome.
- **An RPC failure RESOLVES NULL, never rejects.** `confirmSignature` treats a
  transient failure as "keep polling"; a batch that rejected would turn one blip
  into every in-flight trade reporting "not confirmed".
- **The pending map is swapped out before the request goes**, so a signature that
  starts waiting mid-flight lands in the next batch rather than being answered by
  a read that predates it.
- `SOL_STATUS_BATCH_MS=0` restores one-call-per-signature.

### The two biggest levers are CONFIG, not code

Both dwarf everything above, and neither can be set from this repo — `.env` lives
only on the server.

⚠️ **The trade bot reads `tradebot/.env`, not the repo root's.** `core.js` loads
`path.join(__dirname, '.env')`, so on the box that is **`/opt/dexvra/tradebot/.env`**.
A value written to `/opt/dexvra/.env` is read by the web app and by nothing else:
the bot boots clean, trades fine, and stays slow, with no signal anywhere that
the setting never arrived. That mistake has been made. **Both knobs are on the
boot line now** precisely so it cannot be made silently again:

```
[boot] solana: rpc PUBLIC default (rate-limited) · priority fee OFF — transactions queue behind every paying one
```

The RPC **URL** is never printed — a paid endpoint carries its API key in the
path, and this line goes to pm2's log. Whether one is set is the fact worth
reporting; which one it is, is a secret.

- **`SOLANA_RPC`** — unset, the bot uses Solana's public endpoint, which is
  aggressively rate-limited and throttles the websocket hard enough that
  `confirmSignature` had to be rewritten to poll HTTP. A paid RPC changes `reads=`
  and the confirm poll more than any code change here.
- **`SOL_PRIORITY_LAMPORTS`** — defaults to **0**, and at 0 the field is omitted
  from Jupiter's `/swap` body entirely. On a congested Solana this is the
  difference between landing in the next slot and landing in ten, or being
  dropped. It is printed as `prio=` on every buy line above so it cannot stay
  invisible.

## The "Possible rug / dump" alert is REMOVED — do not add it back

Five wallets bought $Ge87…pump — 0.01312 SOL each, entry $0.00724, MC $7.25M —
and one minute later the bot said this **four times**:

> ⚠️ Possible rug / dump: value fell to ≈ **0.0131 SOL** from a peak of ≈ 0.1004.

Nothing had dumped. `0.0131` is one wallet's brand-new bag at the price it was
just bought at; `0.1004` was a holding in the *same* wallet that had already
been sold. **A position record survives being sold to zero** — it is what carries
the lifetime `ethIn`/`ethOut` — and `peakValueEth` rode along with it. With
`POS_RUG_DROP` at 0.15, `0.0131 ≤ 0.1004 × 0.15` exactly: arithmetically
certain, not unlucky, for anyone buying back into a token they once held bigger.

**A PEAK IS NOT A FACT ABOUT THE TOKEN** — it is the highest number this bot
happened to observe. That made the alert wrong in both directions: it fired on a
token that had merely retraced from a spike, it fired on a fresh bag whenever a
peak outlived a previous holding, and it stayed silent on a token that rugged
before it ever had a peak worth measuring. A warning that cries wolf trains the
reader to swipe the next one away, so the owner's call was to delete it rather
than tune it. `peakValueEth` and `POS_RUG_DROP` went with it; a value written to
the store every cycle for nobody is disk churn plus a field the next person has
to work out is dead.

- **🛡 Auto-protect is untouched, and is the guard that matters.** It *sells*, it
  measures against **your entry** and never against a high-water mark, and its DM
  is never muted by the 🔔 toggle. `RUG_MIN_PEAK` survives the deletion because
  auto-protect uses it as a dust floor — the env var keeps the misleading name
  because an operator may already have set it.
- **`_resetRiskIfFresh(p)` survives for the auto-protect cooldown.** A stale
  `protectAt` *suppresses* a real rescue on the new position — the same defect as
  the false alarm, with the loss reversed and far more expensive. It existed in
  `buy()` only; `_buySol` never had it, which is why the alarm was Solana-only.
  One function now, called by both, and a test names both call sites.
- **It must run BEFORE `p.tokens` is written**, or it inspects the bag it was
  meant to test. Adding to a LIVE bag keeps its history.
- **A deleted feature leaves a note where it was.** With no trace it reads as an
  oversight, and the next person to notice positions have no dump warning simply
  adds one back. `stalePeak.test.js` asserts both the removal and the note.

## A buy surfaces the monitor — reversed on purpose

*"harusnya ada monitor lgsung"*. `startMonitor` reused the pinned card in place
after a buy, on the reasoning that "churning the pinned message on every fill
would be worse than leaving it". That was wrong in the one case it mattered:
**receipts are always posted AFTER the fill** — a five-wallet buy pushes five
messages on top of the card — so after a buy the card is always buried, and the
moment a person most wants to see what they hold is the moment the numbers just
changed. What they got was five receipts each with a 📍 button and a live card
somewhere above the scroll. It is one surface per BUY (not per wallet) and the
pin is silent, so the churn this guarded against is the same frequency as the
receipt itself.

```bash
cd tradebot && node --test stalePeak.test.js   # 9 tests, no network
```

**Config a fix depends on:** nothing.

## "Something glitched handling that" was `tg()` retrying the wrong failure

The server log, asked what was behind that message, had three lines to say:
`handleUpdate fetch failed`. Two words — not which host, not which syscall, not
what the user had done.

**`tg()` honoured Telegram's 429 and let a transport error out.** A 429 is an
*answer*, from a host that is plainly there and talking; a `fetch failed` is the
one thing worth retrying, and it was the one thing that was not. It unwound
through `send()`/`edit()`/`answer()`, out of `onMessage`/`onCallback`, and landed
in `handleUpdate`'s catch, which turns any error at all into that one sentence.
So a momentary blip on the way to `api.telegram.org` cost the user their action
and told the operator nothing.

- **Retried ONLY on codes that prove the request never left** (`TG_NEVER_SENT`).
  A connection that was established and then broke may already have delivered
  the message, and a duplicate receipt is its own bug — worse than a missing one
  on a buy confirmation.
- **`netErr()` does the wording**, not a fourth private idea of failure. It is
  the module that already knows undici hides the syscall in `err.cause`.
- ⚠️ **`API` ends in the bot token, and `netErr()` falls back to the whole URL
  when it cannot parse one.** Hand it `TG_HOST`, never `${API}/...`, or the
  token lands in an Error message, in pm2's log, and very nearly in a chat.
- ⚠️ **Never identify the failing path from message TEXT.** The import-wallet
  step takes a private key as a plain chat message, so even a truncated
  `up.message.text` puts key material in the log. The bot's own `pending.action`
  names the step better and carries nothing the user typed; callback data is
  bot-generated and safe.
- **"Something glitched" is a claim about the BOT.** On an upstream outage it is
  the wrong claim and it invites an instant retry into the same dead host —
  `err.glitch` / `err.glitch_net`, and both are translated now; the original was
  one hardcoded English string on a bot that ships EN/ID everywhere else.
- **A poll that THREW is not a poll that worked.** The `getUpdates` loop slept
  two seconds and said nothing, so a bot unable to reach Telegram for an hour
  looked exactly like a quiet hour. Logged on the transition, recovery included
  — same rule as `upstreams.js`.

```bash
cd tradebot && node --test routerError.test.js   # 9 tests, no network
```

**Config a fix depends on:** nothing.

## "Entry" was the price on the card, not the price anyone paid

A live buy, 2026-08-16: `Spent 0.099 SOL ($7.46)` · `Got 129.16K ($6.77)` ·
`Entry $0.0000524`, and the Monitor that opens straight after it read
`Price $0.0000523 · P/L −9.48%` on a token that had not moved. Reported as
*"ini baru beli lgsung minus 10%"*.

**Every number was individually correct.** 0.099 SOL bought a bag worth 0.0896
SOL at mid; the whole −9.48% was the cost of opening the position. What was
wrong is that the receipt printed the *card* price under the label **Entry**.
The fill was 0.099 ÷ 129,160 = $0.0000578, 10.4% higher — so the two messages
the bot sends back to back asserted "you entered at 0.0000524" and "price is
0.0000523, you are −9.48%", which cannot both hold. From inside Telegram that is
a bot that cannot count, not a trade that cost 10% to open.

- **`receipt.fillStats()` is the single owner** of realised-vs-shown. The
  multi-wallet path had divided `totSpent / totTok` since the per-wallet
  rewrite; the SINGLE-wallet path — much the commonest — never did, so the shape
  most users see was the one shape that hid the gap. Both call it now and a test
  asserts no path re-derives it.
- **`offBy` is computed in NATIVE units** and is dimensionless, so the warning
  survives a dead USD feed. `realPx`/`refPx` are `null`, never `0`, without a
  rate — a confident $0 beside a real trade is worse than a blank.
- **"10.4% above" and "opens at −9.4%" are DIFFERENT numbers** (`1−1/offBy`, not
  `offBy−1`). Printing one as the other is the same contradiction one level down.
- **The bot's cut is on the receipt now.** It is carved out *before* the swap, so
  a 0.1 SOL action reached the pool as 0.099 and every screen showed the 0.099 —
  real money leaving a wallet with nothing anywhere to account for it.
- **The Monitor prints the entry beside the price.** `cost / pricedTokens`, the
  same two figures the P/L line is already built from, so its percentage is
  checkable on the card that states it. Costed tokens only — dividing a basis by
  a bag that includes airdropped tokens invents an entry nobody paid.
- **Jupiter returns a price impact on every quote** and nothing read it. It is a
  FRACTION there and a PERCENT on `res.impactPct`; the conversion lives in
  `core.js` once. It is what separates "the pool is thin" from "our price feed
  disagrees with the router" — two problems with different answers that used to
  get one shrug. `shortfall` (quote promised vs wallet received) was likewise
  `console.warn`'d where no user could see it.

```bash
cd tradebot && node --test entryPrice.test.js   # 13 tests, no network
```

**Config a fix depends on:** nothing.

## One wallet, one receipt

A multi-wallet trade used to produce a SINGLE message, built only after
`Promise.allSettled` had resolved **every** wallet, with the wallets reduced to
bullet points inside it. Two complaints, both right:

1. **Nothing arrives until the slowest wallet settles.** Four fills in two
   seconds and a fifth that takes twenty is twenty seconds of empty chat and
   then the whole batch at once. The trades were always parallel; only the
   telling was serial, so a bot that is genuinely fast read as one that had hung.
2. **A bullet is not a receipt.** It cannot carry the token, the amount in token
   units, the market cap and a transaction button — and checking ONE wallet is
   the first thing anyone does after a trade.

`tradebot/receipt.js` is the renderer (pure, no I/O, no `core`), and each wallet
is now posted the moment its own promise settles. `receiptStyle` in ⚙️ Settings
switches back to `combined`; **per-wallet is the default**.

- **The tap reports, `allSettled` still aggregates.** `raw.map((p, i) => p.then(
  post, post))` — the summary is computed from exactly the same results as
  before. What the summary keeps is only what no single receipt can say: the
  totals, the average realised fill, and the "every wallet failed the same way"
  collapse. The bullet list is gone in per-wallet mode; the same information
  twice is noise.
- **Receipts go through `queuedSend`, one at a time per chat.** Five concurrent
  sends is exactly what provokes Telegram's flood limit, and `tg()` used to
  return the 429 to callers that do not check `ok` — i.e. the receipt was simply
  gone. `tg()` now honours `parameters.retry_after`, bounded. A trade the user
  cannot see is worse than a slow one.
- **The header claims the queue first.** `progressP` is enqueued before any tap
  can be, or a wallet that fills before Telegram answers has its receipt appear
  ABOVE the "Buying on 4 wallets…" line for its own batch.
- **The identity and market reads are raced, never awaited.** Both start with
  the fan-out; a receipt waits at most `RECEIPT_MC_WAIT_MS` (600ms) for them.
  Without that wait the FIRST receipt prints `$PONS` with no market cap while
  the other four say `Pons Finance ($PONS) … Entry MC $27.20M` — one trade,
  reported two ways, which reads as a bug in the numbers rather than a race.
- **🟢 means SUCCEEDED, on a buy and a sell alike.** It answers "did it go
  through", not "which direction". An empty wallet gets ⚪️, never ❌ — it did
  exactly the right thing when asked to sell nothing, and a red cross sends
  people hunting for a fault.
- **No transaction, no transaction button.** A link on a receipt for something
  that did not happen is worse than no link.
- **`qty()` groups, it does not compress.** `fmt()` gives "10.28M", which is
  right for a market cap and wrong for "Sell of 10,279,471.93 $RUIN" — that is
  the number in the wallet, in the units the user thinks in. Both sell paths
  now return `soldTokens`; neither did before, so no receipt could ever state it.
- **`receipt.js` adds no escaping**, same contract as `i18n.js`. Callers pass
  pre-escaped values; escaping twice renders `<b>` as literal markup.

```bash
cd tradebot && node --test walletReceipt.test.js   # 19 tests, no network
```

⚠️ **Tests that drive `doBuy` must stop the monitors they open.** A buy starts a
live monitor, the monitor is a self-rescheduling `setTimeout` chain, and
`node --test` then never exits — the failure looks like a hang with no output at
all. `walletReceipt.test.js` clears `_monitors` in its `finally`, and drains
`_sendQ` rather than sleeping a guessed number of milliseconds (a fixed sleep
let one trade's receipts land inside the next trade's captured output).

## Three snipes, and the two that were missing

The bot had two: **Auto-Snipe** buys every new launch on a chain, **dev snipe**
buys whatever a followed wallet launches. Neither could express the most common
request there is — *"I have the contract, buy it the second the pool opens"* —
and dev snipe was refused on every EVM chain.

**Snipe by CA** (`caSnipeCycle`) polls armed contracts and buys on the first
tick they are tradeable. **`core.canTradeNow()` is the single owner** of that
question, because three callers were about to grow three answers to it. "There
is a price" is a different question — the line `v4.js` draws between `price()`
and `canSwapLive()`. A pair that exists with a **zero reserve is not tradeable**:
it is a contract waiting for liquidity, and buying into it fills at an arbitrary
price.

- **A target is CLAIMED before the buy, persisted synchronously.** The poll runs
  every few seconds, so a target left `armed` while its buy is in flight is
  bought again by the next tick. A missed snipe is a shrug; spending twice is
  not. Same rule as the auto-raid cursor.
- **A BROADCAST buy is never re-armed** — it may still land. Anything that
  clearly did not spend goes back on the shelf, because a launch that reverted
  in its first block is exactly the one worth retrying a second later. An empty
  wallet disarms instead of retrying forever.
- **A restart never resurrects a `firing` target.** `ensureUser` marks it failed:
  the buy may have been broadcast before the process died and nothing here can
  tell.
- **Every target carries its own amount and slippage.** `slipBps` **replaces**
  the user's setting; `slipAddBps` (the retry escalation) still **adds** on top.
  Folding them together would let an escalated snipe authorise more than the
  user set. Both capped at 50%.
- **The ring is bounded** (`CA_SNIPE_MAX_PROBES`, round-robin) so target 25 is
  not starved by 1–24 and the RPC the *buy* needs is not spent probing.
- **Targets expire** (`SNIPE_TARGET_TTL_MS`, 48h). An armed address with no
  expiry polls forever.

**Dev snipe now works on every enabled chain.** The old refusal said EVM has no
cheap deployer signal — true of the *deployer*, false of the signal that matters.
The DEX scan already reads `PairCreated`; the **sender of that transaction is the
wallet that opened the pool**, one `getTransaction` away, and it is only resolved
when somebody is actually following a dev on that chain. It is the pool-opener,
not the deployer, and the UI says so — for a memecoin launch they are one key.
The EVM path calls the **same `_followerBuy`** as Robinhood and Solana, so three
chains cannot drift into three ideas of what a dev snipe does.

⚠️ `devFollowers` must **not** be gated on `armed.length`. Following one
developer is not the same as wanting every launch on the chain, and that early
return is what kept dev snipe off EVM even after the chain check was relaxed.

**TP/SL and expiry ride ON the CA target** ("setingan sama kaya sol trading
bot"): `<ca> <amount> [slip%] [tp/sl] [expiry h]`, one line. The exits become
real orders only at the FILL, priced off the realised entry (spent ÷ received)
— never the card price, because a snipe exists precisely where those differ. An
SL ≥ 100% is refused at arm time (it can never fire), and if the buy lands but
the order cap blocks the exits, the receipt SAYS so — a stop-loss the user
believes exists is worse than none.

**Arming asks WHICH CHAIN first** — the panel this mirrors starts at
"Exchange". The old flow bound the target to whatever chain happened to be
active, so a Solana mint pasted while Ethereum was active bounced as "not a
valid contract address" with the fix two screens away on 🌐; the owner's report
was "snipenya dari awal salah aturan, disuruh pilih chain mana dulu". The
picked chain rides the pending step (`p.chain`), the prompt's example address
is chain-shaped (a user copies the shape they are shown), and dev snipe offers
ONLY the launchpad chains — which also deleted its "switch chain with 🌐, then
try again" dead end. The word "snipe" answers to three features on two screens,
so the Copy screen carries a 📍 cross-link to the CA snipe: a user sent by that
word to the wrong screen reported the whole feature as missing while it was
deployed and working.

### The 🎛 Snipe Setup panel — the Sol-Trading-Bot panel, over the same store

"saya ingin fitur snipe sama seperti sol trading bot ada setingan lengkap buat
semudah mugkin" (2026-08-17). The one-line arm stayed; what was missing was the
tap-driven panel the reference bot has: every setting as a label+value button
row — chain, target CA, wallet, amount, slippage, TP/SL, expiry — with the
reference's ✅/⏳ STATUS column inline and ⚡ ARM at the bottom. `/sniper` (and
the 📍 home screen) opens it; the panel is the first button, ⌨️ one-line second.

- **The draft is persisted per user** (`u.snipeDraft`), so a half-configured
  panel survives a restart the way the reference's "Waiting for setup" does.
  It NEVER arms by itself — only ⚡ does, and it goes THROUGH `addSnipeTarget`
  (`armSnipeDraft` is the one caller), so the panel and the one-line arm cannot
  drift into two ideas of a valid target. The one-line grammar itself lives in
  `parseSnipeLine`, shared by both ways in — pasting a full
  `<ca> <amount> [slip%] [tp/sl] [h]` line into the panel's Target step fills
  every row at once.
- **The amount has NO default** — the "buy ngasal" rule again: a draft with a
  default amount is an amount set by nobody, reused silently at arm time.
- **A refused arm keeps the draft** ("already armed", cap reached), so the user
  fixes one row instead of retyping seven. A chain switch DROPS a target
  address that cannot exist on the new chain, with a note saying so — keeping
  it would be the wrong-chain bounce one screen later; and a draft whose chain
  was disabled under it is refused at ⚡, never silently swapped to the active
  chain (`addSnipeTarget`'s fallback is right for a typed line only).
- **A pasted address that does not fit the panel's chain switches it** when the
  shape is unambiguous (a base58 mint under an EVM row), says so, and asks
  instead when several enabled chains fit.
- **Only settings the engine honours get a row.** No Anti-MEV, no Max block:
  a row the backend ignores would be the stop-loss-the-user-believes-exists,
  as a whole screen.
- ⏳ is the "not set yet" marker, so no row may use it as its icon — Expiry's
  is 🕒, or a fully configured panel still reads as waiting.
- **🎯 Snipe and /snipe open the sniper HOME** (panel first, armed targets
  listed), not the mass-mode screen. The panel shipped behind /sniper first,
  the menu's 🎯 Snipe still led to mass mode, and the owner — hunting for the
  panel there — armed a 0.1 SOL buy-every-launch believing it was the sniper
  ("masih sama aja, setinganya bukan yang saya inginkan"). Mass mode is a
  labelled 🌊 choice whose button carries its live armed state, and the home
  prints a ⚠️ line whenever it is on — a feature that spends on every launch
  must be visible from the sniper's front door.
- **One question per message, flowing FORWARD.** "aturan hapus aja, jadiin 1
  aja, jangan pisah2": the dev snipe used to demand `<wallet> <perBuy>
  <budget>` in one typed line — it is a three-step wizard now (wallet → amount
  → budget, quick-picks at each step, the old full line still lands in one
  go), and the panel's Target step asks for the amount immediately after a
  bare address instead of dropping the user back at the panel. A dev snipe
  armed while the copy/dev master switch is OFF says so on the armed message
  with a one-tap 🟢 fix — an inert watch reading as live is the
  stop-loss-the-user-believes-exists.
- **The panel's 🎯 Target is a CHOICE of two kinds** ("dmn target dev
  walletnya"): 📍 token contract, or 🧑‍💻 dev wallet. A wallet and a CA share
  the same address shape on every chain, so no paste can be auto-classified
  into one or the other; the user says which they mean. The dev kind lives ON
  the panel (`draft.kind`): its required rows become Chain · Dev wallet ·
  Amount/launch · 💰 Budget, and the rows the dev path does not honour
  (wallet, slippage, TP/SL, expiry) are HIDDEN, not greyed — a row the backend
  ignores is the stop-loss-the-user-believes-exists. Switching kinds clears
  the address (shape-valid both ways, semantically wrong both ways), and ⚡
  arms a dev target through `addCopyTarget` ('launches'), discriminated by
  `mode === 'launches'` on the return.
- **👥 All wallets** ("harus ada fitur all wallet"): the wallet row accepts
  `walletId: '*'`, resolved at FIRE time so a wallet added after arming still
  snipes. The amount is PER WALLET — the picker row and the armed confirmation
  both state the multiplied total. `_fireCaSnipe` buys the wallets in
  parallel, probes the contract ONCE, and aggregates: any fill → done (TP/SL
  placed per filled wallet at ITS OWN realised entry, orders bound to that
  wallet); any broadcast → done (never re-arm, it may still land); EVERY
  wallet empty → disarmed; anything else → re-armed for the next tick. One
  broke wallet must never stop the others, and a partial fill says `k/N
  wallets` on the message.
- **"respon sangat lambat" is measured, not argued.** `handleUpdate` logs
  `[ui] slow cb:… handle=…ms age=…s` for any update that took >1.5s to handle
  or was already >5s old on arrival — high `age` means the delay happened
  BEFORE the bot (long-poll gap, restart backlog, Telegram); high `handle`
  with low age is ours. The path label comes from callback data or the pending
  action, NEVER from message text — the import-wallet step is a private key in
  a plain message.

```bash
cd tradebot && node --test snipeTarget.test.js   # 29 tests, no RPC
cd tradebot && node --test snipePanel.test.js    # 20 tests, no network
```

**Config a fix depends on:** nothing. Every knob has a working default.

## Conventions

- Tests live beside the code they cover, in `bot/test/`, `tradebot/*.test.js`
  and `src/**/*.test.ts`. A behaviour change without a test that would have
  caught the old behaviour is not finished.
- Comments explain **why**, and name the failure the code is shaped around.
  Match the density of the file you are editing.
- Operator-facing strings in @dexvraadminbot are **Indonesian**; user-facing
  bot copy and channel posts are English.
