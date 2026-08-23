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
  that had to would forget on the card that needed it — and one that draws with
  families of its own is not covered at all, which is exactly what the animated
  overlay turned out to be doing (see below).
- **Discovered across a candidate LIST**, repo `assets/fonts/` first, then the
  system paths — same contract as the launchpad hosts. The faces are BUNDLED, so
  a deploy carries them; a font package is a second source, and an operator's own
  file in `assets/` outranks both.
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

**Config a fix depends on:** emoji, and nothing else — every TEXT face is
bundled now, see the next section. `fonts-noto-color-emoji` is still worth
installing (🚀 in a ticker is routine), and **it is its own package that neither
`fonts-noto-cjk` nor `fonts-noto-core` pulls in**: an install line written from
memory left it out, the operator ran exactly what was asked, and the box came
back with every text script green and `✗ Emoji`.

So the mapping is in code (`PKG_FOR` / `packagesFor()`), and both the boot
warning and `fonts:check` print the exact `apt-get` line for whatever is actually
missing. "1 script(s) uncovered" is a diagnostic; a package name is an
instruction, and it cannot be recalled wrongly if it is computed.

### It shipped as an INSTRUCTION, and the instruction never ran

Six days later, a listing went out on X as `$??` over `??` — the same token
class (`老昊`), the same boxes, this time on the **animated banner**, which is
the artwork most of the channel actually sees. Everything above was deployed.
Two causes, and the second is the one that matters.

**1. `apt-get install` is not a fix, it is a request.** The chain looked in
`assets/fonts/` first and then at the system paths, and the box had neither: the
package was never installed, and nothing about that is visible from Telegram —
the boot warning goes to pm2's log, and a banner with boxes in it renders
successfully. So the six coverage faces are **bundled and git-tracked** now
(`BUNDLED` in `canvasKit.js`, ~17MB, SIL OFL). The server deploys with
`git pull`; a tracked file is the only kind of fix that cannot be skipped. The
system paths stay, and an operator's own file in `assets/` still outranks both.
- **Noto Sans SC has no hangul** — measured, not assumed — so Korean is a second
  file, registered AFTER the Han face. Ahead of it, a Chinese token would be
  drawn in Korean glyph shapes.
- **Emoji is deliberately NOT bundled**: a ~10MB colour-bitmap face for the one
  script whose package is reliably present. It stays the `apt-get` line above.
- A missing bundled face and a missing package are **different instructions**.
  The warning and `fonts:check` now say *"this checkout is incomplete, run git
  pull"* for the first, because sending an operator to apt for a file `git pull`
  restores is how twenty minutes go missing.

**2. ⚠️ The overlay renderer was OUTSIDE the chain, not last in it.**
`bannerTemplate.js` — the one function every animated overlay goes through,
the pump alert included — registered Sora-800/600/500 under three private
families of its own (`TplBold` / `TplSemi` / `TplReg`) and drew with
`TplBold, sans-serif`. Latin-only. **So even with the font installed, the GIF
would still have shipped boxes**, which is exactly what the first version of
this fix would have delivered: measured, with a CJK face registered
process-wide, `老昊` is 150px in `TplBold` (notdef boxes) and 200px in `F.x`.

And it was SILENT, which is the general lesson: `warnBoxes()`/`unrenderable()`
measure against `F.r`, so **the guard was asking about a font stack that
renderer did not use** and answered "no missing glyphs" over a card that was
drawing them. A guard is only honest while every renderer draws through the
stack the guard measures. One registration, in `canvasKit`; `compose()` draws
with `F.x` / `F.s` / `F.m`, and the Latin output is byte-identical across all
four kinds (verified by hashing the PNGs before and after).

- `bannerFonts.test.js` gained the guard that would have caught it, and it
  **runs the renderers** rather than reading them: it wraps the 2D context's
  `font` setter, calls `compose()` and `renderListingBanner()`, and asserts every
  font string they actually set carries every coverage family. A source scan
  passed on the broken revision — the two new renderer tests fail on it, and the
  two bundling tests fail if the fonts are moved out of `assets/`.
- Verified by LOOKING at the output, not only by measuring: the real GIF→MP4
  path (`composeOntoClip` + ffmpeg) renders `$老昊` / `老昊 Finance` on the real
  artwork, and the still cards render `$한글토큰` and `$ไทยบาท` (stacked vowels
  intact, no clipping).
- `tradebot/pnlImage.js` needed nothing: it draws through this same module,
  which is the whole reason that rule exists.

```bash
cd bot && npm run fonts:check                                    # now green on a bare box
cd bot && node scripts/run-tests.js test/bannerFonts.test.js     # 28 tests
```

**Config a fix depends on:** nothing. `git pull` + restart carries the glyphs.

### "bagaimana agar masalah ini tidak terjadi lgi" — a green check that was not

Asked with a screenshot of the production box: nine green ticks, *"Every script
sampled here renders."* The same terminal, on a server whose animated banner had
been publishing `$老昊` as `$□□`.

**Read that output again, because it says what went wrong.** The chain it
printed resolved to `/usr/share/fonts/...` — the SYSTEM paths — and carried no
`Korean` line at all. Both are only possible on code that predates this fix: the
bundled faces are tried FIRST, so a checkout carrying them can never resolve to
`/usr/share`, and `DexCover Korean` does not exist in the old file. The deploy
ran `git pull` on `main`, and the fix was on a branch. So the green was the apt
packages the operator had just installed — cause 1, fixed by hand — sitting over
cause 2, still live.

That is the shape to design against, and it is the third time this feature has
produced it: **the reassuring reading is available, and it is wrong.**

- **`coverage()` answers "does this BOX have the glyphs?"** That question stopped
  being the one that mattered the moment a renderer could be outside the chain.
  It reported ✓ for all nine scripts while the overlay drew boxes, and both
  statements were true.
- **So `fonts:check` now RUNS every surface** — `src/bannerSurfaces.js` is the
  list, and `kit.recordFonts()` wraps the 2D context's `font` setter and reads
  back what each renderer actually set. Per surface, per script, measured. The
  broken revision reports:

      ✗ animated GIF/MP4 overlay — listing clip, pump alert
        bannerTemplate.js drew with: 800 96px TplBold, sans-serif

  and **exits non-zero**, so green means "the banners are safe" rather than "the
  box has fonts". The font string is printed because it is the diagnosis: a stack
  with no `DexCover` family in it is a CODE fix, not an apt one.
- **The list is the guard.** A renderer nobody probes is exactly how this got six
  days; `bannerFonts.test.js` fails the build if a module calling `warnBoxes()` is
  missing from `SURFACES`, and if a listed module does not exist.
- **A surface that throws, or that draws no text at all, is an ERROR — never a
  quiet ✓.** An empty recording measured nothing, and reporting that as a pass is
  this whole section's defect in miniature.
- **The check prints the build stamp** (`build ad43311+dirty`). Every round of
  this has begun with someone reading a check as a statement about the fix they
  just deployed. One line settles it, and it is the same `+dirty` rule as step 5.
- `tradebot/pnlImage.js` is deliberately NOT probed: its input is a computed PnL
  snapshot, not a coin, and the card refuses to draw when anything is unknown —
  so a fabricated one renders nothing and would report a false red on a healthy
  renderer. It is covered by the hardcoded-family scan and by `pnlCard.test.js`.

So the three layers, and each one closes a hole the others cannot:

| layer | stops |
| --- | --- |
| the faces are git-tracked | a deploy that carries the code but not the glyphs |
| `bannerFonts.test.js` runs the renderers | a renderer drifting back outside the chain |
| `fonts:check` probes the surfaces + prints the sha | a green check over a broken banner, and a check read off a stale checkout |

```bash
cd bot && npm run fonts:check     # per BOX and per SURFACE; non-zero if any banner would ship boxes
```

⚠️ **And the deploy itself is the remaining hole, because it is not code.** The
server only ever pulls `main` (see the release flow at the top), so a fix sitting
on a `claude/*` branch is not deployed however many times `git pull` runs — and
from Telegram that is indistinguishable from a fix that did not work. `npm run
fonts:check` printing the sha is the cheapest tell; `git log --oneline -1` on the
box against the branch is the direct one.

## "Sudah di set tapi bot tidak memakai emoji premium terbaru"

Reported with a screenshot of the 🔥 Trending board panel: ranks 1–9 all showing
💎, `🟢 account connected`, `18/33 slots premium` — and a channel board that had
not changed. Nothing in the store or the render path was wrong (`load()` reads
`trendingBoard.json` on every call, both processes share `DATA_DIR`, and
`pe.promote()` returns an already-premium fragment untouched, so a saved id is
never overwritten by the built-in one). **Two things were missing, and both are
the same defect: the panel could not answer the question it exists to answer.**

- ⚠️ **💎 meant "this slot is premium", not "this is YOURS".** `tbMark` was
  `premium ? 💎 : custom ? ✅ : ▫️`, and ranks 1–9 plus the major chains ship
  premium BUILT IN — so a panel on which nothing had ever been saved looked
  exactly like one where every slot was set. The screenshot proves nothing
  either way, which is why it was sent. There are four states now: 💎 yours and
  premium · 🔹 built-in premium · ✅ your plain emoji · ▫️ built-in default. A
  test asserts the two premium marks can never collapse back into one.
- **The board republishes on a 5-minute interval and nothing could hurry it.**
  So "saved" and "live" were separated by up to five minutes of silence, and a
  setting that never took, a slow interval and a premium account Telegram was
  refusing were indistinguishable for that whole window. **🔄 Refresh board now**
  publishes immediately — and REPORTS, in the chat:
  - `✅ Published with your premium emoji — 14 custom emoji went out animated`
  - `⚠️ Published, but PLAIN — the premium account is not connected` (or the
    verbatim `EMOJI_INVALID` Telegram answered with), plus *"your saved emoji
    are fine; the problem is the transport"* and a tap to 💎 Premium status.
  A plain publish must never render as a ✅: in the channel the two are
  identical to anyone without Telegram Premium, which is most people looking.
- **It is a JOB, not a post.** Only the main process owns the board message and
  the GramJS session, so the refresh rides the existing `forcepost/store` +
  `forcePostRunner` channel (`board_refresh`, `noRow`). It is **hidden from the
  Force-post menu**, whose every other entry publishes something new — a confirm
  screen reading *"Real, public post — subscribers will see it"* would be false
  for an edit of the board that is already pinned.
- `trendingPoster.runOnce()` returns `{how, transport, mode, premium, why}`
  rather than nothing. The log line already said this; a value nobody can read
  from Telegram is the same as no line at all.

```bash
cd bot && node scripts/run-tests.js test/adminBoard.test.js test/trendingPremium.test.js test/forcePost.test.js   # 35 tests
```

**Config a fix depends on:** nothing in this repo — but the emoji only ANIMATE
through the GramJS premium account (`node scripts/gramjs-login.js`, and that
account must actually have Telegram Premium). 💎 Premium status names which of
those is missing.

## The per-chain trending target is a RANGE, rolled

"min 5 max 8 harus random per chain". One fixed `perChain: 5` made every chain
publish exactly the same count for ever — five rows, five rows, five rows —
which reads as a generated list rather than a board.

- **The FLOOR triggers a top-up; the TARGET for that top-up is rolled** in
  [`perChainMin`, `perChainMax`]. A chain at or above the floor is left alone.
- ⚠️ **Re-rolling on every cycle regardless would converge on the maximum.**
  Nothing ever takes a slot away — only expiry lowers a count — so a chain would
  ratchet up to the highest number it ever rolled and stay there, and the
  randomness would be gone within a day. Leaving a chain alone above the floor
  is what keeps two chains on one board sitting at different counts.
- **A stored `perChain` becomes the FLOOR**, never dropped: a stored value beats
  a shipped default, and an operator who set 3 deliberately must not wake up to
  8. The ceiling then defaults to the shipped 8, or to the floor if that is
  higher.
- ⚠️ **`Number(null)` is 0, and 0 is FINITE**, so `clampInt(null, 0, 20, 5)`
  answers 0 rather than 5 — a fresh install came out with a per-chain floor of
  zero, i.e. a board that never fills itself, and nothing errored. The absent
  case is `undefined`. Third time this repo has been bitten by a falsy-but-valid
  number (`Number('')` in the launchpad env reader, `NaN` in `clampNum`).
- **An inverted range (max < min) resolves to the floor**, because the floor is
  the number set to keep the board from looking empty.
- **Every count on the panel is printed against the RANGE** (`7/5–8`), or a
  chain sitting at 7 reads as over target; a pinned range (min = max) prints as
  one number.
- ⚠️ **The MINIMUM outranks `minGainPct`.** With `min +5% 24h` on a flat market,
  Ethereum published 3 rows and Base 2 against a floor of 5: every spare listing
  on those chains was down a percent or two, so nothing was promoted and the
  board just stayed short. The tell was that ⚡ Run now filled it instantly —
  that path ignores the floor. So the gain floor now governs the DISCRETIONARY
  part only (minimum → rolled target); up to the minimum the best available go
  on regardless. `ranked` is sorted by 24h change, so "regardless" still means
  the least-bad ones.
- **…but not at any price.** `FLOOR_FILL_MAX_DROP` (15%) keeps the incident that
  produced the gain floor impossible — the board once carried a token at
  −99.94% on a $1,648 cap. Filling a slot with something in free-fall is worse
  than a short board, which is the one direction this trade-off does not go.
  Unpriced tokens stay exempt, or Robinhood would never fill at all.

```bash
cd bot && node scripts/run-tests.js test/autoTrend.test.js test/autoTrendPanel.test.js   # 53 tests
```

## A board that could only ever be as full as the chain was listed

`ETHEREUM - Trending` published three rows and `BASE - Trending` two, against a
per-chain target of five, reported as *"trending base dan ethereum sangat sedikit
tidak sesuai minimum yang di set"*.

**Nothing was broken.** Auto-trend promotes what is LISTED on a chain, and those
two chains had three and two listings in total. It even said so, every cycle:

```
[autotrend] board below target on ethereum (needs 2, none eligible), base (needs 3, none eligible)
            — list more tokens on those chains, or lower the per-chain target
```

…to an operator who cannot list a token from Telegram. **A diagnosis with no
hands attached is a bug report the code files against its owner**, and it had
been doing it for weeks.

- **`trendFill.fillChain(chain, need)` is the bridge**, and it runs only where
  the promotion pass gave up: the shortfall is now DATA (`gaps`), not only a
  sentence inside `short`. It lists exactly the gap, capped at
  `fillMaxPerCycle` (3) per chain per cycle.
- **`bigCoins.topByMcap()` is the source, and it is deliberately not the
  auto-lister's feed.** That one hunts projects crossing ~$1M for the first time
  and refuses anything over `maxMcapHard` — by design it can never surface PEPE
  or BRETT. Filling a board asks the opposite question, so this ranks the
  chain's biggest tokens instead. Same GT client as everything else
  (`group/gtPairs`, background priority, one shared 429 cooldown): a second
  client would have its own idea of the quota and the buy bot would pay for it.
- ⚠️ **The deepest pool on a chain is usually the MONEY, not a project.** GT
  ranks pools, so the top of any chain is WETH, USDC, wstETH, cbBTC. A board
  whose Ethereum section reads `WETH · USDC · USDT` is worse than one with three
  rows, so `NOT_A_PROJECT` filters them by symbol plus a name prefix for the
  wrapper families (`Wrapped…`, `Staked…`). No substring match on "USD" — that
  would eat every stablecoin-themed memecoin there is.
- **One token, many pools → judged by its DEEPEST.** A real token seen through a
  thin pool reads as illiquid and gets filtered out.
- **`ok:false` and an empty list are different facts.** A 429 must not read as
  "this chain has no big tokens", or the board stays short and the log says
  nothing — the `pumpfunNewX` rule, one service over. `fillChain` reports which
  it was, and "every big token here is already listed" is a third answer again.
- **`autoLister.createFromInfo()` is the one owner of "turn a priced token into
  a listing".** The scan loop owns the discovery BUDGET (per-run, per-day, the
  package rotation, the cooldown memo); the filler has a completely different
  reason to list something and must not grow a second idea of what an auto
  listing is. Both write `everListed`, so a token listed once and deleted never
  comes back free through either door.
- **It lists with the `trending` package**, so the chain that was short is full
  on the same pass — anything else leaves the board short for another cycle, up
  to two hours, which is the state being fixed.
- ⚠️ **`fillMaxPerCycle` is a SPEED, not a cap on the board**, and the very first
  question it drew was *"jadi maksud anda max 3 project per chain?"* — because
  the button read `🧲 max 3/chain`. The board holds `perChain` (🎯); this is only
  how fast a gap closes. The label carries the unit now (`🧲 3/chain/cycle`) and
  the panel does the arithmetic out loud — *"a chain that is 5 short reaches it
  in 2 cycles, about 20–240 min"* — rather than leaving the reader to work out
  which of the two numbers governs what.
- 🧲 **Fill from market is a visible toggle on the Auto Trending panel**, with
  the big-coin floor (`fillMinMcap`, $5M) and the per-cycle rate beside it.
  Turning it OFF is a `show_alert`, because it means a chain with no spare
  listings goes back to publishing a short board silently.
- ⚠️ **A boolean that `set()` does not persist is a toggle that reverts.**
  `fillFromMarket` reached `get()`'s normaliser but not the write list at first,
  so the panel reported ON and the loop kept the old value — caught by the panel
  test, and the same shape as every other setting-that-never-arrived in this
  file.
- ⚠️ **A persisted setting LEAKS BETWEEN TESTS.** One test turning the toggle
  off left every later test reading a panel that said "cannot be filled", which
  looks exactly like a regression in the code under test. The panel helper now
  states it explicitly instead of inheriting it.
- ⚠️ **ONLY a listing shortage may ask for a fill — never the gain floor.** The
  board goes short for two unrelated reasons: the chain has nothing left to
  promote (→ list something), or it has plenty and they are all DOWN (→ the
  `minGainPct` floor working as designed). The first cut fed both to the filler,
  so with `min +5% 24h` set, every chain looks short on any red day and the bot
  would list `fillMaxPerCycle` fresh tokens per chain per cycle, all day, while
  the tokens already listed there sat unused for being down 2%. The gain floor
  and the filler would be fighting each other — and the filler wins, because its
  listings book their slot directly. Found by reading the operator's settings
  screenshot, not by a failing test; `trendFill.test.js` pins it now.

```bash
cd bot && node scripts/run-tests.js test/trendFill.test.js test/autoTrendPanel.test.js   # 25 tests, no network
```

**Config a fix depends on:** nothing — but the filler only runs on chains
GeckoTerminal has a network id for, and it publishes real listings on the site,
so an operator who wants the old behaviour turns 🧲 Fill from market off.

## "Bagaimana agar masalah ini tidak terjadi lagi? Trending minimal harus 5"

Asked after the third report of one symptom — a chain publishing fewer rows than
the operator's minimum — with a different cause underneath each time:

| round | cause | fix |
| --- | --- | --- |
| 1 | the chain had no listings left to promote | the market filler |
| 2 | the filler fired on a red day and would have listed dozens | gate it on listing scarcity |
| 3 | `min +5% 24h` refused every spare, so the board sat under the floor | the minimum outranks the gain floor |

Three fixes, and in all three **the operator was the detector**: they counted
rows in the channel and asked. Nothing in the bot ever said *"Ethereum has been
under 5 for two hours"* — the closest thing was one advisory line at noise level
aimed at somebody reading pm2 logs.

So a fourth cause will turn up, and what is watched now is the **SYMPTOM**, not
the causes: the promise the operator set is that every configured chain carries
at least `perChainMin`.

- **`trendingWatch.js` is the state machine** and it is PURE — the cycle hands it
  a per-chain snapshot, it returns the alerts to send. A test can walk a board
  through days of cycles in milliseconds.
- **Alert on the TRANSITION, after a grace period** (`TREND_SHORT_GRACE_MS`,
  45 min). A chain short for one cycle while a slot rolls over is not an
  incident, and an alert every cycle is a channel nobody reads by the second
  hour — `upstreams.js` had to learn the same thing.
- **A RECOVERY is an alert too**, or a fixed board and a forgotten one look
  identical. A chain that recovers before anyone was told says nothing at all.
- **It repeats** (`TREND_SHORT_REPEAT_MS`, 12h) while the chain stays short: one
  message on day one is scrolled past by day three.
- **The message names WHICH of the causes it is** — spare listings that cannot be
  promoted, a fill that failed with the filler's own reason, or no listings at
  all with the switch that fixes it. "Short" alone sends the reader back into the
  same three-round investigation.
- **`trending:check` asks the same question on demand**, per chain, and exits
  non-zero — because "wait up to two hours for the next cycle and read pm2" is
  not an answer to somebody looking at a short board right now. It prints the
  build stamp for the same reason `fonts:check` does.

```bash
cd bot && npm run trending:check    # per chain: featured / minimum / spares / why
```

**Config a fix depends on:** nothing. `TREND_SHORT_GRACE_MS` and
`TREND_SHORT_REPEAT_MS` exist for an operator who finds 45 min too twitchy.

### A row with a market cap and no percentage

"ADA BEBERAPA TOKEN TIDAK ADA PERSENAN TOKENYA WHY?" — on the pinned board,
`$MOONCOIN | 9,265,672$` with no percentage, and `$BINGBONG` with neither.

Blank is deliberate and stays: **an unreadable change is not a 0%**, and a fake
zero on a board 10,593 people read is a claim nobody measured. What was wrong is
that the reading was given up on too early, in two places:

- **The change came from the DEEPEST pool and nowhere else.** GT sends
  `price_change_percentage.h24: null` for a pool that has not traded in the
  window — a different fact from the pool not existing — so a token whose main
  pool was quiet lost its percentage even when a sibling pool of the same token
  had a good one. `changeFromPools()` borrows it from the deepest sibling that
  HAS one, above `CHANGE_POOL_MIN_SHARE` (a tenth of the deepest pool's
  liquidity). Price, cap and liquidity still come from the deepest pool alone —
  only the CHANGE falls back, and never to a dust pool, because a four-figure
  percentage off a $20k pool is the thing `deepestPool` exists to refuse.
- **`fetchMarket` skipped DexScreener whenever GT had price+cap+liquidity**, and
  `change24h` was not part of that test — so a GT answer with no reading ended
  the lookup even where a second source had one. It counts as part of
  "everything" now. It costs nothing where it cannot help: DexScreener does not
  index the GT-primary chains, so `fetchDS` returns before making a request.

**And the check's first run named a third state, which was a real defect.**
`$BINGBONG` and `$BISKIT` came back *"no market anywhere"* — no GT pool, no DS
pair — so they were on a pinned public board as bare tickers with no percentage
AND no market cap. Nothing could ever have printed there.

- **"No 24h reading" and "no market at all" are different facts**, and the board
  renders them identically. `byGain` records `_priced` alongside `_change` so
  the promoter can tell them apart.
- ⚠️ **The unpriced exemption is narrower than it looks.** Its stated reason is
  that a chain no indexer covers would never fill — so it belongs to a token
  whose READING is missing, not to one with no market. A token with no price is
  now only promoted where **nothing else on that chain is priced either**, which
  is exactly the case the exemption was written for. Both doors honour it: the
  gain-floor pass and the floor fill.
- A priced token down 8% still beats an unpriced one: a real market at a bad
  number is a trending row, and a bare ticker is decoration.

**The board may not explain itself** — an operator diagnostic on a public
channel post is chrome. So the answer is a flag on the check, and it is
MEASURED with the very call the board makes rather than reasoned about:

```bash
cd bot && npm run trending:check -- --rows
```

It separates the facts the board renders identically: *no market anywhere* (no
GT pool, no DS pair) versus *a cap with no 24h reading*. ⚠️ And the second one
does not GUESS between its two causes — the first cut of that line offered the
operator *"its pools have not traded, or the reading was absurd and refused"*,
which are different problems the code knows the difference between.
`changeWhy` records which, including the percentage it refused. It is behind a
flag because it prices every featured row at GT's politeness pace — most of a
minute for a full board.

### …and it was reported again, so the blank itself was the defect

Same screenshot, one round later: `$MOONCOIN | 12,220,809$`, `$RLUSD |
53,093,333$` and a bare `$BISKIT` — *"beberapa token di trending channel mengapa
tidak ada kenaikan atau penurunan %, trending token harus memilikinya"*.

The rule above still holds and is not weakened anywhere below: **an unreadable
change is not a 0%**, and nothing here prints one. What was wrong is that
*honest* and *invisible* are different things — dropping the segment left a row
that reads as broken to 10,593 people, and the recovery had stopped one source
short of where it could go. Four layers, and each closes a hole the others
cannot:

| layer | stops |
| --- | --- |
| `changeFromCandles` in `marketdata.js` | a readable market publishing nothing |
| `hasReading` in `autoTrend.js` | the bot booking a slot for a token with no reading |
| the same rule in `trendFill.js` | the filler *listing* one into that slot |
| `NO_READING` in `trendingPoster.js` | a row that says nothing at all |

- **The change is MEASURED from the pool's own candles when nothing publishes
  one.** A 24h change *is* "the price now against the price 24 hours ago", and
  two real closes from GT's OHLCV is that number taken the long way — a
  measurement, not the fabricated zero this board has always refused. It is the
  last resort: only a token that would otherwise publish a blank pays for the
  request.
- **Most of the leftovers were ROBINHOOD, and that is the whole tell.**
  DexScreener does not index it (`GT_PRIMARY` in `group/gtPairs`), so GT's `h24`
  is the *only* reading in the entire fallback chain — sibling pools and the
  DexScreener pass, the two fixes from the round above, have nothing to work
  with there. A fallback chain reads more reassuring than it is; that lesson is
  already in this file under the raid's two keyless sources.
- **The two closes are picked by TIMESTAMP, never by position.** A sparse pool's
  candles do not line up on 24 neat hours. ⚠️ And a pool that has not traded at
  all in the window resolves BOTH ends to the same candle and measures
  **0.00%** — which is the truth about it, *arrived at* rather than assumed.
  That is the entire difference between this and the printed zero the rule
  forbids.
- ⚠️ **The candles are asked for OUR token, not the pool's base side.** GT's
  OHLCV defaults to `base`, which is our token only by luck — in a
  WETH/OURTOKEN pool it is WETH, and the board would have published Ethereum's
  24h change under a memecoin's ticker. That is a *wrong* number rather than a
  missing one, which is the worse of the two. The token address is named.
- ⚠️ **A pool younger than a day stays unmeasurable.** Measuring from its
  opening tick is exactly where `+521366%` came from, so no candle before the
  boundary means no reading — the sanity bound applies to a computed change as
  it does to a published one.
- ⚠️ **Only a DEFINITIVE answer is cached.** "GT is rate limited" is not a fact
  about the pool, and caching it would let a two-minute backoff blank the board
  for ten. A miss that *is* about the pool (under 24h of history) is cached, or
  every unreadable token buys a request on every cycle of nine background
  pipelines.
- **A slot the bot books ITSELF must carry a reading**, through both doors —
  the promoter's gain-floor pass and its floor fill, and the market filler,
  which books its slot directly and would otherwise make the rule decorative
  (the free-fall bound learnt this one field over). The exemption is the one
  `hasMarket` already makes and is exactly as narrow: only where **nothing** on
  the chain has a reading do the unreadable go on, or a chain no indexer covers
  would never fill.
- **The percentage column is never left EMPTY.** It carries `—` with a legend,
  printed only when a row needs it — the same conditional as the 🌩 mark beside
  it. Everything above exists so that the only row which can still reach it is a
  slot somebody **paid** for, which is never dropped: a customer who bought
  trending gets their row.
- ⚠️ **`trendingPoster` destructured `fetchMarket`**, so no test could pin what
  the board renders for a missing reading — the exact defect being fixed. It
  imports the module now, the rule `autoTrend.js` already states at its own
  require.

#### "bagaimana agar masalah ini tidak terjadi" — the operator was the detector, again

Asked straight after the fix landed, and it is the right question: this is the
**third** time a row on this board has been reported for having no percentage,
and all three times it was reported by a person reading the pinned channel and
counting. Nothing in the bot has ever said *"three rows went out as — this
cycle"*. That is the same shape, on the same surface, as the three-round
"trending minimal harus 5" saga one section up — and the answer there is the
answer here: **watch the SYMPTOM, because the causes keep changing.**

The promise is "every row on the board carries a percentage", and it is now
watched by the same machinery that watches "every chain carries `perChainMin`":

- **`trendingWatch.evaluateRows()` sits beside `evaluate()`, in the SAME
  module.** Two copies of "is the board healthy" would eventually disagree,
  which is what two pump.fun hosts in two processes already cost. It is PURE —
  the poster hands it the render, it returns the alerts — so a test walks the
  board through days of cycles in milliseconds.
- **The poster MEASURES what it drew**, at the moment it draws it. `noReadCount`
  was computed in `buildText` and thrown away; `lastRender()` is
  `{at, rows, blank:[{chain,sym,why}]}` now. A value nobody can read is the same
  as no value — the gainers banner measured its candidate `pool`, returned it,
  printed it nowhere, and a collapsed ranking looked entirely normal.
- ⚠️ **The watch runs BEFORE the `unchanged` early return.** The board is edited
  in place and skipped when the text has not changed, which is exactly the state
  a persistently blank board sits in — folding the watch in after that return
  would freeze it on the boards that stay broken longest. A stuck symptom
  reading as no symptom is the state that looks most like a healthy one, and
  this file has paid for that one twice (`lastFeedOkAt`, `lastCheckedAt`).
- **Transition only, after `TREND_SHORT_GRACE_MS`; a RECOVERY is an alert too;
  it repeats.** A row can go blank for one cycle while a pool rolls over, and an
  alert every cycle is a channel nobody reads by the second hour. The rules are
  `upstreams.js`'s, borrowed a third time.
- **The alert names the TOKENS and the recorded reason**, capped at six. "Some
  rows have no percentage" sends the reader back into the same investigation;
  `changeWhy` already knows whether the pool is quiet, is younger than a day, or
  does not exist — three different answers.
- ⚠️ **`trending:check --rows` now DRIVES `buildText()`** and reads
  `lastRender()`, instead of calling `fetchMarket` itself. That second copy of
  the board's question is precisely how `fonts:check` printed nine green ticks
  over a banner publishing boxes: a guard is only honest while it measures the
  stack the renderer actually uses. It **exits non-zero** on a board of dashes,
  so green means "the board is safe" and not "the counts add up" — and a render
  that produces NO rows is an error, never a quiet ✓.

So the layers, each closing a hole the others cannot:

| layer | stops |
| --- | --- |
| the candle recovery + the two promotion gates | a readable market publishing nothing |
| `NO_READING` in the poster | a blank that is honest and *invisible* |
| `boardPercent.test.js` drives the real renderers | the column drifting back to a dropped segment |
| `evaluateRows` in the running bot | the operator being the detector |
| `trending:check --rows` + the build stamp | a green check over a board full of dashes |

```bash
cd bot && node scripts/run-tests.js test/boardPercent.test.js test/trendFill.test.js   # 50 tests, no network
cd bot && npm run trending:check -- --rows                                             # which rows show — and why
```

**Config a fix depends on:** nothing. `GECKOTERMINAL_API_KEY` raises the shared
GT quota the candle read draws on, as it does for everything else in this repo;
`TREND_SHORT_GRACE_MS` / `TREND_SHORT_REPEAT_MS` govern this watch too.

### ⚡ Run now "not work" — the answer expires, the panel does not

"di klik fiturnya not work". The button spun and nothing came back, on a panel
where every other button responds instantly.

Nothing was wrong with the promotion. `byGain` prices up to **25 candidates
serially**, with a 250 ms gap and an 8 s timeout each — that is ~6 s of sleeping
before a single lookup, and on a chain with dozens of spares (Robinhood had 44)
it runs well past Telegram's **~15 s callback deadline**. `answerCbQuery` then
fails with *"query is too old"*, the `.catch` swallows it, and the operator is
told nothing at all — while the promotion may well have succeeded.

- **A callback answer is the one channel with a DEADLINE.** So it carries the
  acknowledgement, which is bounded, and the RESULT goes on the panel, which is
  a message edit and has none. `alscan` two handlers down already did exactly
  this; `atrun` was the one that did not.
- ⚠️ **A previous round deleted the early "working…" toast** on the rule that
  only the FIRST `answerCbQuery` counts. The rule is true and the conclusion was
  backwards: the fix is to move the RESULT off the answer, not to move the
  acknowledgement later. Both bugs report identically from Telegram — "the
  button does nothing" — which is how the second one was shipped as a fix for
  the first.
- **A slow button invites a second tap**, which would book two slots for one
  request. `atRunBusy` answers the second with "a run is already going".
- **`atref` had the same shape**, one `getListings()` deep. Answered first now.
- The tests DRIVE the registered handler through real Telegraf updates and pin
  the ORDER — that the tap is answered while the work is still running. A source
  scan sees both calls and reads as fine; all four fail on the old handler.

```bash
cd bot && node scripts/run-tests.js test/autoTrendRunNow.test.js
```

### The fourth cause: a spare in FREE-FALL is not a spare

Predicted in the table above ("a fourth cause will turn up") and it turned up on
the first clean run of the check, 19 Aug: `Base 4/5 · 2 spare listing(s)`, and it
would have stayed there for ever.

Both spares were below −15%, so the floor fill skipped them — correct, that is
`FLOOR_FILL_MAX_DROP` doing its job. But `gap()` was gated on the chain having no
spare listings AT ALL, so the market filler was never asked either. Nothing in
the loop could move it: the promoter refuses those two on every cycle for the
same reason, and **a refusal is not a state that resolves itself**.

- **The gate is "can this chain fill the minimum from its OWN listings?"** — and
  a token this pass may never promote cannot. `gap()` is now also raised when
  the floor fill comes up short, for the FLOOR shortfall only. Above the minimum
  `minGainPct` still decides, which is what keeps the red-day listing spree
  (round 2) impossible.
- ⚠️ **The free-fall bound governs BOTH DOORS onto the board.** The filler had no
  such bound, so it would have listed a big-cap down 40% into the slot the
  promoter had just refused a token down 20% for — the rule made decorative by
  the code meant to help it. `autoTrend.FLOOR_FILL_MAX_DROP` is the one owner and
  is passed into `fillChain`; a chain where every big-cap is falling now says so
  rather than reading as "already listed".
- **An unreadable 24h change is not a fall**, on either door. Robinhood has no
  indexer, and judging it by a number nobody can read means never filling it.
- **The filler's own reason outranks the spare COUNT in `diagnose()`.** A chain
  can have both — unusable spares and a fill that then failed — and answering
  "2 spare listings here" over the top of "GT is rate-limited" sends the operator
  off to list tokens by hand for something that clears itself in ten minutes.

### …and its first live run accused the server of its own bug

```
✗ could not read the listings API: INTERNAL_API_TOKEN is not set
```

On a box where it IS set — the bot was listing and trending normally at the
time. `main.js` loads the env before requiring anything, and a standalone script
gets none of that: `config/constants.js` freezes every value at require time, so
the script read an empty environment and reported it as a fact about the server.
**A diagnostic that reads a different configuration from the bot's is a
diagnostic about nothing**, and the failure it invents points the operator at
their own `.env`.

- **`src/config/loadEnv.js` is the one owner**, and it already existed. Nine
  scripts carried four different spellings of the same intent —
  `require("dotenv").config()`, `{ path: bot/.env }`, `{ override: true }`, and
  one `require(".../loadEnv")` with **no call**, which loads nothing and reads
  exactly like it does. So which `.env` counted depended on which script you
  ran, and three of the four never looked at the repo root at all. All of them
  go through `loadEnv()` now.
- ⚠️ **ORDER is the rule, not presence** — and the first cut of the guard test
  got this wrong in the way that matters: it matched `loadEnv()` anywhere in the
  file, and `trending-check.js` has a second, lazy call inside its error path.
  Deleting the real call at the top left the guard GREEN. The assertion compares
  the call's position against the first repo `require`.
- **The failure names the files it READ.** "not set" over a list containing
  `bot/.env` is a missing line in that file; "not set" over an empty list is a
  script that read no `.env` at all. One line separates the two, and it is the
  whole diagnosis.
- `smoke.js` is the one exemption and it is ASSERTED, not declared: it
  fabricates its own tokens so `npm run check` behaves identically on a laptop
  and on the server, and `loadEnv`'s `override:true` would undo that. The test
  fails if it stops setting them.

```bash
cd bot && node scripts/run-tests.js test/loadEnv.test.js
```

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

### Top 10 Spotlight

"saya ingin banner variasi baru lebih premium elegan dari top 1 sampai 10"
(2026-08-21). `grid10` answers *"show me all ten"* with two symmetric compact
panels; `spot10` answers *"crown the winner AND show me all ten"* — the
champion as a full hero card on the left (the podium/duel card grammar: gold
ring, radial seat, the move as the headline figure, sparkline strip,
hairline-split stats) and ranks 2–10 as ONE board panel beside it. The
composition every exchange's weekly-winners poster uses, which is why it reads
premium rather than tabular.

- **The identity rule, scoped the way the podium scoped it.** Every ROW ticker
  is one size (a test pins the call-site count at one); the champion's bigger
  name is not a ranking signal inside that set — it is a different component
  class four rows tall, the relationship `list5`'s title has to its rows.
- **A thin day renders on the layout DESIGNED for that count**: one coin
  delegates to `hero1`'s layout, two to the duel, three to the podium. A
  champion card beside a board carrying a single floating row reads as a
  rendering fault, not a short day — and the ladder already owns the right
  shape for each of those counts. Spotlight proper starts at four, and the
  pack's rows are CAPPED (128) rather than stretched into billboards.
- **The ladder test now pins `[1,2,3,4,5,8,10,10]`** — `spot10` sits last, so
  the menu still reads as a ladder. The admin menu, the random rotation and the
  preview script pick it up from `TEMPLATE_IDS` with no wiring of their own.
- Judged by LOOKING at the renders (n=10, 5, 2, 1), the `drawGem` rule — the
  n=2 delegation exists because the first render of that case was measured
  fine and looked hollow.

### The ladder is COMPLETE, and every banner has its own backdrop

"buatkan versi berbeda top 1 sampai top 10 jadi 10 banner dan backgroundnya
juga beda-beda" (2026-08-21). Two gaps, one promise:

**Counts 6, 7 and 9 had no template**, so the ladder jumped 5 → 8 → 10. Three
new layouts fill it, each a composition of the grammars already in the file
rather than a fourth private idea of a card:

| id | shape |
| --- | --- |
| `tier6` 🏛 | the podium as three crowned mini-cards ABOVE, ranks 4–6 as a board BENEATH — prize-winners over a leaderboard, not six equal cells |
| `crown7` 👑 | the champion as a full-width BAND across the top (the hero card turned landscape), ranks 2–7 as two boards of three |
| `mosaic9` 🧩 | nine compact tiles 3×3 — the cards4 card compressed; a short last row is CENTRED so seven coins read as a finished mosaic |

- **`rankedPanel` is the one owner of "a board that shares its banner"** —
  tier6's lower tier, crown7's two boards and spot10's pack all draw through
  it, so a row-grammar change lands everywhere at once. One row-ticker size,
  pinned by a test against the shared function (which covers all three layouts
  in one assertion).
- **Thin days delegate** exactly as `spot10` does: 1 → hero, 2 → duel, 3 →
  podium; the mixed layouts start at four and their rows are capped, never
  stretched.

**Every template used to sit on the identical aurora**, so a channel posting a
different layout each day still read as the same poster recoloured. `MOODS` is
the fix: each template names a bloom mood — geometry and palette per banner
(`dawn`, `clash`, `stage`, `quad`, `boardroom`, `strata`, `regal`, `beams`,
`nebula`, `terminal`, `laurel`). The scrim, dot grid, vignette, frame and
keyline stay shared, because those ARE the design system and varying them
would make eleven banners from eleven brands. Every colour is a SITE token.

- ⚠️ **Bloom positions alone were re-read as "the same background"** ("saya
  ingin semua banner backgroundnya berbeda-beda tidak sama", one day after the
  moods shipped) — light placement is mood, not identity. So every mood also
  carries a **PATTERN**: visible geometry of its own — sunburst rays (dawn),
  opposing diagonal beams (clash), stage cones (stage), 45° stripes (quad), a
  mint horizon (boardroom), strata bands, a gold halo (regal), vertical beams,
  a deterministic starfield (nebula), CRT scanlines (terminal), concentric
  rings (laurel). Deterministic — no `Math.random`, a re-render must be
  byte-stable — and painted UNDER the vignette so it recedes like everything
  else. ⚠️ The dawn rays' apex sits ABOVE the frame: on-canvas, nine wedges
  stack into one hot spike behind the keyline.
- ⚠️ **Uniqueness is pinned, not trusted**: a test fails if two templates share
  a mood or a pattern, if one has neither, or if a mood/pattern NAME has no
  entry in its table — a typo would silently fall back to the shared default,
  which is precisely the state this exists to end.

### Two calls off the first LIVE renders

- **No chain text on the artwork.** "chain ini hapus aja tidak ada teks chain"
  — the chips and the Chain stats left every banner surface. The caption under
  the post already names the chain and links the token; on the artwork the tag
  was noise beside the name. Footers that led with Chain lead with Price now,
  so no column goes empty. The caption's chain label lives in `gainers.js` and
  is untouched; a note in `gainersBanner.js` marks the removal so the next
  person doesn't quietly add a chip back.
- **The footer tagline joins the microlabel voice.** "Find the next Moonshot"
  was 16px mixed-case display on a `middle` baseline beside a 12px tracked
  uppercase microlabel on an `alphabetic` one — different size, case, face and
  vertical line in a chrome strip whose whole job is uniformity. Both halves
  are one microLabel call each now: same baseline, same size, same tracking,
  split by tone (brand faint, tagline muted).

### Every layout is tellable apart at a glance — the 2026-08-21 rebuild

"saya ingin banner lama berbeda semua dengan banner baru" — the moods pass had
changed only the BACKDROPS, and the seven original layouts still shared one
card grammar between them. Every one was rebuilt so no two banners in the
ladder share a silhouette:

| id | was | is now |
| --- | --- | --- |
| `hero1` | editorial split (text left, avatar at 0.70w) | the MONUMENT — symmetric about the centreline, ghost numerals flanking |
| `duel2` | two equal cards | ASYMMETRIC 57/43 split with a VS medallion on the seam |
| `podium` | three cards, winner taller | the cards STAND ON stepped PLINTHS carrying metal rank numerals |
| `cards4` | 2×2 landscape grid | four PORTRAIT trading-cards in one row, centred columns |
| `list5` | table with sparkline+price columns | GAIN-BAR leaderboard — bar length ∝ the real pct against the day's best |
| `rail8` | two panels of four rows | a film RAIL: two strips of four portrait mini-frames |
| `grid10` | two panels of five | one dense TERMINAL board, ten single-line rows |

- **The lessons survived the rebuild, and the tests moved with the shapes.**
  The podium still carries every rank signal (now seven — the plinth joined
  the list), one ticker size per component set everywhere, figures scale
  ≥1.4×, and the duel's pinned type sizes are unchanged inside the new
  geometry.
- ⚠️ **The podium's sparkline strip became an UNDERLAY** (alpha 0.3, behind
  the figure) — the cards are 70px shorter since the plinths took that height,
  and at strip weight the curve sliced straight through the side cards'
  figures. Found by LOOKING at the render, the `drawGem` rule, again.
- **The plinths are FULL card width** — the first cut inset them 14px and they
  read as buttons under the cards, not pedestals under statues. Same rule, next
  render.
- **`list5`'s bar is HONEST**: length ∝ `pct / max(pct)`, never eased, and the
  widest bar always belongs to rank 1 because gainers.js sorts by the same
  number. A drawn value follows the same rule as a printed one.

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

## "Beberapa token tidak punya logo" — and a guess that outranked the answer

Reported with a screenshot of the board: `$BTCB`, `$SHIB`, `$TRUMP` drawing the
site's `BT` / `SH` / `TP` monograms — the right fallback, and the wrong thing to
have to draw for projects whose artwork sits on four public indexes.

**The monogram was not the bug; the ladder above it was.** `rowToBoardToken`
fills every row's `logoUrl` with `fallbackLogoUrl()` — the DexScreener CDN
CONVENTION, a path we construct and that 404s for anything that CDN has never
seen — and the board then merged live market data with
`logoUrl: t.logoUrl ?? m.logoUrl`. On any chain with a DexScreener id that guess
is never null, so **the `??` could never reach its second operand**: a made-up
path permanently outranked the real `image_url` both GeckoTerminal and
DexScreener were already handing us, and the row rendered a monogram with a good
logo sitting one field away.

- **`pickLogo()` is the one owner of "which logo does this row render".** Four
  rungs, and the order is what the whole section is about: **stored** (an admin
  set it, or the project uploaded it) → **live** (a market provider asserted it
  this cycle) → **resolved** (our own resolver verified it) → **convention**
  (the CDN path, unverified, LAST). A guess must always lose to an answer.
- **`kind` is not decoration.** `"convention"` and `"none"` are how the pipeline
  knows a row is still effectively logo-less and belongs in the resolver's
  queue; without it "has a logoUrl" is true of every row and nothing can ever be
  queued.
- **A live logo is REMEMBERED even though it cost nothing.** GT drops
  `image_url` on the odd cycle, and without that memory the row flickers back to
  a monogram whenever it does.

### The resolver, and why the site has one when the bot already does

`bot/src/services/tokenLogo.js` is the richer resolver (seven sources — it can
reach the launchpads and Trust Wallet) and it is **not** duplicated here in
spirit: the site's is the same idea with the sources the site can reach. What
the site adds is that it runs BY ITSELF. The bot's runs from
`npm run listings:fix`, a script an operator has to remember — and this repo has
already paid for that shape: *"apt-get install is not a fix, it is a request"*
cost six days of banners publishing boxes. A row listed today gets its logo
today, or the monogram comes back with the next listing.

- **Four sources, ordered by how much each KNOWS about the token**: DexScreener
  pair info → GeckoTerminal token → CoinGecko by contract (curated: a human has
  looked at this one) → the DexScreener CDN convention.
- ⚠️ **EVERY CANDIDATE IS FETCHED BEFORE IT IS BELIEVED.** The convention can
  always be constructed and is very often a 404; storing one unverified turns
  "no logo" into "broken image", which is worse — the monogram at least looks
  deliberate. `isImage()` tries HEAD then GET (some CDNs answer HEAD with 405
  while serving the file perfectly well) and refuses a 200 carrying HTML, which
  is what a CDN returns when it does not want to admit a miss.
- ⚠️ **`ok:true, url:null` and `ok:false` are DIFFERENT ANSWERS.** The first is
  "every source answered and this project has no artwork" — the only state in
  which the sweep may remember a miss. The second is "an upstream could not be
  asked", and caching that as "no logo" is how one rate-limited minute leaves a
  token monogrammed for good. `logoFill.ts` keeps them apart: a miss is
  remembered for 12h, an undecided for 30 min — and the 30 min is a RATE LIMIT
  ON US, not a claim about the token, or one dead upstream would eat every
  sweep's budget for ever.
- **CoinGecko is PACED** — one call at a time, 2.5s apart, `Retry-After` honoured
  once. Its free tier is per IP and the bot suite is on the same box; the bot's
  own resolver learnt this when a 429 on row one reported eighty-two rows as
  undecided.
- **The sweep is FIRE-AND-FORGET and bounded** (8 tokens per pass, one pass at a
  time). A board render must never wait on three rate-limited APIs plus a
  verification fetch; logos appear on the next refresh, a minute later.
- **What it finds is PERSISTED** (`setResolvedLogo` → the listing store, mirrored
  to Mongo), so a row is fixed for good rather than for one process's lifetime —
  and the bot's board and channel posts get it too, since they read the same
  store. ⚠️ It can only ever turn nothing into something: an admin-set logo is a
  decision somebody made, and that asymmetry is what makes the write safe from a
  background sweep nobody is watching. The rule is a PURE function
  (`lib/logoWrite.ts`) because "never overwrites" is a mutation property and a
  source scan cannot tell a guard from a comment about one.
- **`coingecko` joined the chain registry.** Nothing outside `config/chains.ts`
  may hardcode a chain id, and a new chain now has to decide rather than inherit
  `undefined`. A wrong platform id costs one source (a 404) and never a failure.

### …and the proxy was refusing logos we already had

`/api/logo` exists because CDNs hotlink-block, and its allowlist is therefore
part of "every token has a logo", not only of security: **a host missing from it
is a real, working logo url rendered as a monogram** — refused by us, silently,
with nothing in the UI to say so.

- **`ipfs://` was handed to the browser verbatim.** No `<img>` anywhere loads
  that scheme, so a token whose artwork we HAD still drew a monogram. `logoSrc`
  now routes every non-relative scheme to the proxy, which rewrites `ipfs://` to
  a gateway.
- The allowlist carries where token artwork actually lives: the two indexes, the
  curated ones, the wallets' asset repos, and the IPFS/Arweave gateways every
  launchpad mints through (pump.fun's own is `pump.mypinata.cloud`).
- ⚠️ **Redirects are followed BY HAND, and every hop is re-checked.**
  `redirect: "follow"` hands the guard's whole job to the upstream: an allowed
  host answering `302 http://169.254.169.254/…` would have this server fetch its
  own cloud metadata and serve the bytes back.
- An SVG is a DOCUMENT when opened directly and can carry script. Refusing SVGs
  would drop real logos, so they are served inert instead (`nosniff` + a CSP
  that lets the file reference nothing).

```bash
npm test    # tokenLogo / logoFill / logoWrite / logoPipeline — 60 tests, no network
```

**Config a fix depends on:** nothing. `CG_MIN_GAP_MS` widens the CoinGecko gap
if that box ever needs it.

## "Token harus punya chart candle bar" — the chart was a hash of the ticker

The token page had two chart states and both had to go.

With a pool address it embedded **GeckoTerminal in an iframe**: charts fine, and
it is someone else's page inside ours — another brand's type and colours, its own
spinner, and no way to read one number out of it for anything else on the page.

Without one it drew `syntheticTrend(symbol, chg24h)` — **a curve generated from
the ticker's hash** — full width, under the words "Price trend". On a 34px
sparkline that is decoration. At 640×120 on the page a person opens to decide
whether to buy, it is a claim about a market that nobody measured, and this repo
refuses a printed `0.00%` for an unreadable change. A drawn price history is the
same lie with more pixels.

`/api/ohlcv` + `components/CandleChart.tsx` replace both: real candles, volume,
five timeframes, a crosshair readout, in the site's own type and colour.

- ⚠️ **The candles are asked for OUR TOKEN, not the pool's base side.** GT's
  OHLCV defaults to `base`, which is our token only by luck — in a WETH/OURTOKEN
  pool it is WETH, and the page would draw Ethereum's chart under a memecoin's
  ticker. That is a WRONG number rather than a missing one, which is the worse
  of the two. The bot's `changeFromCandles` names the address for the same
  reason.
- **A 404 is an answer about the pool; a 429 or a dead socket is not.** Only the
  first is cached — caching the second would let a two-minute backoff blank every
  chart on the site for the TTL.
- **A caller's pool address is a HINT.** The token page passes the pool GT named,
  but a preview built from DexScreener carries a PAIR address GT has never
  indexed, so a 404 on the hint sends us to resolve the pool GT does know.
- **`topPoolAddress` is the ONE owner of "which pool do we chart?"** — `/api/pool`
  and `/api/ohlcv` both need it, and two copies would drift into two
  plausible-looking pool addresses with nothing to say which is right. It picks
  the DEEPEST pool, never whichever the upstream listed first: a token seen
  through a thin pool reads as a different asset.
- **"No pool indexed yet" and "we could not read it" stay different sentences.**
  An empty grid gives the reader the same reaction to both.
- **A poll that fails never blanks a chart that is already drawn.** The pool did
  not stop existing because one request did not land.
- **`normalizeCandles` is pure and sorts by timestamp**, drops zero/negative
  prices (one zeroed close flattens every real candle beside it), keeps a zero
  VOLUME (a quiet 5 minutes is a fact), refuses a future stamp, and widens a wick
  to contain its own body rather than clamping the body — every reported number
  stays visible.
- **Every drawn number is measured over the window that is DRAWN.** The visible
  window narrows to what fits (160 candles across a phone's 330px plot is a 1.6px
  body — a smear), so the percentage is computed over the same candles, and it is
  labelled `over 40h`: the page header carries a 24h figure directly above it.

### It is judged by LOOKING at it, so there is a script that renders it

Three defects got through the unit tests and a source scan, and all three were
found in a PNG: a price label sitting under the last-price tag, a phone window
smeared into unreadable bodies, and — the one worth remembering — a time stamp
clipped to a **wrong time**, `3:46` for `23:46`.

⚠️ **A CSS declaration beats an SVG presentation attribute.** The renderer sets
`textAnchor` per label so the first and last stamps stay inside the plot;
`.ck-axis-x{text-anchor:middle}` in the stylesheet silently overrode it. The
stylesheet no longer states an anchor, and a test fails if one comes back.

```bash
npm run build && npm start &
npm run chart:preview     # every chart state, rendered and checked; non-zero on failure
```

It stubs the upstreams IN THE BROWSER, so it runs on a box with no egress —
including the empty and unreadable states, which are the two nobody remembers to
look at. ⚠️ The context must block service workers: a SW-served request never
reaches the stub, and the second page load would quietly chart whatever the real
server said.

**Config a fix depends on:** nothing. `GECKOTERMINAL_API_KEY` is not read by the
web app; the chart shares the same free quota as the rest of the site, which is
why each timeframe caches for its own interval and the client polls no faster.

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
  the panel (`draft.kind`); switching kinds clears the address (shape-valid
  both ways, semantically wrong both ways), and ⚡ arms a dev target through
  `addCopyTarget` ('launches'), discriminated by `mode === 'launches'` on the
  return.
- **The dev rows are honoured BEFORE they are shown.** "berapa banyak wallet
  serta slippage … auto sale tp dimana fiturnya" — `_followerBuy` honours the
  per-target wallet selection, per-target slippage (replaces the user's
  normal bound, same contract as the CA snipe) and TP/SL that become real
  orders at each fill, at the realised entry, on the buying wallet — so the
  dev panel carries Wallet · Slippage · TP/SL rows. Expiry stays hidden (a
  copy target does not expire).
- **The wallet row is a MULTI-SELECT, the buy/sell picker's model** ("bisa
  pilih multi wallet, all on atau all off, sama kaya beli"): toggles per
  wallet, ✅ All on ('*', resolved at fire time), ⬜ All off. The draft and
  the targets carry `walletIds` ('*' | array; one id collapses to the plain
  `walletId`); the amount is PER wallet and the panel + armed message state
  the multiplied total. A multi-wallet DEV fill records one exit-mirror LEG
  per wallet (`holding[token].legs = [{wid, own}]`) and `copyExitCycle` sells
  every leg from the wallet that bought it, from ONE balances sweep — selling
  one bag and stranding the rest would be the stop-loss-the-user-believes-
  exists, per wallet. The fan-out is budgeted WHOLE (N × buyEth claimed
  before the buys; fit whole or skip whole) and only clear failures are
  rolled back — a broadcast leg stays committed and its leg records `own: ''`
  so the mirror refuses to guess with it.
- ⚠️ **The dev budget is priced per LAUNCH, not per wallet.** `_followerBuy`
  fits the whole fan-out or skips it, so a budget that covers one wallet but
  not the selection armed cleanly and then skipped every launch **silently,
  for ever** — the inert-watch failure, arrived at by arithmetic. The floor
  (`addCopyTarget`, `updateSnipeDraft`) and the ten-buys default are both
  multiplied by `copyFanOut()`, and the panel's budget quick-picks are
  multiples of one LAUNCH. A budget row and a wallet row that disagree is a
  target that can never fire.
- **A multi-leg exit leaves the ledger one leg at a time.** Dropping the whole
  record before the first sell is right for ONE leg (a crash mid-sell must not
  let the next cycle sell it twice) and strands the rest, whose sells never
  started: `copyHoldingSet()` rewrites the record with the untouched legs
  before each sell. A leg whose sell was **broadcast** is never retried — the
  buy path's rule, for the same reason — and says so.
- **"Nothing was sold" may not follow a sale.** The never-recorded notice is
  emitted per POSITION from a per-LEG loop, so on a mixed record (one leg
  filled, one only broadcast) it landed one message after a real exit. It
  names the wallet instead when siblings sold.
- **The armed sentence's cadence belongs to the FEATURE, not to the
  selection.** A CA snipe fires once (`snipe.panel.armed_wallets`, "in
  total"); a dev snipe fires on every launch (`dev.armed_wallets`, "per
  launch"). Keyed on `'*'`-vs-subset instead, the one-shot wording landed on
  the recurring watch. `walletScopeLine()` is the one renderer.
- **Every standing screen carries the multiplier.** `caSnipeScreen`'s armed
  rows and `copyScreen`'s target rows print `× N`, or a 3-wallet target reads
  as spending a third of what it does on the screens where a user audits it.
- **The dev budget is a CAP with a default, not a question** ("fitur yang tadi
  hapus aja"): unset, `addCopyTarget` defaults it to 10× the per-launch amount
  — an uncapped auto-buyer is the "buy ngasal" hazard class, so the cap
  survives the question's removal, and the panel row + armed message state the
  concrete number. The dev flow is two questions total (wallet → amount), and
  a re-pasted dev wallet re-asks the amount even when a stale one is set — the
  spend is confirmed per target.
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
- **A wallet toggle must not pay for a market scan.** "pilih wallet tidak
  working... harus cpt": the card's multi-wallet picker redrew the WHOLE card
  per tap — the price/liquidity/safety scan, a meta read and a balance PAIR per
  wallet, ~22 network calls to change one bit, seconds each on ten wallets. A
  toggle changes which wallets are lit and nothing a network read would tell
  us, so it redraws from `_cardReuse` (the last FULL render, `CARD_REUSE_MS`,
  20s, `0` disables). ONLY the toggle path passes `reuse` — a fresh open, a
  chain switch and 🔄 Refresh always read live, a stale price being acceptable
  only when the user did not ask to look again — and only a live pass seeds the
  cache, so reuse cannot chain off reuse. A trade drops the entry
  (`invalidateCard` in `doBuy`/`doSell` and at `startMonitor`): the bag is the
  one number checked right after a fill.
- ⚠️ **The poll loop does not await `handleUpdate`, so a run of taps is
  CONCURRENT.** Both pickers redraw one message, and whichever render finished
  last painted it — not necessarily the newest tap, so the wallet just lit went
  dark a second later. That is indistinguishable from a toggle that does not
  work, and is how it was reported. `redrawTicket(chatId, mid)` gives each tap a
  ticket and a stale render is DROPPED rather than painted. Any handler that
  redraws one message from concurrent taps needs it.
- **"respon sangat lambat" is measured, not argued.** `handleUpdate` logs
  `[ui] slow cb:… handle=…ms age=…s` for any update that took >1.5s to handle
  or was already >5s old on arrival — high `age` means the delay happened
  BEFORE the bot (long-poll gap, restart backlog, Telegram); high `handle`
  with low age is ours. The path label comes from callback data or the pending
  action, NEVER from message text — the import-wallet step is a private key in
  a plain message. The first thing the measurement's reasoning found: the
  WALLET dashboard (the screen `/start` ends on) awaited wallets × chains
  balance reads at 6s-per-read against public RPCs, and THEN priced the token
  bags — a single throttled endpoint held the screen for its full timeout,
  twice over. The reads now cap at 2.5s (the ≤10-min last-known cache absorbs
  the misses — that is what it is for) and the two waves run concurrently.
  The header also answers the two questions it was asked ("harus ada jumlah
  solananya brp dan total itu dalam token apa aja"): the On-<chain> line
  carries the native amount beside the USD, and a `Coins:` line decomposes the
  Total by symbol; the token share keeps its `incl. … in tokens` line.

```bash
cd tradebot && node --test snipeTarget.test.js   # 29 tests, no RPC
cd tradebot && node --test snipePanel.test.js    # 20 tests, no network
```

**Config a fix depends on:** nothing. Every knob has a working default.

## "Did I make money on this one?" — the question /portfolio cannot answer

A position record survives being sold to zero (it carries the lifetime
`ethIn`/`ethOut`), but every screen that could read it dropped closed rows:
/portfolio lists what you are EXPOSED to, so the moment a trade ended well it
left the bot's memory as far as the user could see. `/pnl` is the other
question — what a token MADE — and it answers it for a bag still held, one
already sold, and the half-of-each in between.

- **`core.tokenPnl(chatId, ca, chain)` is the one reader**, across every wallet,
  on the chain the ADDRESS says — a pasted mint answered against the active EVM
  chain would report "no trades on file", a false statement about the user's own
  money and the same wrong-chain bounce the snipe flow had to be rescued from.
- **The money view is the headline**: `back − in`, where back is proceeds plus
  what is still held. It needs no basis accounting to be true and is checkable
  against the wallet. `realizedEth` and `unrealizedEth` sit under it as the
  breakdown — a half-sold bag makes the two views differ, and hiding that is how
  a card prints "3.99x" directly above "PnL +0.0000".
- ⚠️ **A BALANCE we could not read is not a balance of ZERO.** The first cut
  used `.catch(() => 0n)`, so one RPC blip rendered a bag the user still fully
  holds as **🏁 CLOSED, −100%** — the /portfolio price lesson one field over, and
  worse here because this is the card people screenshot. `tokenBalanceOrNull`
  (the function that stopped the monitor unpinning live bags) is the read, one
  unreadable wallet marks the whole answer unknown, and the card names WHICH
  read failed: "couldn't read your balance" and "couldn't price it" send the user
  to different places.
- **Three states, and the middle one is why this exists**: HOLDING · PARTLY SOLD
  · CLOSED. Calling a partly-sold bag either of the other two misstates the
  exposure.
- **A token never traded here gets "no trades on file"**, not a zero trade — and
  if the wallet holds some anyway (sent in, or bought elsewhere), it says so and
  says there is no cost basis to measure against.
- **The book leaves an unpriced row OUT of the total** and says how many it left
  out; summing an unknown as zero is the same lie one level up. Bounded by
  `PNL_BOOK_MAX` (24) and read CONCURRENTLY — a book of thirty tokens read
  serially is the wallet-dashboard mistake over again.
- `pnl.js` is a PURE renderer (no I/O, no `core`), the `receipt.js` contract, so
  the tests call the arithmetic instead of reading telegram.js with a regex.
  That is what caught `−-0.75000` (the sign printed twice) before it shipped.

Ways in: `/pnl` (the book) · `/pnl <ca>` · 📊 PnL on the token card — so a
pasted contract is one tap from its own card — · 🔎 Paste a contract from the
book · 📊 PnL on the main menu.

### "terlalu spam", and the share of supply (2026-08-18)

The first live card came back with two notes. **The template read as spam** —
ten body lines, one emoji each — so the body carries no emoji now (the verdict
dot and the status glyph are the colour), status and trade tally share a line,
invested and taken-out share a line, and the name subtitle only prints when it
differs from the ticker (an unnamed launch has both set to the short CA, and
printing it twice was the first line of the report). ⚠️ **Removing the emoji
removed the only thing separating the lines**, and the next report was the
opposite complaint — "harus ada spasinya tulisan" about five dense lines. The
body is GROUPED with blank lines now: what the position is, what it cost and
holds, then the detail. Density is a layout problem, and stripping ornament
without replacing the structure it was accidentally providing just moves it. **And a holding must say
what share of the token it is** ("harus ada berapa % dari supply"):

- **`core.tokenSupplyUi(ca, chainKey, dec)`** is the one reader — cached 10
  min, `null` (never 0) when unreadable, and on an EVM chain with unknown
  decimals it answers null rather than guessing 18, which would state a share
  off by orders of magnitude.
- **`pnl.share()` is the one formatter** — pnl card, monitor and receipts all
  import it, so three surfaces cannot drift into three formats. Below display
  precision it says so rather than rounding a real position to nothing.
- ⚠️ **That "below precision" string was `<0.01%`, and a bare `<` is not a
  tag.** With `parse_mode: HTML` Telegram rejects the WHOLE message — 400
  "can't parse entities" — and a 400 is an ANSWER, so `queuedSend` does not
  retry it. The receipt, the monitor card and the PnL card would each have
  simply vanished for any ordinary buy on a large-supply token (0.01% of 1B is
  100k tokens), and the one owner meant it shipped to all three at once. It is
  `&lt;0.01%` now. The "callers pass pre-escaped values" contract covers
  caller-supplied text (`sym`, `name`); a literal this module GENERATES is this
  module's to make safe, and a test strips every real tag and fails on anything
  `<` left behind.
- It rides the PnL holding line (`supplyPct` on `tokenPnl`), the monitor's
  "You hold" line, and the per-wallet receipt's ok line (through i18n —
  "of supply" has an Indonesian spelling too). Every read is bounded so the
  share can never hold a receipt or a card.

### The card is a PICTURE, and it draws through canvasKit

A PnL card is a thing traders SHARE, and nobody posts a screenshot of a wall of
numbers. `pnlImage.js` renders the same figures — from the same `pnlStats()` —
as a 1200×675 PNG: the token's coin on the left, the PROFIT/LOSS word and the
percent huge (it is what a trader says out loud), INVESTED / PAYOUT in a glass
panel, and the brand strip with the referral QR along the foot.

- **The layout is the one traders share**: the token's own artwork on the left
  in a glowing ring, `$TICKER` with a `4.25X ↑` badge, "Held for", the percent
  at 138px, INVESTED / PAYOUT, and a brand strip with the referral QR.
- **NO LOGO IS THE DESIGN, not a degraded card.** A token this bot snipes at
  launch has no art at any index yet, so the fallback — the DEXVRA MARK itself
  (drawBrandMark, alone and centred; the owner's calls: "kalo project ga punya
  logo pake logo dexvra sendiri", then "name ticker di logo hapus aja") — has
  to look deliberate, because it is what most cards will be. The token's
  identity lives in the $TICKER headline, not on the coin. `core.tokenLogoUrl` asks the two indexes this repo already asks
  (DexScreener's `info.imageUrl`, GeckoTerminal's `image_url`) and caches the
  MISSES too; the logo and the QR are fetched together, bounded, and either may
  fail without touching the card.
- **It draws through `bot/src/helpers/canvasKit`** — the module that already
  owns the brand palette, the primitives, the FONT FALLBACK CHAIN and
  `warnBoxes()`. A second copy of the font logic in `tradebot/` would be the
  `$???` outage waiting on a second process. The card imports the colours; it
  does not retype the hex.
- ⚠️ **`drawGem`'s (x,y) is the TOP-LEFT of a 48-unit box, not the centre.**
  Passing the centre puts the gem half a diameter down and right — through the
  monogram it was drawn beside. Caught by looking at the render, not by a test.
- ⚠️ **Never zero-pad a native amount.** To an Indonesian reader — much of this
  bot's audience — `1.200 SOL` IS 1,200 SOL: the dot is their thousands
  separator, so `toFixed(3)` put a three-orders-of-magnitude misreading on the
  card's headline surface. `short()` trims, and the panel's two rows share ONE
  decimal count (`0.80 / 4.10`) and ONE USD voice (`$240 / $1,020`, or both
  abbreviated) — two formats in one column reads as two data sources.
- **Everything that can grow is FITTED.** The meta line crossed the frame
  stroke on the one status long enough to reach it ("Still holding"); the
  medallion cut `BEHEMOTH99` to a mid-word `BEHE`; the 44px badge outweighed a
  ticker `fitText` had shrunk to 33px. The line is fitted, the medallion
  shrinks the whole ticker (and drops to one letter below the floor, never a
  cut), and the badge scales with the ticker's FITTED size, read back off
  `ctx.font`.
- **The QR is fetched at the size it is drawn, and drawn 1:1** with smoothing
  off — resampling is what blurs a QR's modules into an unscannable smudge.
- These came from a three-lens review of the actual renders (typography,
  composition, premium) — the card is judged by LOOKING at PNGs, the rule the
  drawGem bug already taught. Render fixtures before shipping a layout change.
- **The picture is an UPGRADE and failure is free.** The native binary lives in
  `bot/node_modules`; if it is missing, or a draw throws, or the upload fails,
  `render()` returns null and the caller sends the text card it already had. A
  picture may never be why a user cannot see their PnL.
- **An image cannot say "we could not read it just now".** A branded card is a
  CLAIM, so anything unknown — an unreadable balance, a never-traded token,
  nothing invested — refuses to draw and falls back to the words.
- **A tile's label may not contradict its sign.** It reads LOSS on a loss, not
  PROFIT showing −1.58 — the buy card's two ideas of "whale", in miniature —
  and `· OPEN` while the bag is still held, because that money is not banked.
- Bytes need MULTIPART: `sendPhoto` posts JSON and can only carry a URL or a
  file_id, so `sendPhotoBuffer` uploads the PNG the way the store backup does.
  A photo cannot be edited into a text message either — the 📊 button SENDS.

```bash
cd tradebot && node --test pnlCard.test.js   # 19 tests, no network
```

**Config a fix depends on:** nothing for the text card. The PICTURE needs
`@napi-rs/canvas` present in `bot/node_modules` (it is, wherever the banner bot
runs) — `cd /opt/dexvra/bot && npm install` if a box ever lacks it. Until then
`/pnl` answers in text, which is the designed fallback and not a failure.

## "Delete wallet EVM tidak bisa karena ada saldo Solana" — and the withdraw it sent you to do could never work

Two screenshots, one report (2026-08-21). The first:

```
❌ this wallet still holds 2.15713 SOL on Solana — withdraw it (or export the key) first.
```

…from someone trying to delete what they thought of as an EVM wallet. The
second, from following that instruction:

```
❌ Simulation failed.
Message: Transaction simulation failed: Transaction results in an account (0)
         with insufficient funds for rent.
```

**They are the same defect from both ends.** The guard sent the user to withdraw,
and withdrawing did not work, so there was no sequence of taps that removed that
wallet. The user's own reading — *"privatekey kan beda2"* — is right about the
keys and was never anywhere on screen.

### `max` on Solana had never worked, and the arithmetic says so

Solana refuses to leave an account holding **more than nothing and less than the
rent-exempt minimum** (~890,880 lamports). `_withdrawSol` kept a `feeReserve` of
**10,000 lamports** behind, of which the fee spends 5,000 — so every sweep this
bot has ever offered landed on ~5,000 lamports, i.e. squarely inside the one band
the runtime rejects. Arithmetically certain, not unlucky, exactly like the
`POS_RUG_DROP` false alarm one section up.

- **A sweep lands on the balance EXACTLY.** Zero is a legal place to leave an
  account (it is purged and reappears on the next deposit); a dust remainder is
  not. So `max` is `bal − fee`, and the fee is **measured** against the message
  that gets signed (`getFeeForMessage`), not assumed from a per-signature
  constant. A guessed reserve is what produced this.
- **The floor is READ from the chain** (`getMinimumBalanceForRentExemption(0)`),
  cached per connection. It is a cluster parameter, not a constant in this repo.
- **A partial amount can walk into the same band from the other side**, so the
  remainder is checked and refused **with the two amounts that would work** —
  `max`, or the largest amount that keeps the wallet rent-exempt. The old code
  sent it and let the simulator do the explaining, and what it explained was
  "insufficient funds for rent".
- **A rent-paying account may still be swept clean** (shrinking one is allowed),
  or someone sent 0.0005 SOL would be locked out of their own dust.
- ⚠️ **A swept Solana wallet cannot pay the fee to move an SPL bag afterwards.**
  Said on the confirm screen, before the tap. EVM keeps its gas reserve behind,
  so this is Solana-only.

### The EVM reserve was computed from a different fee than the one signed

`withdraw()` reserved `getFeeData().gasPrice × gasLimit × 2` while `rawSend` went
on to sign `gasOverrides().maxFeePerGas` = `base×2 + a per-chain tip FLOOR`. The
read that produced the reserve — `gas.gasPrice` — **is undefined on every 1559
chain**, i.e. everything but Robinhood. On Ethereum the 2× multiplier hid the gap;
on Base, where a 0.005 gwei tip floor dwarfs the base fee, the reserve came out
several times too small and the node refused the transaction outright.

- **One fee object, reserved against and signed with.** `opts.fee` has existed on
  `rawSend` for exactly this — *"the fee quoted during preflight is the fee
  actually signed"* — and the withdraw path was the one write that did not use it.
- ⚠️ **The L1 data fee is a THIRD term in an OP-stack node's balance check**
  (`value + gas × price + l1Cost`) and nothing here accounted for it, so a sweep
  that left exactly the L2 cost behind was short by the L1 fee. `_l1DataFee`
  prices it off the GasPriceOracle predeploy and **discovers** whether a chain has
  one (`getCode`) rather than carrying a list — the rule `v4.js` follows for the
  PoolManager. Arbitrum and Robinhood need nothing: Nitro folds L1 into the gas
  UNITS, which `nativeTransferGas` already estimates.
- **Round toward reserving too much.** Over-reserving sends slightly less than
  everything; under-reserving does not send at all.
- `solWithdrawPlan` / `evmWithdrawPlan` are **pure** — bigints in, a decision out
  — the `pnl.js` contract, so the rule that broke every sweep is tested without a
  validator or an RPC.

### A wallet ROW is two keypairs, and the UI never said so

`enc` is an EVM key and `solEnc` a Solana key, under one label. Removing "the EVM
wallet" removes the Solana one with it — which is why a SOL balance blocks it, and
which nothing on any screen stated.

- **`core.walletFunds()` is the one survey**, read by the guard *and* by the
  screen, so a refusal and the screen it lands on can never disagree about what is
  in there. Read CONCURRENTLY: the old guard was a serial `for` loop, so a
  throttled public RPC cost one full six-second timeout per chain before anything
  could be said.
- **The refusal carries `err.holdings`, and the screen puts hands on it** — one
  📤 button per chain that actually holds something. The old refusal named
  whichever chain the loop tripped on first and offered nothing to tap; withdraw
  was active-wallet-and-active-chain only, so acting on the sentence meant
  switching wallet, switching chain, and finding the button again. *A diagnosis
  with no hands attached is a bug report the code files against its owner*, and
  this one had been filing it since the guard was written.
- **`opts.force` exists, and is reached only from a second confirmation that
  names every amount** — then hands over both keys BEFORE removing, so the funds
  stay reachable. A failed export must not be followed by a removal.
- ⚠️ **`exportKeyMsg` used to export whichever half matched the ACTIVE chain**
  and print a note telling the user to switch 🌐 and come back for the other.
  Anyone following the removal advice from an EVM screen got the EVM key, deleted
  the wallet, and had nothing for the SOL on the other side of the same row. **A
  note is not a safeguard when the next tap is destructive.** Both keys, always.
- **`ok:false` is not a zero.** An unreadable chain does not block removal (the
  key is archived, and a flaky public RPC must not trap an otherwise-empty
  wallet), but it is REPORTED rather than rendered as an empty balance.
- **A withdrawal spends the wallet and chain it was OPENED on.** `walletId` and
  `chain` ride the pending step; re-deriving them from the active chain at each
  step is how a Solana withdrawal opened from an EVM screen bounced as "not a
  valid Ethereum address" — the same wrong-chain dead end the snipe flow had to be
  rescued from. 📤 is now on the per-wallet deposit screen too: emptying Wallet 9
  used to mean switching to it first, with the switch on the same screen as the
  button that needed it.
- **A swept wallet's receipt says it is empty.** That is the errand the sweep is
  usually part of, not a footnote.

### The audit round — four of these were in the FIX

Asked "apakah anda yakin?? coba audit kode" straight after the above landed, and
the answer was no. Every one of the defects found is this file's own recurring
shape — **a failure rendered as a fact** — reintroduced by the code written to
stop it.

- ⚠️ **`getCode(ORACLE).catch(() => '0x')` cached a failed read as "this chain
  has no L1 fee".** One transient 403 or timeout on the first EVM withdrawal
  disabled L1 accounting on Base for the life of the process, silently, on the
  exact path where being short by the L1 fee means the withdrawal does not send.
  Only a read that ANSWERED is cached now, and `_l1DataFee` returns
  `{fee, ok, oracle}` — a read that failed reserves the L2 cost as a stand-in,
  never zero.
- ⚠️ **A survey that did not happen rendered as an empty wallet.** The removal
  screen swallowed a thrown `walletFunds` into `funds = []`, which took the
  "empty of native on every chain I could read" branch and offered a one-tap
  ✅ Remove. `surveyed` is now its own state with its own copy and its own
  button.
- ⚠️ **…and fixing that created a BOUNCE LOOP.** The unsurveyed screen's only
  forward button is `rmwf`, and `rmwf` sent anything with no holdings back to
  the screen — so an unreadable wallet ping-ponged between the two for ever and
  could never be removed. Three states, not two: *held*, *surveyed and empty*,
  *not surveyed*.
- **`Promise.all` rejects on the first throw**, and resolving a Solana address
  derives a keypair — so one wallet the derivation could not handle turned the
  per-chain `ok:false` this function promises into an exception out of the whole
  survey.
- **A callback could name a DISABLED chain.** `chainOf` answers from the whole
  table; `core.setChain` throws on `isEnabled`, and this path now checks it too.
- **The keys-then-remove gate needed the reason, once.** A thrown `exportKeyMsg`
  sent its own ❌ and then a second generic one on top of it.

And one coupling that is not a bug yet, guarded so it cannot become one quietly:
the sweep lands on the balance exactly, so `transferFee` and `sendSol` must price
and sign **the same message**. They do because both build a bare
`SystemProgram.transfer`; a test fails if either grows a second instruction,
because a priority fee on one side alone puts `max` straight back into the
rent-paying band.

```bash
cd tradebot && node --test walletWithdraw.test.js   # 36 tests, no network
```

⚠️ **The OP-stack L1 fee read is the one thing not verified against a live
node** — the sandbox this was written in cannot reach a Base RPC. The code fails
safe (a read that does not answer reserves the L2 cost rather than zero), but
the first real sweep on Base is worth watching, and `getL1Fee`'s answer is worth
printing once.

**Config a fix depends on:** nothing. Note that `ENABLED_CHAINS` does not ship
with `solana` in it — the two-keypair half of all of this only exists where an
operator has added it.

## "Kirimnya harus seed phrase bukan hanya privatekey"

Asked after the removal screen shipped, looking at a card offering two private
keys for one wallet. It is the right question, and the answer was a real gap.

**Every wallet this bot generates is born from a mnemonic** —
`ethers.Wallet.createRandom()` has one, and it is what derives the Solana key on
Phantom's own `m/44'/501'/0'/0'` — and `_newWallet` **computed it, used it, and
threw it away**, persisting only `encrypt(w.privateKey)`. So the bot handed out
two unrelated-looking keys for a wallet that had a single phrase behind it, and a
private key cannot be run backwards into the mnemonic it came from.

- **`mnemEnc` is stored for every new wallet — generated AND imported.** That is
  the owner's explicit call, taken with the trade-off stated: ⚠️ a phrase is
  strictly more dangerous to hold than a key. A key controls one address; a phrase
  derives an unbounded number across many chains, so for an IMPORTED phrase this
  stores something that may also control wallets this bot has never seen. Both
  confirm screens say so, and nothing prints a phrase without one.
- ⚠️ **It cannot be applied retroactively, and the copy must not imply it can.**
  Every wallet made before this has no phrase and never will. Neither does one
  imported from a bare private key. `exportMnemonic` answers **null** for both —
  the ordinary case, never an error — and the export SAYS *"this wallet has no
  seed phrase"* rather than leaving a blank, because a blank reads as a bot that
  forgot to print it and sends people hunting for something that does not exist.
- **The phrase leads, the two keys stay.** One import restores both sides; not
  every app takes a phrase, so the keys remain underneath with a line saying they
  are one wallet, one side each — the misreading the whole report was built on.
- **`mnemEnc` is archived on removal** with `enc`/`solEnc`. Archiving the keys
  and dropping the phrase would make "export before you delete" quietly hand back
  less than the wallet had.
- **The claim on the card is PROVEN, not asserted.** `walletWithdraw.test.js`
  derives Phantom's `m/44'/501'/0'/0'` and MetaMask's BIP44 account 0 from the
  exported phrase and compares them against the bot's own two addresses. A
  wallet whose Solana side came from the EVM-key path
  (`sha512('robinfun:solana:v1' + key)`) has no phrase precisely because that
  derivation is not reproducible by any standard wallet — which is why the two
  cases must never share a message.

```bash
cd tradebot && node --test walletWithdraw.test.js   # 42 tests, no network
```

**Config a fix depends on:** nothing.

## "Bisa withdraw semua wallet tapi dipilih dulu chainnya apa"

📤 Withdraw (active) only ever spent the ACTIVE wallet on the ACTIVE chain, so
emptying ten wallets was twenty screen switches. `withdrawMany` is the same
withdrawal over a SELECTION: **chain → wallets → address → amount → confirm.**

- **Chain FIRST.** The rule the snipe panel had to be rescued into — a flow bound
  to whatever chain happened to be active is how a Solana address pasted on an
  EVM screen bounces as "not a valid address" with the fix two screens away.
- ⚠️ **The rate limit is charged ONCE for the whole sweep.** `MAX_WD_PER_HOUR`
  defaults to 10 and a full account is 10 wallets, so charging per wallet would
  let one sweep spend the entire hour's budget and then stop halfway with "rate
  limit reached" — funds out of some wallets and not others, from a confirmation
  the user gave once. A half-done irreversible action is worse than a refused
  one. The limit bounds how fast a compromised session can move money to a NEW
  destination; this is one destination, confirmed once. `withdraw(…, false)` is
  the un-guarded worker and `withdrawMany` is its only caller.
- **The destination is validated before ANY wallet moves**, so a typo or a locked
  vault costs nothing and moves nothing — and the failure says *"Nothing was
  sent."*
- ⚠️ **The amount is PER WALLET and the confirmation does the arithmetic out
  loud** — `0.1` across ten wallets is one ETH. Same rule as the dev-snipe fan-out
  budget, and the same way to get it wrong.
- **An empty wallet is ⚪️, never ❌.** Asked to sweep a wallet holding nothing,
  doing nothing is the right answer; a red cross beside eight untouched wallets
  sends the reader hunting for a fault. `empty` is set only by a SWEEP — asking
  for a fixed amount a wallet does not have is a real failure worth seeing.
- ⚠️ **The selection lives in the PENDING STEP, never in `core.tradeSelection`.**
  That one is persisted and drives which wallets every future Buy and Sell act
  on; a withdraw picker writing to it would silently re-aim the user's trading as
  a side effect of emptying a wallet.
- **One progress message, edited with the result** — ten wallets is ten
  notifications for one action, and the user is looking at the screen already.
  The `redrawTicket` rule applies to the picker: the poll loop does not await
  `handleUpdate`, so a run of taps is concurrent and the last render wins, not
  the last tap.

### "Harus ada opsi pilih chain dlu dan harus ada command pakai /"

`/withdraw` jumped STRAIGHT to "paste the 0x address" on whatever chain happened
to be active. A user who wanted to move SOL got a Robinhood prompt for a 0x
address and no way to say otherwise without backing out and hunting for 🌐 — the
wrong-chain dead end the snipe flow had to be rescued from, on a different
screen, three sections later. The flow that DID ask was reachable only by button.

- **Every entry asks the chain now**, `/withdraw` and 📤 alike, through the one
  `wdSweepChainScreen`. Two shapes exist and there is no third: a button that
  already knows the wallet AND the chain (the per-wallet 📤 on the deposit and
  removal screens) skips both pickers because it has nothing to ask; everything
  else asks. What must not come back is an entry that silently borrows the active
  chain.
- ⚠️ **…and then there were TWO of them, which was worse.** The first cut shipped
  `/withdraw` and `/withdrawall` differing ONLY in which wallets started ticked —
  landing on the same screen, the one that already carries ✅ Select all and
  ⬜ Clear. The second command bought exactly one tap and cost a second entry in
  the "/" menu with its own description: *"2 command ini beda … padahal fungsinya
  sama ini malah bikin bingung"*. **A second way in that does not do a second
  thing is a question the user has to answer before they can start.** One command,
  one button, one menu entry; the ACTIVE wallet is ticked (what a withdraw has
  always meant) and everything else is one tap on this same screen. `/withdrawall`
  and the `wdall` callback still ANSWER — they were live for a build and are in
  somebody's scrollback — but they open the same screen rather than a second
  feature.
- ⚠️ **`/withdraw` was never registered in the blue "/" menu at all.** The
  operator typed `/wi` and got no autocomplete, which is its own reason to think
  the command does not exist — and it is how the uppercase bug above got found in
  the first place. Both are in `registerCommands` now.
- The label stopped claiming a chain it no longer picks: `📤 Withdraw (active)`
  → `📤 Withdraw`.
- ⚠️ **And it was not only `/withdraw`.** Auditing the list found 40 commands
  handled and 22 registered. Four more user-facing ones were undiscoverable the
  same way — `/settings`, `/export`, `/language`, `/menu` — and are registered
  now. `guardTestPaths`-style, a test compares HANDLED against REGISTERED and
  fails on any new gap, with two explicit exemptions: **aliases** whose primary
  is listed (`/positions`, `/bags`, `/track`, `/refer`, `/lang`, `/bahasa` — the
  menu is a list people scroll, not an index), and **admin** commands, because
  `setMyCommands` is GLOBAL and `/userkey` prints somebody else's private key.
  The test asserts each admin command is gated inside its handler rather than
  taking "admin-only" on trust.

### "Mengapa ada bacaan paste base 88 ini kan sol wallet"

The withdraw prompt said *"Paste the base58 address"*, and it was read back as
**"base 88"**. `base58` is the name of an ENCODING — not a thing anybody sees,
and no help whatsoever in deciding whether what you just pasted is the right
thing. "0x address" works on EVM for the exact opposite reason: the user can
literally see the `0x`.

- **`destHint(chainKey)` is the one owner**, because five prompts spelled this
  out independently — the sweep, the per-wallet 📤, the token send, the
  whitelist, and the key export. Solana gets the CHAIN'S NAME plus where the
  address comes from ("the one Phantom, Solflare or your exchange shows"); EVM
  keeps `0x address`, where the prefix is the hint.
- ⚠️ **No example address, ever, on a withdraw prompt.** This repo has already
  paid for a placeholder pasted verbatim into a live shell; here the same mistake
  is an irreversible transfer to a stranger. The shape is described in WORDS.
- A test strips comments and fails on `base58` anywhere in user-facing text —
  in a comment it is a useful fact for whoever edits the file next, and on a
  screen it is noise.

### ⚠️ `solBalance` answered 0 for a dead RPC, and the removal guard believed it

Found while building the picker, and it is a defect in the shipped removal
screen, not in the new one. `solana.solBalance` catches its own errors and
returns `0n`, so on Solana **an unreadable balance and an empty wallet were the
same value**. `_balanceResilient`'s retry loop could therefore only ever detect
the 6-second TIMEOUT there: a node answering with a 429 or a 403 came back
`{ok: true, bal: 0n}`, `walletFunds` reported the chain as empty, and the removal
screen offered a one-tap ✅ Remove over a wallet holding 2.15 SOL.

- **`solBalanceOrNull` is the fix**, the shape `splBalanceOrNull` beside it
  already had, and `core.ethBalanceOrNull` is what every screen reads.
- ⚠️ **The screens read it through CORE.** The first cut had `readNative` reach
  into the `solana` module directly — a layering break, and the tell was
  immediate: `walletRender.test.js` stubs `core`, so the read went around its own
  stub and four render tests failed for a reason that had nothing to do with
  what they cover.
- **The sweep picker prints `?`, and does not total what it could not read.**
  Summing unread balances into "holding 0 SOL" would put the lie back one line
  above the `?` that exists to avoid it.

```bash
cd tradebot && node --test walletWithdraw.test.js   # 51 tests, no network
```

**Config a fix depends on:** nothing. `MAX_WD_PER_HOUR` still bounds sweeps —
one sweep, one slot.

## "/WITHDRAW" — 33 commands were one shift key from not existing

> 🤔 I didn't recognise that.

Reported with a screenshot of `/WITHDRAW` typed into a bot that had just shipped
the withdraw work. Nothing was wrong with the feature: every command in
`telegram.js` is matched with `===` against a lowercase literal, and **Telegram
does not lowercase what the user typed**. A phone keyboard capitalises the first
letter of a message by default, so `/Withdraw` — the thing most people actually
send — never matched either, and neither did any of the other 32.

- **In a group it is worse and invisible.** Telegram appends the bot's own
  username when several bots are present (`/withdraw@DexvraTradeBot`), which
  failed identically. Nothing in the file had ever stripped it.
- **`normalizeCommand` runs ONCE, at the entry point.** A fix applied
  command-by-command is one the 34th command forgets; a test pins the call-site
  count at one.
- ⚠️ **Only the FIRST WORD, and only when it starts with `/`.** Lowercasing the
  whole message would be a far worse bug than the one being fixed: this same
  string is what a contract address is pasted into, and a **base58 Solana mint
  and a checksummed EVM address are both case-SENSITIVE**. Everything after the
  first space is passed through verbatim for the same reason — the `/start`
  deep-link payload (`ca_solana_<mint>`), a referral code, `/send`'s two
  addresses.
- The tests DRIVE `onMessage` for `/WITHDRAW`, `/Withdraw` and
  `/withdraw@Bot` and assert the reply is the withdraw screen and not the
  fallback. A source scan of the normaliser would pass on a version that is
  never called.

**Config a fix depends on:** nothing.

## Conventions

- Tests live beside the code they cover, in `bot/test/`, `tradebot/*.test.js`
  and `src/**/*.test.ts`. A behaviour change without a test that would have
  caught the old behaviour is not finished.
- Comments explain **why**, and name the failure the code is shaped around.
  Match the density of the file you are editing.
- Operator-facing strings in @dexvraadminbot are **Indonesian**; user-facing
  bot copy and channel posts are English.
