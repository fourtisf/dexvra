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

⚠️ **AND IT HAPPENED A THIRD TIME, in a script written to diagnose something
else.** `abi:check`'s own usage line read `node scripts/abi-check.js
0x<contract>`, an operator pasted `0xTOKEN_YANG_ANDA_BELI` exactly as it was
offered, and the tool reported its own usage screen back at them. The
angle-bracket spelling is the worse of the two: **bash reads `<` and `>` as
redirects**, so the command dies with `syntax error near unexpected token`
BEFORE the script runs — which reads as a broken tool rather than an unfilled
blank, and is what the Pons `--tx 0x<your own buy>` instruction already cost.

- **The fix is never to reword the placeholder.** It is to print a REAL value —
  `abi:check` with no address now asks the CHAIN for the launches that actually
  happened and prints one complete, pasteable line per token; `group-ca.js`
  uses a chatId from the row it just listed — or to describe the argument in
  prose and print no command at all, which is what `buybot:check` does because
  it can know neither of its two arguments.
- **A non-address argument is DIAGNOSED, not bounced to usage.** ⚠️ And the
  `0x` prefix is not the test: `0xTOKEN_YANG_ANDA_BELI` starts with `0x`, so
  "40 hex characters, that one has 20" is true, useless, and points at the
  wrong problem. Whether the rest is HEX is what separates a placeholder from
  a truncated address.
- **`tradebot/pasteableCommands.test.js` scans every `scripts/` directory in
  the repo** — one guard, not one per package, because three copies of a rule
  eventually disagree. ⚠️ Its first cut anchored the match to the start of the
  line and therefore **passed on the exact revision it exists to catch** (the
  line was `usage: node …` — a label, then the command); the vacuity test
  beside it is what said so. Mutation-tested against the three real pre-fix
  sources.
- The `.env` reference table `launchpads:check` prints (`LAUNCHPAD_<PAD>_API`)
  is deliberately **out of scope** and the guard says so: it is framed as
  variable names to edit by hand, it explains `<PAD>` on the next line, and
  there is no real value to substitute for a base URL. A judgement, recorded so
  it is not rediscovered as an oversight.

```bash
cd tradebot && node --test pasteableCommands.test.js   # 3 tests, no network
```

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

### The sixth cause: a market read that FAILED read as a token with no market

"free trending tidak begitu bekerja, tidak sesuai dengan minimum yang sudah di
set" (2026-08-28), with the panel showing `Solana 3/5–8 · BSC 1/5–8 ·
Ethereum 1 · Base 1 · Robinhood 1 · Tron 3/5–8` and the pinned board matching
it row for row. Every configured chain under the floor — and the board carrying
$WIF, $FLOKI, $PEPE, $TOSHI, $BTT, which is the market filler's own work. So
nothing was idle; everything was simply stopping at one or three.

**It was one `catch {}` in `byGain`.** A market read that FAILED — a shared 429
from GeckoTerminal, a timeout, a `fetchMarket` that answers `null` because
neither reader could be reached — left `_change`, `_mcap` and `_vol24` null,
which is byte-identical to an indexer ANSWERING that the token has no data.
Three rules downstream then act on that null:

- `hasReading` refuses the row — right, a blank row may not be published, but
  for a reason that is not about the token;
- `rowRefusal` reads the null cap as failing the free-trending floors, because
  a floor is a CLAIM and a token with no cap cannot be shown to satisfy it;
- so the chain's shortfall is attributed to the FLOORS, and the INFO line
  accuses the operator's own listings of being too small.

**The board therefore publishes only as many rows as the read happened to
answer for.** GT's free tier is ~30 req/min counted PER IP and this box shares
it with the website's charts, so a cycle losing most of its reads is ordinary
here — which is the whole distance between a board that fills and one stuck at
1. And it is the same collapse the free-listing feed had just been fixed for
(`fetchTokenInfoX`), one service over, on the pass that decides what goes on a
public board.

- **`_unread` is the fact, and `looked()` is the one reader.** A row we could
  not price is still REFUSED — publishing it is how a blank reaches the board —
  but it is no longer COUNTED as having failed a floor nobody could read it
  against. The unprobed tail past `PROBE_CAP` already had this distinction
  (`_change === undefined`); a read that was attempted and failed did not.
- **Its own counter, its own sentence, its own log line at INFO.** "GT is rate
  limited" sends an operator to a key; "below the floors" sends them to a
  setting. Until now the first was reported as the second.
- ⚠️ **The watch branch is NARROW: only where the read failed for EVERY spare**
  is the upstream the answer. Two unread out of twelve is a quota blip, and the
  chain's real problem is whatever refused the other ten — the same narrowness
  `hasMarket` and `hasReading` already state about their own exemptions.
- ⚠️ **`log.debug` on a fill that could not happen.** The line above it —
  a fill that SUCCEEDED — is INFO, so a working filler logged and a failing one
  did not. Production does not print debug, so the one line explaining a
  permanently short board went to nobody. This file has now had to fix that
  exact asymmetry in three services.
- `trending:check --floors` prints `N could not be priced` beside the floor
  count, measured with the bot's own annotation rather than a second copy of
  the question.

Mutation-tested: restoring the old `looked()`, dropping `_unread`, and removing
the watch branch each fail between one and three tests.

```bash
cd bot && node scripts/run-tests.js test/trendUnpriced.test.js   # 8 tests, no network
cd bot && npm run trending:check -- --floors                     # per chain: refused vs unreadable
```

#### "kenapa tidak pakai dexscreener??" — because this pass never asked it

The right question, asked straight after. A PRICE has two free sources and only
a CANDLE has one, and the trending promoter was spending the scarce one on the
plentiful question: `byGain` priced up to `PROBE_CAP` candidates on EVERY
configured chain, every cycle — six chains is up to 150 reads — **GT-first**,
into a ~30 req/min ceiling counted per IP that this box already shares with the
website's charts. Every read it lost was a row that did not reach the board.

- **`fetchMarket` takes a `need` list now.** The cheap path used to return the
  moment DexScreener had a price and a cap — correct for `fetchPrice`, whose
  callers read exactly those two and throw the rest away. ⚠️ **Turning the
  promoter cheap without this would have made the board SHORTER, not cheaper**:
  it would have received records with no `change24h`, which that pass reads as
  "this token has no reading" and refuses — the fix producing a worse version of
  the bug it fixes. The caller names its fields; DexScreener answers only with
  all of them, otherwise this falls through to GT exactly as before and the
  DexScreener answer is reused rather than re-asked.
- ⚠️ **0 IS A READING for a volume or a 24h change** and is not one for a price
  or a cap, so the two groups are tested differently. One truthiness check would
  send every quiet pool to GT — the exact quota the change exists to save.
- **The market filler gained the same second source.** `bigCoins.topByMcap`
  (GeckoTerminal) falls back to `dsBigCoins.topByMcap`, which asks DexScreener
  the same question and already returned the same `{ok, why, items}` shape. GT
  stays FIRST — it ranks by pool depth across a whole network, the better answer
  when it is available — and DexScreener is asked only when GT **could not be**,
  never when GT answered with nothing: that is a fact about the chain, not about
  us. Both reasons are kept, or "GT was rate-limited" would be replaced by
  whatever the fallback then said.
- Mutation-tested: dropping `need`, restoring the GT-first promoter, and
  removing the filler's fallback each fail a test.

**Config a fix depends on:** nothing in this repo — but ⚠️ **`GECKOTERMINAL_API_KEY`
in `bot/.env` is the only thing that raises the shared ceiling rather than
dividing it**, and this is the seventh place in this file that sentence appears.
What changed is that the board now says so instead of blaming the operator's
tokens, and that the trending pass no longer spends that ceiling on a question
DexScreener answers for free. The key is still what buys headroom — candles
(`/api/ohlcv`) have no second source at all.

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

### The fifth cause was the opposite one: the board was full of nothing

"untuk free trending mohon di filter agar high mc dan vol yang rame yang
ditrendingkan, bukan kaya vol bahkan ga ada $10 di trendingin", with a screenshot
of the board:

```
$MRNA   +465.0%   MCAP $157.7K   VOL $0.05   10 txns
$GOOGL  +164.0%   MCAP  $66.4K   VOL $0.04    8 txns
```

Every round above was the board being SHORT. This one is the board being full of
tokens that traded five cents in a day, promoted for free over real markets —
and **ranking could never have prevented it**. `byGain` sorts by 24h change, and
a percentage off an empty book is the biggest one there is: the same defect
`minGainPct` was written for at the other end of the scale (a token down 99.94%
on a $1,648 cap), and with five slots and five junk candidates sorting still
promotes junk.

- **`autoTrend.floorRefusal` is the ONE owner** of "is this big enough and busy
  enough for a free slot", and it takes plain `{mcap, vol24}` rather than a row —
  the promoter annotates `_mcap`/`_vol24` onto a LISTING and the filler reads
  `mcap`/`vol24` off a MARKET candidate, and a predicate that knew one shape
  would have forced the other door to write its own.
- **They are QUALITY floors, not discretionary ones.** `minGainPct` deliberately
  governs only the target ABOVE `perChainMin`, because a short board is worse
  than a flat token. These bind every free slot the bot books: the gain-floor
  pass, the FLOOR FILL (the pass whose whole job is to overrule a floor, and
  therefore exactly the pass that would delete these silently on the chains that
  are short — the free-fall bound has this scar), `trendFill` (whose listings
  book their slot at CREATION), and the query itself.
- ⚠️ **⚡ Run now is bound TOO, and that is the one place this differs from
  every other rule here.** A forced run bypasses the gain floor and the
  free-fall bound on purpose — those govern how DISCRETIONARY the bot is being,
  and the operator has decided. These are the standing answer to what may go on
  the board at all, and a button that quietly published `VOL $0.05` would
  reproduce the report from the one path an operator uses *while they are
  watching*. The refusal names both floors and the tokens.
- ⚠️ **NO "nothing on this chain qualifies" EXEMPTION**, unlike `hasMarket` and
  `hasReading`. Those fall open because a chain no indexer covers would never
  fill. These must not: the market filler exists for a chain that cannot fill
  from its own listings, so refusing ROUTES rather than strands — and an
  exemption would put the reported board straight back on a chain of dead
  tokens, which is the chain that produces one. The floor shortfall raises
  `gap()`, so the filler is asked.
- **An UNREADABLE value is refused; a measured ZERO is refused for a different
  reason.** A floor is a CLAIM ("cap ≥ $100K"), and a token whose cap nobody
  publishes cannot be shown to satisfy it — the gainers `minMcapUsd` rule. A
  volume of exactly 0 is a READING, and it is the one being filtered.
- ⚠️ **`fetchMarket` carried no volume at all.** Both readers had
  `volume_usd.h24` / `volume.h24` in scope and discarded them. `vnum` publishes
  it from the DEEPEST pool — never summed across pools, which would inflate the
  one number the floor judges a token by — and it needed its own reader because
  `num()` answers null for 0.
- **`trendingWatch` gained a `below_floors` cause.** `spares_unusable` asserts
  "they are below −15%", and with the floors on that is now usually the wrong
  sentence — it sends the operator to look at a percentage when the answer is a
  $0.05 volume. The filler's `why` ladder reports the DOMINANT counter, not the
  first one written down: every branch says "every", and with three mutually
  exclusive counters that is only true of the one accounting for all of them.
- **The panel rows are TYPED, not stepped.** A cap floor moves in millions and a
  volume floor in thousands, so one step size fits neither: at ±$1M a $10K
  volume floor is unreachable, and at ±$10K a $5M cap floor is five hundred
  taps. `0` reads as **OFF** everywhere — `$0` on a row labelled "min cap" says
  the opposite of what it means.
- **The legacy tests state `minMcapUsd: 0, minVol24hUsd: 0` out loud** rather
  than inheriting it — the rule the pace tests had to learn.

**And the SITE had the same defect with its own cause.** The home board opens
sorted by 24h % and the only bound was `SANE_CHANGE_PCT`, so +465% on five cents
was a legal reading and led the board. `changeRank` = `changeReading` plus
`tradedEnough`.

- **It DEMOTES, it never hides.** These boards carry paying customers; a listing
  that vanished because its pool was quiet today is a refund conversation. The
  row keeps its real percentage in its own column.
- ⚠️ **…but `movers` EXCLUDES instead**, because `-Infinity` is less than zero
  and a demoted row fed to a "Top Losers" filter would be CROWNED by it — the
  fix producing a worse version of the bug it fixes, on the surface next door.
- ⚠️ **AND AN UNRANKABLE ROW HAS TO SINK IN BOTH DIRECTIONS.** One tap on the
  24H % header flips the sort ascending, and `-Infinity` leads it — the same bug
  again, on the full board, reachable with one click. It was already true of an
  unreadable change before any of this; the volume floor only widened the set
  that hits it. The comparator pushes an unrankable value last whichever way the
  board is sorted.
- **An unreadable VOLUME is not a small one** — that exemption fails OPEN here,
  because this is a ranking rule with no operator behind it, while the bot's
  floors fail CLOSED because an operator set them.

```bash
cd bot && node scripts/run-tests.js test/trendQuality.test.js   # 19 tests, no network
cd bot && npm run trending:check                                # the floors are on the config line
cd bot && npm run trending:check -- --floors                    # …and how many spares they refuse
npm test                                                        # home / TokenBoard, site side
```

The four promotion guarantees are MUTATION-TESTED rather than argued: reaching
around the floors in the floor fill, dropping them from the promotion pass,
bypassing them on a forced run, and dropping the filler's refusal each fail
between one and four tests.

**Config a fix depends on:** nothing — but ⚠️ **the floors ship ON and that
CHANGES an existing board on deploy**, deliberately, the way the gainers
`minMcapUsd` did. Either is one tap to `0` on ⚙️ Auto-Trend.

## The gap between two free listings was never a setting

"fitur free listing itu buat berapa jam sekali baru free listing di range misal
range 2 sampai 3 jam" (2026-08-25). Auto-Listing had `minGapMin`/`maxGapMin`
(25–90 min) on the panel labelled *scans every…*, and it was read as the answer
to this. **It is not, and the difference is the whole section.**

That band is the SCAN cadence, and a scan that finds nothing lists nothing — so
it was never a statement about the feed. Behind it sat `maxPerRun: 3`, which
means the site could take three listings inside one minute and three more half
an hour later. `maxPerDay: 12` was supposed to bound that and does not: twelve a
day arriving in four bursts is still four bursts, and a burst is exactly what
the per-token trigger band exists to stop the feed looking like.

- **`pace()` is the one owner of "may a listing go out right now"**, and it is
  PURE — the scan gates on it, the panel prints from it, the tests call it. A
  screen that computes its own version of a rule eventually disagrees with the
  rule; that is how the buy card ended up with two ideas of "whale".
- ⚠️ **The wait is rolled ONCE, at the listing — never by the scans that wait
  it out.** A fresh roll every scan converges on the FLOOR: with a scan every
  25–90 min, the first roll that happens to land under the elapsed time opens
  the gate, so the spacing collapses to the minimum of however many rolls fit in
  the window, and the band is decorative while every number on the panel still
  reads correct. Same defect as the per-chain trending target re-rolling every
  cycle, which ratcheted the other way and pinned every chain to its maximum.
  Rolling at the listing is the same fix as hashing a token's trigger off its
  address: the number has to be genuinely reached, and it does not move while
  you wait.
- **The roll is stored as a FRACTION of the band, not as an absolute "next at".**
  So editing the band in the panel applies to the wait already in progress. A
  stored timestamp would go on honouring a range the operator has since changed,
  and from the panel that is indistinguishable from a clock that has stopped.
- **The clock is on disk.** A restart that reset it would let a redeploy publish
  back to back, and this service is redeployed far more often than it is paced.
- ⚠️ **A stamp in the FUTURE is treated as SPENT, not as caution.** Clock skew
  or a restored backup, and there is no way to learn how long ago the real
  listing was. The first cut clamped `lastAt` to `now`, which reads as the
  careful choice and is the exact opposite: `nextAt` then recedes with every
  tick and the service never lists again, silently, with the panel still reading
  🟢 ON. Found by a test asserting the wrong behaviour and passing — the
  reassuring reading, for the fourth time in this file.
- **The gate sits AFTER discovery and the site read, BEFORE the first price
  lookup.** Those two calls are the only things that prove the service can still
  see the market and reach the site — `BLOCKED_ALERTS_AT` is built on them — so
  gating above them would cut the watchdog from every 25–90 min to once per
  rolled wait. Everything past the gate costs a DexScreener lookup per
  candidate, and a scan that may not list has no use for one.
- **A paced scan logs at INFO.** With a 2–3h pace this is what most scans do,
  and "why has nothing been listed" has to be answerable from pm2 alone; a scan
  that logged nothing would look exactly like a dead loop. The report carries the
  candidate count for the same reason — a long paced stretch must not read as a
  service that has gone blind.
- **While the pace is on, `maxPerRun` is not in play** and the panel stops
  printing it. A per-scan number that can no longer happen is a row the engine
  ignores, and this file already names what those cost.
- **The pace belongs to the SCAN, and only to the scan.** `trendFill.fillChain`
  and `chainSeed` list through the same `createFromInfo` and are untouched:
  pacing the filler would put the "board stays short" saga straight back, and
  the seeder is an operator-triggered bulk inventory fill, not a feed event. The
  panel says so under the pace line, because three listings appearing at once
  while it reads 2h–3h is otherwise a bug report.
- **The panel does the arithmetic out loud** — `≈ 8–12 a day, inside your 12/day
  cap`. Two numbers governing one feed with nothing saying which binds is the
  🧲 `max 3/chain` label again, whose very first question was which of the two
  it was.
- **An inverted band resolves to the FLOOR**, and a refused value names WHICH
  refusal it was: "1h is outside the limits" is false about a 1h ceiling under a
  2h30m floor, and a diagnosis pointing at the wrong cause sends the operator to
  change the wrong setting.
- ⚠️ **The legacy tests were made to say `paceListings: false` out loud.** With
  the pace on its shipped default a scan lists at most one, so four burst tests
  failed — and one dedupe assertion would have gone on passing for a NEW reason,
  which is worse. Stated, never inherited: the same rule the auto-trend panel
  helper had to learn.

### The audit round — and the panel was contradicting itself in four places

Run against the finished feature by four independent lenses, and every defect
found is one of this file's own recurring shapes, reintroduced by the code
written to stop it. **The engine was right in all of them; the SCREEN was not.**

- ⚠️ **🔎 Test scan could not see the pace, so the panel said the opposite of
  itself four lines apart** — `next one due in 2h30m`, and under it
  *"2 would be listed right now"*. `dryRun` never called `pace()`, and it is the
  button whose documented job is answering "why has nothing been listed?" — with
  the pace shipped ON, the pace is now the commonest answer and the test scan
  was the one surface that could not give it. It carries `report.pace` now
  (its own field, never `report.paced`: flipping `scanLine` into the paced
  branch would hide the market verdicts, and reporting the market is what a test
  scan is FOR), and the verdict says *"2 qualify, but the pace holds the next
  listing for 2h30m"* — or, with the pace open, that a real scan lists **the
  first one**, because `perRun` is 1 and promising two is a number the engine
  cannot produce.
- ⚠️ **`≈ up to 0 a day`, for a feed listing every other day.** Both ends of the
  rate are `Math.floor(1440 / gap)`, so both go to zero the moment a band passes
  24h — which the rails allow up to a week. A printed zero is a claim nobody
  measured, the trending board's defect one screen over; a band slower than a
  day now says so in words, and says the daily cap cannot be what stops it.
- ⚠️ **`fmtGap` rounds, so a wait of 20 seconds printed as `0 min`** — on the
  one line whose whole job is saying why nothing was listed. "under a minute",
  and never a bare `<`.
- ⚠️ **The ready line asserted "due now" over the two gates that run BEFORE the
  pace.** `pace()` knows only its own clock; `runOnce` checks `enabled` and the
  daily cap first and returns without ever reaching it. So a service switched
  OFF, and a day already full, both printed *"the next scan may list one"*. The
  auto-raid panel had to learn to DROP its ready line rather than reword it, and
  this is the same fix: `held — the service is 🔴 OFF`, `held — today's 12/12
  cap is reached`.
- ⚠️ **"nothing listed yet" is a claim about the FEED and the clock is a new
  field**, so every install that upgrades prints it directly above its own
  *"Listed so far: 84"*. It is a statement about the CLOCK now.
- ⚠️ **A pinned band (min = max) IS a fixed heartbeat**, and the line beside it
  said *"never a fixed heartbeat"* — two ➕ taps from the shipped default, denying
  exactly what it was doing.
- **"the N/day cap is the only bound" was false** on a zero floor: pacing forces
  one listing per scan and scans are their own band. It names both now.
- **A negative ask on the ceiling row was answered as a floor conflict.** Both
  refusals were reachable and the wrong one won, which sends the operator to
  change the wrong setting.

And four in the TESTS, which matter more, because a test that passes for the
wrong reason is how the next round starts:

- ⚠️ **The pace gate was answering for the paying-customer dedupe test.** The
  test above it lists at the same synthetic `now`, so `known.has(key)` could
  have been deleted outright and the suite stayed green. This shape was caught
  and fixed one test higher and not applied to the next one down. It asserts
  `lastScan().known === 1` and `lastScan().paced === null` now — which rule
  stopped the scan, not merely that it stopped.
- **"the clock survives a restart" did not test persistence.** It read `pace()`
  off the live module; a clock held in a module-level variable passes that. It
  re-requires the module, the move the package-rotation test already makes.
- ⚠️ **Nothing drove `start()`** — the three cadence tests all called the helper,
  and `start()` is its only production caller, so it could go back to rolling its
  own gap with every one of them green. That is the repo's own rule about a guard
  measuring the stack that actually runs, and it needed the REAL clock: under the
  suite's synthetic `now` every stored stamp reads as skewed and the pace never
  engages at all.
- **"a zero band cannot spin the loop" was vacuous** — `HARD.gapMin`'s floor of
  5 min made the assertion true whatever the branch did. It is asserted against a
  one-second wait now, which is the case that reaches it. The `Math.max(30_000)`
  it was aimed at is unreachable belt-and-braces and says so, rather than
  carrying a test that claims to cover it.

The four guarantees were then MUTATION-TESTED rather than argued: `start()`
rolling its own gap, the wait re-rolled every scan, the clock in memory, and the
gate moved above discovery. Each fails between one and five tests.

```bash
cd bot && node scripts/run-tests.js test/autoListerPace.test.js test/autoListerPacePanel.test.js   # 35 tests, no network
```

**Config a fix depends on:** nothing — but ⚠️ **it ships ON at the operator's own
2h–3h and that CHANGES an existing install's behaviour on deploy**, deliberately,
the way `minMcapUsd` did. The old behaviour is one tap: ⏳ Pace → OFF on the
🆓 Auto Listing panel.

### "pas pilih arm malah tidak mau respon" — it answered, off screen

Reported with the 🎛 Snipe Setup panel filled in and ⚡ ARM SNIPE doing
nothing. The tap was acked, the handler ran, and `armSnipeDraft` refused with
a real reason (*already sniping that dev on this chain* — the operator had
armed it, tweaked a row, and tapped again). **The reason was rendered into the
panel, near the TOP of a twenty-line message**, and the reader is at the
BOTTOM, because that is where the buttons are. An in-place edit notifies
nobody and, once scrolled, happens off screen — so the button reads as dead.

This file already names that lesson, on this very handler: the SUCCESS path
sends the confirmation as a NEW message *("dmn ada teks snipe atau confirm??"
— it was there, written into the panel message in place)*. **The failure path
beside it kept editing.** A lesson applied to one branch of an if/else is a
lesson half-learnt.

- **A refusal is SENT as well as edited in.** The panel keeps the reason (the
  row to fix is one tap away — the original comment's reasoning stands), and
  the reason also lands at the bottom of the chat, where the tap was made,
  naming what was refused and stating that **nothing was spent**.
- ⚠️ **A refused panel DROPS its ready line.** Its last line still read
  *"✅ Ready. Nothing is armed yet — tap ⚡ ARM SNIPE below to start
  watching"* — directly above the button that had just refused, with the
  reassuring line LAST. So the reader taps again, gets the same silence, and
  reports a dead button. The auto-raid panel had to learn to DROP its ready
  line rather than reword it; this is the same rule on the panel that spends
  money. A panel with no refusal still says its ready line — pinned, because
  deleting it is what started *"dmn ada teks confirm??"* in the first place.
- **The tests DRIVE the registered handler** through a real callback update
  and assert a `sendMessage` carrying the reason, not merely that the code
  calls `snipeSetupScreen`. A source scan passed on the broken revision.

#### …and the refusal was right — the PANEL that produced it was not

With the reason finally visible (*already sniping that dev on this chain*),
the next question was "mengapa seperti ini". Because the panel that offered
the tap showed **every row ✅ and a live ⚡ ARM SNIPE button for a developer
the store was already watching** — indistinguishable from a panel that has
never been armed, which is exactly how it gets tapped. **A screen that offers
an action which cannot succeed will be reported as broken, and it was.**

- **`core.armedTargetFor(chatId, {kind, chain, ca})` is the ONE owner of "is
  this a duplicate".** Two already existed — `addSnipeTarget` and
  `addCopyTarget` each refuse one at arm time — and the panel knew about
  neither. It is the same fact, read one screen earlier, where it can still be
  acted on.
- **The ⚡ row is REPLACED, not relabelled**: an already-watching target's row
  becomes the list it is already on (👥 Copy & Snipe for a dev, 🎯 Sniper for
  a CA). A button whose only outcome is a refusal is not a button.
- **The status line says it too**, where the 🎯 Target row that fixes it is one
  tap away — change the target, or go remove the existing one.
- ⚠️ **Kind and chain are part of the identity.** A dev target and a CA target
  live in different stores and the same address on another chain is a
  different target; reading one for the other would refuse to arm something
  perfectly arm-able. EVM comparison is case-insensitive (a pasted checksum
  spelling must not read as a second, un-armed target) and Solana's is not.

#### "set 0.01 eth 5 wallet tpi laporanya hanya 1 wallet" — and there was no way to change it

Both halves of the next report are one design hole. `newSnipeDraft` defaults
its wallet row to the **ACTIVE wallet**, so a target armed before that row is
touched watches with one — correct as a default, and invisible as a decision.
Change the row afterwards, tap ⚡, and it was **refused as a duplicate**: the
only route to the settings the user wanted was knowing they had to REMOVE the
target first, which nothing on any screen said.

- **⚡ on an already-watching target UPDATES it.** Tapping arm on a panel
  showing this target with new settings has exactly one possible meaning —
  "watch it with THESE" — and refusing is the least useful reading of an
  unambiguous request. The button says `⚡ UPDATE` when it will re-term rather
  than arm, because those are different events to a reader.
- ⚠️ **An edit rewrites the TERMS and never the HISTORY.** `spentEth`,
  `bought`, `holding`, `copySell`, the id and the cursor all survive: a budget
  that reset itself on an edit would let one target spend its cap twice, and a
  cleared `bought` map would re-buy a launch it already holds.
- **The budget floor is re-read against the NEW wallet count.** Five wallets at
  0.01 costs 0.05 a launch; a 0.03 budget on that selection is a watch that can
  never fire, and it is refused with the number.
- **A budget BELOW what is already spent is allowed, and SAID.** It is the one
  edit that halts a watch without removing it — refusing it would deny that,
  and applying it silently would be a watch that never buys again with nothing
  saying why.
- ⚠️ **"Budget itu untuk apa saya tidak mengerti."** `💰 Budget: 0.15 ETH` says
  nothing about what it authorises, which is the entire question. The row does
  the division out loud now — *"the total this watch may EVER spend — 3
  launch(es) at 0.05 ETH each, then it stops buying"* — the same fix the 🧲
  fill-rate label needed when its very first question was which of two numbers
  governed what.
- **Three tests changed premise, not rule.** "A refused arm keeps the draft"
  and "a refusal reaches the user" were both written against the duplicate,
  which is no longer a refusal; they use refusals that still exist. ⚠️ And one
  of those attempts revealed the panel's own guard working: a budget under one
  launch is refused at its ROW by `updateSnipeDraft`, so the panel can never
  display a setting the arm would then reject.

#### "hapus fitur budget" — a cap removed on the owner's call

Asked, and confirmed with the trade-off stated in as many words. **The dev
snipe now has no spending cap at all**: it buys every launch that developer
makes, on every wallet in its selection, until the master switch goes off, the
target is removed, or the wallets run dry.

- **It is a real removal, not a hidden default.** No row, no draft field, no
  `maxEth` on a 'launches' target — and `ensureUser` DELETES a stale one, or
  every screen would go on rendering `used 0.02/0.1` over a watch with no
  limit at all. A field that looks meaningful and binds nothing is the row the
  engine ignores, one level down.
- **What replaces the cap is VISIBILITY.** This repo's rule is that nothing
  spends money silently, not that everything must be bounded: the panel, the
  arming confirmation and the Copy & Snipe row each say the watch is uncapped
  and what the only stop is, and `spentEth` is still accumulated because it is
  the only number that says what an uncapped watch has actually spent.
- ⚠️ **COPY TRADES KEPT ITS CAP.** It was not what was asked about — the
  question was the per-LAUNCH budget on the snipe panel — and silently
  uncapping a second feature on the strength of a request about the first is
  how a removal turns into an incident.
- **The old one-line grammar still parses.** A third word used to be the
  budget; it is IGNORED rather than refused, because an operator with the old
  line in muscle memory must not have their target rejected over a dead
  setting.

### "TOKEN SUDAH LAUNCH SNIPE ON TPI PAS TOKEN LAUNCH BOT MALA DIAM"

A watched dev launched `$TEST` on Pons and the bot did nothing — no buy, no
message. **The bot was neither broken nor idle, and its own token card said so
in a sentence nobody thought to connect:** *"This token's liquidity is on Pons
v2, which Dexvra can't route through yet — so there's nothing to quote and no
swap to sign."* The launch was on a bonding curve this engine has no route
through: `canTradeNow` said no, `_notYetTradeable` deliberately excludes "can't
route through" from the retry ring (retrying an unroutable venue is two minutes
of RPC for an answer that will not change), and the chain ended in silence.
**Every step was individually correct and the sum of them was a sniper that
watched a launch go by without a word.**

- **An armed follower whose dev launched something is TOLD, always.**
  `_devLaunchMissed` names the token, the dev and the REASON — an unroutable
  venue, a DANGER flag, a dead wallet — because "minimal kalo gagal harus ada
  pesanya" is the floor, not a feature request. One notice per launch per five
  minutes: a warning per tick is a warning nobody reads.
- **A honeypot skip is the gate WORKING and is still said**, or the one case
  where staying out was the right call looks identical to being broken.
- ⚠️ **An unroutable launch is HANDED TO THE CA SNIPE, not dropped.** A
  bonding curve becomes buyable when it graduates into a pool this engine can
  route (Pons v2 graduates into a Uniswap v4 pool, which `v4.js` already
  autodiscovers). The CA snipe already polls `canTradeNow` for its whole TTL
  and fires on the first tick it can fill — so "never bought" becomes "bought
  at graduation" using only paths that already work, with no new money-path
  guesses. It carries the target's own wallet selection, slippage and TP/SL,
  and a failure to queue it is REPORTED: a follow-up the user believes exists
  is worse than none.
- **The ring's expiry is the last moment anyone can be told.** Past it there is
  no event left to hang a word on, so that is where the notice goes for a
  launch nobody managed to buy.
- ⚠️ **TWO Pons factories, not one.** Pons kept its V1 deployment live for
  tokens launched before the V2 upgrade, and a scan watching one address is
  blind to the other — `eth_getLogs` answers an unmatched address with an empty
  array, so that blindness reads as a quiet launchpad. A LIST now (current
  first, legacy kept), all live ones scanned on one cursor, and ONE live
  factory is enough — a dead legacy address must not condemn the current one.
- ⚠️ **The pad's HOST was a guess and the guess was wrong.** `pons.fun` was
  invented from the pad's name; the launchpad is served from
  **`ponsfamily.com/launchpad/<token>`**, which an operator's screenshot
  settled after the first check reported "can't reach api.pons.fun". The real
  host leads the base list and the invented ones cost nothing behind it —
  which is the whole reason a base list exists.

⚠️ **What this does NOT do: trade the Pons curve.** Buying pre-graduation needs
a route through Pons's own curve contract, and writing one against an interface
that cannot be verified from here would be a guessed address on a money path —
the one thing this repo refuses outright. Until that is verified on the box, an
armed dev snipe on a Pons launch buys **at graduation**, and says so at the
moment it cannot buy sooner.

```bash
cd tradebot && node --test snipePanel.test.js padSnipe.test.js   # 92 tests, no network
```

**Config a fix depends on:** nothing. `PONS_FACTORY` takes a comma list if
either deployment moves, and `LAUNCHPAD_PONS_API` pins the host if
`ponsfamily.com` is not where its API answers from.

#### "masih sama ajaa" — and the preflight was reporting the wrong-factory state as a quiet one

The next run: 4p green (`factory has code · 24353 bytes`), **`no Pons activity
in this window`** — and a token the operator had launched on Pons forty minutes
earlier, well inside the 5000-block window. Those two facts cannot both be true
of a correct factory address. **A factory that is live-but-WRONG reports zero
events, which is byte-identical to a quiet pad**, and that ambiguity is the
whole reason a researched-but-unverified integration can read green while every
real launch goes by unseen.

- **`--token <ca>` (section 4t) settles it from the operator's own data.** It
  scans recent blocks for any log MENTIONING that token and prints which
  contract announced it, with the topic0 — then prints the `PONS_FACTORY=` line
  to paste. The launchpad cannot hide from the token it launched.
- ⚠️ **Topics AND data.** A launchpad that packs the token into the data rather
  than indexing it is invisible to a topic-only filter, and that is half the
  ABIs in the wild.
- **4p probes EVERY configured factory** now, not just the first, and a dead
  legacy address prints as an ordinary note instead of failing the section —
  a retired deployment is expected to have no code and must not condemn the
  live one.
- **The "quiet pad" note stopped guessing.** It used to advise a wider window;
  it now names the probe that answers the question instead, because "rerun with
  more blocks" is the wrong advice for the state it usually means.

#### Why a Pons token cannot be bought, stated once and for all

Established by elimination, not by assumption, after three rounds of "masih
sama aja":

1. **The card is right.** `tokenSnapshot` tries `v4.price()` BEFORE it falls
   through to the indexer, and `v4.js` scans up to 4,000,000 blocks (trying
   `fromBlock: 0` first) for an Initialize log naming the token, reading the
   whole PoolKey including `hooks`. A hooked v4 pool would be found. It found
   none.
2. **So no v4 pool exists for that token yet** — which is exactly what the pad's
   own page says: *"At the threshold the curve closes and liquidity moves to a
   Uniswap v4 pool."* Pre-threshold there is a Pons CURVE contract and nothing
   else.
3. **This engine has no route to that curve.** Not a bug, not a missing
   config: no code here knows the Pons curve's interface, and the honest
   consequence is that a Pons token is unbuyable by this bot until it
   graduates.

**What unblocks it is one transaction the operator has already made.** A buy on
the pad's own website names the contract and the 4-byte selector a Pons buy
goes through, and `--tx` now decodes exactly that — `to`, `value`, the
selector, and every argument word with the addresses among them labelled. A
launchpad integration that cannot be read out of a real trade is one built on
guesses, and this repo does not put guessed addresses on a money path.

⚠️ **AND THE INSTRUCTION THAT ASKED FOR IT WAS ITSELF THE DEFECT.** It was
written as `--tx 0x<your own buy on the pad>` — a command with a placeholder in
angle brackets, pasted straight into a live shell, where bash reads `<` and `>`
as redirects and dies with `syntax error near unexpected token 'newline'`
before the script ever runs. **This file's own first rule, broken in the act of
diagnosing something else:** a command an operator can paste must contain only
real values, or it must not be a command.

So the hash is no longer asked for at all. **Section 4x finds the trade
itself**, from the token address the operator already has: every buy on a curve
moves the token OUT of the curve contract, which emits a `Transfer` — and a
Transfer log carries its transaction hash, from which the CALL is one read
away. It prints the contract, the selector, the value and the labelled argument
words, and RANKS the call that carried value first, because that one is the
buy and a sell or a plain send is not.

⚠️ **AND THE FIRST CUT OF THAT PROBE HUNG.** It matched the token by substring
against every log, walked in 200-block steps, and over a 50,000-block window
that is 250 requests each pulling the WHOLE chain's logs — the operator watched
a probe sit there. **A probe that hangs is worse than one that says it cannot
answer.** An indexed argument IS a topic, so 4t is three topic-filtered
requests over the whole range; the DATA-packed case it can no longer see is
DELEGATED to 4x (address-filtered on the token's own Transfer logs, cheaper
still) and the warning says so, or "not found" reads as "never launched". 4x
runs FIRST because it is the cheapest and answers the question actually being
asked. The stepped fallback carries a request budget.

⚠️ **And syntax-checking the file proved nothing** — the hang was a runtime
shape. Both probes are now driven against a STUB chain that counts requests:
they complete, they print the contract and the selector, and they cost **four**
`getLogs` calls, not two hundred and fifty.

```bash
cd tradebot && npm run preflight:robinhood -- --token 0xTHE_TOKEN_YOU_LAUNCHED
```

⚠️ **And the token card was RIGHT all along.** *"This token's liquidity is on
Pons v2, which Dexvra can't route through yet"* is not a bug: Pons v2 tokens
trade on a bonding curve until the threshold, and only then does liquidity move
into a Uniswap v4 pool. `tokenSnapshot` already tries `v4.price()` first —
`v4.js` reads whole PoolKeys off Initialize logs, hooks included, so a
graduated Pons pool routes today. What does not exist is a route to the CURVE
itself, and that is the honest boundary: **an armed dev snipe on a Pons launch
buys at graduation, and says so at the moment it cannot buy sooner.**

### "angkanya bisa di ketik biar cpt" — twenty-two taps for one number

The trigger ceiling steps in ±$100,000, so moving it from $1M to $3.2M is
twenty-two taps, and the pace band steps in 30 min. The label button beside each
➖/➕ pair was an `alnop` — a button that did nothing at all — so the fix cost no
new row on a keyboard that is already fourteen deep: **the label IS the input**.

- **`AL_TYPED` is one table**, and `kind` picks the parser. A row added later
  cannot grow its own idea of what a valid value is — the shape `pads.js` and
  `MOODS` already use in this repo.
- **The money parser is `parseCap`, IMPORTED**, not a second copy. It already
  exists for the gainers settings and it already carries the scar: `500k` →
  `Number()` → NaN → `clampNum` swapped in the default → *"✅ Minimum market cap
  → $1.00M"*, a number nobody asked for under a tick.
- **`parseGap` lives beside `fmtGap` as its inverse**, the contract `parseCap`
  states one module over, and returns `null` on anything it cannot read.
- ⚠️ **A BARE NUMBER IS REFUSED on a duration row, and that is deliberate.**
  `3` is three minutes to the store and three hours to the label printing
  "Every 3h" — and being wrong by 20× on *this* setting is the firehose the pace
  exists to prevent. The refusal names BOTH readings rather than guessing. Every
  other spelling is generous: `2h30m`, `90m`, `2.5h`, and the `3jam` /
  `90 menit` an Indonesian operator actually types.
- **A clamped value says it was clamped**, and the two pace rows report the whole
  BAND rather than the end that was typed — raising the floor past the ceiling
  moves the ceiling too, and naming one number while the other moved sends the
  operator to change the wrong setting.
- ⚠️ **`$1,000,000` rendered as `From $1,000,0…`** — the one row whose job is
  showing a value showed everything but its last digits. The labels are `fmtCap`
  now (`$1.00M`), which is what the rest of the repo already spells money as.
- ⚠️ **A fake Telegram update must be faithful WHERE THE FRAMEWORK LOOKS.**
  Telegraf's `bot.command()` matches the `bot_command` ENTITY, not the text, so
  a `/cancel` sent without one arrives as ordinary text and the handler never
  fires. The first cut of the `/cancel` test therefore reported a wait surviving
  a cancel that was never delivered — a test measuring its own fake.

```bash
cd bot && node scripts/run-tests.js test/autoListerTyped.test.js   # 13 tests, no network
```

## "auto listing aktiv tapi hari ni listing 0 dari kmrin listing 0" — the band top was a jitter wearing a size limit's label

Reported 2026-08-28 with every panel light green: Status 🟢 ON, pace *"due
now"*, 105 listed lifetime — today 0, yesterday 0. Nothing was down and no scan
was blocked. The operator had set the trigger band to **$1M–$100M** (with
Ignore-above at $100M — plainly *"list anything from $1M to $100M"*), and
`triggerMcap` drew every token's trigger UNIFORMLY across the whole band.
Measured, not argued: mean trigger **$50M**, and **0.4%** of tokens drew one
under $1.5M. The discovery feeds carry $1–5M projects, so ~97% of every scan
was refused "below its trigger", the refusals cooled for 12h, and a feed that
had listed 105 tokens went to zero **by arithmetic** — the quiet-market look,
with the operator as the detector again.

- **The two readings of "Trigger band" coincide on a narrow band and diverge
  catastrophically apart.** The band was designed as the anti-round-number
  smear (listings at $1.08M / $1.42M, the shipped $1M–$1.5M), where "how much
  jitter" and "up to what size may a token list" are the same answer. Widened,
  they are opposite answers, and the engine had the one no operator means —
  the `🧲 max 3/chain` label defect, with two days of dead feed attached.
- **The jitter is bounded by the FLOOR now** (`triggerJitterSpan`: at most half
  the floor above the floor — the designed smear exactly). The band top past
  that governs nothing; eligibility's ceiling is `maxMcapHard`, which is its
  own row. On the shipped band the draw is **bit-for-bit what it always was**
  (span 500k either way, pinned by a test), so no install's triggers move
  unless its band was wide — where the old triggers were the defect.
- **The panel does the arithmetic out loud** when the stored band is wider
  than the draw: *"triggers land in $1.00M–$1.50M — a token past its trigger
  lists at any size up to the $100,000,000 ceiling."* The number that actually
  governs is the one on screen, which is what stops the next widened band
  being read as a dead feature.
- Mutation-tested: restoring the unbounded draw fails the wide-band test (a
  $5M token must qualify under a $1M–$100M band).

```bash
cd bot && node scripts/run-tests.js test/autoLister.test.js   # includes the two band tests
```

**Config a fix depends on:** nothing. The operator's stored band keeps its
stored values; only the draw is bounded. If listings are still 0 after this
deploys, 🔎 Test scan names the next gate in line — it is no longer this one.

### …and the same day, "free listing di admin bot tidak bekerja sebelumnya bekerja"

The band-top defect above is why that operator's feed went to zero. This is the
audit that followed it, and its subject is not a fifth cause — it is that **all
five looked identical from every surface an operator has.** The panel read 🟢 ON
and the scan line under it read

```
🔍 Last scan (4 min ago): 40 candidates · 40 priced · 0 listed
```

**That sentence is what a healthy scan in a quiet market looks like, it is what
the band-top defect looked like for two days, and it is what every one of the
following looks like** — a site refusing every create, a pricing host refusing
the box, one whole chain that can never be resolved, and an operator's own
↩️ Reset tap. Five different faults, one rendering, `blocker` null in all of
them, and the blocked-scan watchdog silent because it only ever fired when a
scan could not RUN.

The service was in fact the best-instrumented one in this repo — `scanReport`,
`BLOCKED_ALERTS_AT`, the panel's "the scanner has gone quiet" line — and every
hole below is somewhere those instruments do not reach.

- ⚠️ **A CREATE THE SITE REFUSED WAS A `continue`.** One `log.warn` and nothing
  else: no counter, no reason on the panel, no blocker. A rotated
  `INTERNAL_API_TOKEN`, a payload the site's validator rejects and a 500 all
  rendered as `0 listed` with an EMPTY reason tally — which reads as "the market
  had nothing", the opposite of what happened. `report.refused` / `refusals`
  carries the site's verbatim sentence now, `scanLine` leads with it, and a scan
  in which **not one** create landed is a BLOCKER: those tokens cleared every
  gate the operator set, so that scan had something to list and could not, which
  is the definition `fileReport` already used. One that listed something and
  refused one token is not — paging for a per-token problem is how a monitor
  gets muted.
- ⚠️ **"WE COULD NOT ASK" WAS BEING FILED AS A FACT ABOUT THE TOKEN, AND THE
  TOKEN PAID FOR IT FOR TWELVE HOURS.** `dexscreener.fetchTokenInfo` returned a
  bare `null` for a 403, a 429, a dead socket AND a token with genuinely no
  pair; `rejectReason` renders a null as `"no market data"`, and `coolUntil`
  benches that for **12h**. So a DexScreener refusing this box produced
  `40 priced · 0 listed — no market data ×40` and then kept the feed dead for
  half a day after the outage ended. `fetchTokenInfoX` returns
  `{info, ok, why}` — `pumpfunNewX`'s shape, for the fourth time in this repo —
  `ok:false` is its own counter and its own sentence, and it writes **no cool
  entry at all**.
- **The host is BENCHED on a refusal, and the feeds share the bench.** 401/403/
  429/451 only: a 5xx or a timeout is a per-request failure and says nothing
  about the quota, and a 404 is an answer about the token. Discovery and pricing
  are the same host, so two benches would let the half still asking keep the
  refusal alive for the half that stopped — `gt.ts`'s contract, verbatim.
- ⚠️ **↩️ RESET SWITCHED THE SERVICE OFF, and the panel then blamed the loop.**
  `DEFAULTS.enabled` is false — right for a fresh install, which publishes in
  public — so resetting the THRESHOLDS stopped a running feed, announced as a
  bare "↩️ Reset". And an off service filed no scan report, so `alScanLine` went
  on to print *"⚠️ The scanner has gone quiet — the loop has stopped. Check the
  [monitoring] lines in pm2 logs"*, sending the operator to hunt a dead process
  that was running perfectly. **Two taps from the reported symptom, with nothing
  on any screen naming the cause.** The switch is carried across a reset now, the
  button says which state it left the service in, and an OFF scan FILES its
  report — a stale report is supposed to mean the loop stopped, and it can only
  mean that if every other reason files one.
- ⚠️ **TWO OWNERS FOR THE DEXSCREENER SLUG, disagreeing about one chain.**
  `config/chains.js` has `DEXSCREENER_SLUG` (`sei: "seiv2"`); `dexscreener.js`
  built its own identity map from an `OVERRIDES` table nobody ever filled in. So
  every Sei token answered "no market data" and every Sei feed entry was dropped
  before it was counted — one whole network invisible to free listings,
  silently, while the panel said it watches "every supported chain". One owner;
  identity stays the FALLBACK so adding a chain still makes it discoverable.
- ⚠️ **AND THE GUARD TEST FOR THAT COULD NOT FAIL.** It asserted the map had one
  entry per chain and no duplicate slugs — both true of the broken map. It
  asserts equality with `DEXSCREENER_SLUG` now, and `dexscreener.test.js` drives
  a real captured payload through the parser: **that module had no test at
  all**, so a renamed DexScreener field would have made every candidate on every
  chain read as "no market data" with 1,700 tests green.
- **Robinhood pricing OVERRODE the indexer, and that rule expired.** `discovery`
  returned the pools.trade record and never asked DexScreener — correct while
  pools.trade was the only source for the chain, and wrong from the day
  DexScreener added it (July 2026). The gates read `liq`/`vol24`/
  `pairCreatedAt`; a bonding-curve envelope coerces what it does not publish to
  0, so the whole chain read as `thin liquidity ($0)`, including graduated
  tokens with real depth. It is a MERGE now — the indexer's live numbers win,
  the pad fills the socials, logo and curve state. The test that pinned the
  override now states why it expired.
- ⚠️ **A LAUNCHPAD RECORD MAY NOT DRESS A REFUSAL AS AN ANSWER.** With the merge
  in place, a DexScreener that could not be asked plus a pad record would have
  produced a full-looking row with `liq: 0` — reported as `thin liquidity`,
  which sends the operator to change `minLiq` over an upstream outage, and
  shortens the cool from 12h to 1h. `ok` follows the INDEXER; the pad is display
  data.
- **An optional social may not cost the whole listing.** `adminValidate` refuses
  the ENTIRE row over a `website`/`twitter`/`telegram` that is not a full URL,
  and the pads publish bare handles. `siteUrl()` mirrors the site's own rule and
  DROPS what it cannot vouch for — losing a link beats losing the listing and
  the link with it.
- **A refusal is memoed only when it is about the ROW.** 400/404/409/422 will not
  change on the next scan, so the token is cooled; 401/403/429 are the site
  refusing US and apply to every token equally — memoing those would bench the
  entire candidate list over a credentials problem. Caught by a test, not by
  reading.
- **The permanent ledger records what was LISTED.** `rememberListed` folded the
  site's ENTIRE roster, so anyone posting a contract to the public form
  (unauthenticated, `pending`) locked that token out of free listing for ever,
  as did every submission an admin rejected. Approved rows only; `known` still
  skips everything for the current cycle, which is a different rule.
- ⚠️ **AN UNREADABLE STATE FILE IS NOT A FIRST RUN.** `loadJSONSync` answers
  `def` to both, and `everListed` is the append-only ledger that stops a
  previously PAID listing being handed back free — so a truncated write read as
  `{}` and the next save made the loss permanent, mirrored to Mongo. The scan
  now REFUSES to run and pages once; `readJSONSync` is what tells the two apart.
- **`fileReport` merges the ledger instead of writing its snapshot back.**
  `fulfillment.js` calls `rememberListed` the moment a paid listing goes live,
  which can land in the middle of a forty-lookup scan.

#### So it cannot go quiet unnoticed again

The causes will keep changing — that is the lesson this repo has already paid
for three times on the trending board. What is watched is the PROMISE the
operator set when they switched it on: **free listings actually go out.**

| layer | stops |
| --- | --- |
| `report.refused` / `unpriced` / `unsupported` + the blocker ladder | a fault rendered as a quiet market |
| `listingWatch.js` in the running bot | the operator being the detector |
| `api.canCreate()` on 🔎 Test scan | the panel promising a listing the site would refuse |
| `npm run listing:check` + the build stamp | "which of the six is it?", on the box |
| `dexscreener.test.js` | a parser drift that reads as an empty market |
| `servicesLoad.test.js` | a service module that cannot be required at all |

- **`listingWatch.evaluate()` is PURE** and the caller owns persistence, so a
  test walks the service through days of scans in milliseconds. Transition only,
  after `LISTING_QUIET_GRACE_MS` (12h — the shipped pace is one listing every
  2–3h, and a market that hands us nothing for an afternoon is ordinary); a
  RECOVERY is an alert too; it repeats every `LISTING_QUIET_REPEAT_MS` (24h).
- **It says when nothing is wrong.** A quiet market is reported as
  `ℹ️ … the service is running correctly — this is what it found`, with the
  dominant rejection reason; only a real fault gets ⚠️. A monitor that cries
  wolf at a quiet market is one that gets muted, which is why the trade bot's
  "possible rug" alert had to be deleted rather than tuned.
- **A blocked scan is left to the blocked-scan watchdog** — one fault, one
  alert. The clock keeps running so the recovery still fires.
- ⚠️ **`listing:check` exits ZERO on a quiet market**, and non-zero only when
  free listings CANNOT happen. A check that is always red trains the reader to
  ignore the red, which is the state `chart:preview` sat in for weeks.
- **§5 probes the WRITE path** with a payload the site's validator refuses
  outright (`{}` → 400), so it can never create anything — and a 400 back is the
  proof: authorised, reachable, validator working. `api.canCreate()` is the one
  owner, shared with 🔎 Test scan, because a check that asked its own way is how
  `fonts:check` printed nine green ticks over a banner publishing boxes.
- ⚠️ **`servicesLoad.test.js` exists because this fix nearly shipped broken.**
  `autoLister` requires the new `listingWatch`, and a commit taking the modified
  file without the new one would have produced `[monitoring] service
  "autoLister" failed to start` — with the panel reading 🟢 ON and "the scanner
  has gone quiet", i.e. **the exact symptom being fixed**. It requires every
  module in `src/services/` and every path `attach.js` names, and it is
  mutation-tested against that hazard. Its source scan strips comments first:
  attach.js's header quotes `require("./x")`, the very line it was written
  about.

```bash
cd bot && npm run listing:check                                     # per box: which of the six it is
cd bot && node scripts/run-tests.js test/listingBlocked.test.js \
    test/dexscreener.test.js test/servicesLoad.test.js              # 51 tests, no network
```

**Config a fix depends on:** nothing. `LISTING_QUIET_GRACE_MS` /
`LISTING_QUIET_REPEAT_MS` exist for an operator who finds 12h too twitchy, and
`DEXSCREENER_BENCH_MS` widens the back-off. ⚠️ **But whether DexScreener answers
this box at all is a property of the server's egress today** — it answers 403
from the sandbox this was written in — so `npm run listing:check` on the box is
the only thing that can say which of these the operator is actually hitting.
⚠️ And an install whose ledger was already poisoned by public submissions keeps
those entries: the fix stops new ones, and 🧹 Clear history is still the only
eraser, which re-opens everything at once.

#### The audit round — nine of these were in the FIX

Run against the finished change by seven independent lenses, and every defect
found is one of this file's own recurring shapes, reintroduced by the code
written to stop it.

- ⚠️ **THE HALT WAS INVISIBLE TO EVERYTHING THAT NEEDED TO READ IT.** Both new
  refusals decline to WRITE — that is what makes them halts — so `lastScan()`
  goes stale, and a stale report is exactly what `alScanLine` and
  `listing:check` read as *"the loop has stopped"*. The fix would have accused a
  perfectly healthy loop and sent the operator to pm2 to hunt a process that was
  running fine. Worse, the first cut put the halt in a MODULE-LEVEL VARIABLE —
  and the loop runs in `dexvra-bot` while the panel runs in `dexvra-adminbot`
  and the check is a third process again, so it was invisible to both anyway.
  Its own two-field file, written and AWAITED (a fire-and-forget write races the
  readers it exists for), cleared by the first scan that files a report — with a
  recovery alert, because a fixed halt and a forgotten one look identical.
- ⚠️ **AN UNREADABLE CONFIG READ AS "the operator switched it OFF".**
  `DEFAULTS.enabled` is false, so a corrupt or root-owned `autoLister.json` —
  DATA_DIR is shared by both PM2 processes, one `sudo node scripts/…` is enough
  — took the new OFF branch, and the panel and the check then both told the
  operator to tap **▶️ Enable**, which calls `set()`, which writes `{...get()}`
  and so overwrites every tuned threshold with the shipped defaults. A read
  failure laundered into a settings wipe, by the very code written to diagnose
  it. `configOk()` is its own question (never a field on the config — that
  object is compared against DEFAULTS field-for-field and is what `set()` writes
  back), the scan halts instead, and `set()` refuses.
- ⚠️ **THE LEDGER MERGE UNDID 🧹 Clear history.** The merge that stops a paid
  listing's entry being dropped mid-scan unions fresh into stale — so a clear
  landing inside the scan window (up to forty serial lookups, minutes wide when
  DexScreener is slow, which is exactly when somebody taps it) restored every
  entry just deleted. The panel would report the history cleared and the tokens
  would go on being refused for ever. `clearedAt` is stamped by the clear, and a
  snapshot older than it loses its token bookkeeping and keeps only its report.
- ⚠️ **`rememberListed` HAD THE GUARD ONLY AT ONE CALL SITE.** `fulfillment.js`
  calls it the moment a PAID listing goes live, outside any scan — so an
  unreadable state file at that moment still wiped the ledger, the pace clock
  and the day count. The guard belongs in the writer: *a caller can be wrong
  about what it is holding, and the store cannot.*
- ⚠️ **🧹 Clear history WIPED THE SCAN REPORT**, so the panel instantly printed
  *"the scanner has never reported … it is NOT running"* over a healthy loop,
  from the operator's own tap. The report is an observation about the LOOP, not
  knowledge about tokens; it survives, and so does `blocked`.
- ⚠️ **`log.attach()` RAN AFTER `setupMonitoring()`**, so the
  `🚨 N background service(s) did not start` page — the ONE alarm for a dead
  auto-lister loop — went to a logger with no bot attached and was dropped into
  pm2's stdout. That is the two-day incident `attach.js`'s own header was
  written about, with its fix undone by boot order. Pinned by a source scan that
  strips comments first.
- **↩️ Reset resets every setting but the switch**, and the toast said only what
  it did NOT change — silent about the pace going back ON, the packages falling
  back to Free and the chain scope reopening. It names what moved now, in an
  alert rather than a toast when anything did.
- ⚠️ **The Test scan verdict promised a listing over the two gates that run
  BEFORE the pace** (the service switched off, and the daily cap), and its
  4096-char trim shortened only the PANEL half — so a blocker that now names
  each failing source could build a message Telegram rejects outright, losing
  the verdict entirely and leaving the button reading as dead precisely when it
  had an answer. Bounded at source, capped at eight qualified rows.
- **The ready line printed over a loop the panel had already worked out was
  dead.** Dropped, never reworded — and ordered by CERTAINTY: a switch and a cap
  the operator set are known facts, "the scanner has not reported" is an
  inference.
- **A refused admin tap was never answered**, so every button on every admin
  panel spins for ever for a non-admin — indistinguishable from a handler that
  does not exist. `guard()` answers now, which is the one-owner fix: a guard the
  fortieth handler has to remember is one it forgets.
- **Every state write was `.catch(() => {})` and the loop's own exception handler
  was `log.debug`** — both produce nothing at any level production prints, and
  both look exactly like a dead loop.
- ⚠️ **…AND `reset()` NEVER GOT THE GUARD ITS SIBLING JUST GOT**, which is the
  worse of the two to miss. `get()` answers DEFAULTS for an unreadable config,
  so `wasEnabled` read FALSE, and ↩️ Reset would write the shipped defaults over
  a file it could not read **and switch the live feed off** — every threshold
  destroyed, from the one button whose whole contract is that it never touches
  the switch. A fix applied to one of two siblings is a fix half-made; the pace
  panel's success-path-only lesson, one function over.
- ⚠️ **AND THE GUARD THEN PRODUCED THE SYMPTOM IT WAS WRITTEN TO END.** `set()`
  and `reset()` THROW over an unreadable config — right, because writing over it
  wipes the settings — and a throw inside a `bot.action` is swallowed by
  `bot.catch`. So the operator taps ▶️ Enable, the button spins, the panel does
  not change, nothing reaches them, and free listings stay stopped: "tidak
  bekerja", manufactured by the guard. `alWrite()` is the one owner — fourteen
  try/catches is a guard the fifteenth handler forgets.
- ⚠️ **AND THE THIRTEENTH WRITE WAS LEFT BARE — the one channel `alWrite` cannot
  serve.** The ✏️ typed-value path is a `bot.on("text")` handler, so it has no
  callback to answer; the helper wrapped twelve call sites and this one stayed
  uncovered. A throw there is swallowed by `bot.catch`, so the operator taps a
  row, types `2h30m`, and the bot says **nothing at all** — no ✅, no ⚠️, no
  panel edit. That is the WORSE half of the pair: a spinning button at least
  spins. Found by the audit's own synthesis, after a fix that wrapped twelve of
  thirteen. So the rule is COUNTED now, not trusted: a test scans
  `adminBot.js` for every `autoLister.set|reset|togglePkg` and fails on any that
  is neither inside `alWrite` nor inside a `try` — a fourteenth handler added
  later forgets in exactly the same way, and its symptom is this whole section.
- **Three things were asserted in comments and nowhere in a test**, and each is
  invisible in the reassuring direction: `api/dexvra.js` had NO test at all (a
  POST that really created the row but whose envelope we stopped reading makes
  the bot page the operator about a site that is working); "a launchpad record
  does not make a refusal into an answer"; and "REFUSALS ONLY, never a 5xx" on
  the bench, where arming it would take pricing AND all three feeds down from
  one slow response. Eleven panel buttons — ▶️ Enable among them — could be made
  completely inert with 1789/1789 green.

#### The first live run was GREEN — and it named the one source still collapsing

`npm run listing:check` on the box, straight after the deploy:

```
2 · The scan loop
  ✓ last scan 2 min ago: 76 candidates seen · paced — next free listing due in 1h25m
    today: 1/5 · listed all-time 106 · never-relist ledger 509 contracts
3 · Discovery
  ✓ token-profiles/latest/v1 → 29 · token-boosts/top/v1 → 30 · token-boosts/latest/v1 → 29
  ⚠ poolstrade → 0 candidate(s)
  ✓ 76 merged — solana 53 · robinhood 17 · bsc 4 · ethereum 1 · base 1
4 ✓ /api/internal/listings → 411      5 ✓ write path reachable and authorised (400)
6 ⚠ 15 priced (a sample) · 0 would be listed — below its trigger ×14 · low 24h volume ×1
Free listings can go out: the loop is alive, the market is visible, and the site takes writes.
```

The feed is publishing (`today: 1/5`, all-time 105 → 106), and **17 Robinhood
candidates arrived through DexScreener** — the `DEXSCREENER_SLUG` flip and the
merge-not-override fix, both paying off on the one chain that used to read
`thin liquidity ($0)` for everything.

⚠️ **But `poolstrade → 0` was the same collapse this whole section is about,
one source over — and a comment in `discovery.js` asserted it could not be.**
That entry wrapped a plain `fetchDiscovery()` as `ok: true` on the stated
reasoning that *"a throw is the only failure it reports"*. Untrue:
`fetchLaunches` catches its own page failures and returns `[]` at debug level.
So a retired host, `POOLS_TRADE_ENABLED=0` and a genuinely quiet launchpad were
one line on the check, and the fix's own prose was the reassuring reading
written down. **A comment asserting a contract the module does not keep is
worse than no comment.** `fetchDiscoveryX` reports it now — first-page failure
only, because losing page three is a shorter list and not an outage — and the
check prints *"answered, 0 candidate(s)"* for a quiet pad rather than the same
⚠ a dead one gets.

⚠️ **And the next run named it: `✗ poolstrade → HTTP 409`** — the same line that
had been printing `0 candidate(s)` since the feature existed. Two things that
answer needed:

- **The reason was thrown away.** `fetchPage` raised a bare
  `Error("HTTP " + status)`, so the gateway's own sentence — Uniswap's is a
  private Connect-RPC endpoint, and its refusals name the header or field they
  wanted — never reached anyone. That is this file's own rule ("an HTTP error
  puts the explanation in the response body") broken on the one source whose
  request shape is a guess. The body travels now, flattened and bounded.
- ⚠️ **RED, BUT NOT FATAL — AND THE CHECK HAS TO SAY WHY.** A ✗ printed above a
  green *"Free listings can go out"* is a mixed signal the reader has to decode,
  which is how a check stops being read. pools.trade supplies PRE-MIGRATION
  launches: a bonding-curve token has no pool, so it fails `minLiq`, `minVol24`
  and `minAgeHours` **by definition** — `discovery.js`'s own header says exactly
  this about launchpads. What a dead pad costs is visibility of launches before
  they graduate, not listings. The check names that cost in place, and points at
  `poolstrade:check` rather than leaving a red mark with no verdict attached.

**And "below its trigger ×14" is the market, not a fault** — the check says so
in as many words, and the layer that decides is `TRIGGER_JITTER_OF_FLOOR`, one
section up. Lower 🎯 From to widen it. With `max 5/day` under a 2h–4h pace
(≈ 6–12/day) it is the CAP that binds, which is what the panel's own arithmetic
line prints.

⚠️ **One thing deliberately NOT changed.** The age gate fails OPEN on an unknown
`pairCreatedAt` (`if (info.pairCreatedAt && …)`), which is the inverse of this
file's rule that a floor is a CLAIM an unknown value cannot satisfy. Closing it
would refuse every token from a source that does not publish the field — and
making a gate stricter inside a change whose whole purpose is to get listings
flowing is the wrong direction to be wrong in. Recorded so it is not
rediscovered as an oversight.

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
npm test    # tokenLogo / logoFill / logoWrite / logoPipeline — 56 tests, no network
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

### "Kalo token belum listing hapus chartnya"

The unlisted token page — what `/token/<chain>/<ca>` shows for a contract nobody
has listed — charted too. It was added for a good reason (every buy-bot alert
links there, the buy bot is free and runs on ANY contract, so for most arrivals
that IS the token page) and removed for a better one, on the owner's call.

**The page is reachable by pasting any contract at all.** So every visit polled
`/api/ohlcv` for a token that is not on the site, out of the ~15 req/min
GeckoTerminal share the web app splits with the bot suite on this box — a listed
customer's chart competing for the ceiling with an unlisted stranger's. Charting
is what a listing buys.

- **The price and market cap STAY**, and the difference is what they cost: they
  ride ONE cached `/api/token-preview` request the page already makes, where a
  chart is a fresh poll per visit. They are why a visitor off a buy alert reads
  the page as a product rather than a 404, which is the whole reason the dead
  end ("Only paid listings appear here" plus a Back button) was replaced.
- ⚠️ **Two removals, two reasons, and collapsing them is how one comes back.**
  The third-party **EMBED** was banned separately, because it sat on "Loading
  chart settings…" for seconds and then planted a competitor's logo and wordmark
  across a Dexvra page. That ban is not what was relaxed, and the test asserts
  both independently — plus the CandleChart component's own no-iframe guard,
  which moved to `chartRoute.test.ts` now that this page no longer mounts it.
- **A deleted feature leaves a note where it was.** With no trace, the next
  person to notice this page has no chart simply adds one back — and the quota
  it spends is invisible from the page itself. A test pins the note.

```bash
npm test    # unlisted / chartRoute — 311 tests, no network
```

**Config a fix depends on:** nothing.

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

### The IP was the ceiling, and the web app had SIX doors onto it

The first live request after deploying the chart answered
`(GeckoTerminal 429)`, and a bare `curl` to GT from the same box answered 429
too. So this was never a chart bug: **GT's free tier is ~30 requests a minute
counted PER IP**, the bot suite lives on that same box, and the web app had
just started asking for candles on top of it.

What the web app was doing to itself is the shape `bot/src/group/gtPairs.js`
warns about in its own header — *"Two modules with their own fetch and their own
backoff means one of them keeps hammering through a 429 that the other has
already noticed"* — except it had **six**: the market pipeline, the pool
resolver, the candles route, the trades feed (polled every ~12s by every open
token page), the token preview and the logo resolver. Each with its own base,
its own headers, its own idea of failure, and no key support at all.

`src/lib/providers/gt.ts` is the one client now, and it is the bot's rules
transplanted:

- **A 429 from ANY caller silences ALL of them** for `GT_COOLDOWN_MS` (120s,
  the bot's number, so there is one figure to reason about across two processes
  on one IP). While it holds, `gtGet` answers *"rate limited — cooling down for
  Ns"* **without making a request**, and every caller treats that as "could not
  ask" — never as "nothing there". That last part is what stops a rate limit
  being written permanently into the listing store as "this project has no
  logo".
- **A 5xx or a timeout does NOT arm it.** Those are per-request failures and say
  nothing about the quota; arming a process-wide cooldown for one slow pool
  would take every chart on the site down for two minutes.
- ⚠️ **The cooldown is re-checked AFTER the pacing gap.** A request that waited
  its turn may have been overtaken by a 429 armed by whatever went out ahead of
  it, and firing it anyway is how a cooldown gets extended.
- ⚠️ **A 429 now ends the market cycle's remaining chunks**, where before it
  skipped one chunk and carried on. The old behaviour only ever "worked" in a
  mock: a 429 means the IP is over its ceiling, so the next chunk is another 429
  that extends the window. The tokens that miss out do not go blank —
  DexScreener prices the leftovers and `fillFromLastGood` covers the rest.
- **The chain's error is the FIRST failure, not the last.** Once a 429 arms the
  cooldown every later chunk fails with "cooling down", and reporting that would
  hide the 429 that caused it.
- **`GECKOTERMINAL_API_KEY` is read by the web app now**, exactly as the bot
  reads it: the key switches the base to the Pro one and sends
  `x-cg-pro-api-key`. It is the only real way past the ceiling.
- **The boot line says which tier is in use** and never the key
  (`[gt] PUBLIC free tier (~30 req/min per IP…)`), because "the chart is empty"
  looks identical from outside whether the ceiling is 30/min or the Pro tier's.
  Same reason the trade bot prints `rpc PUBLIC default (rate-limited)`.

```bash
npm test    # gt / geckoterminal — the cooldown, the key, the chunk rules
pm2 logs dexvra --lines 50 --nostream | grep '\[gt\]'   # which tier this box is on
```

**Config a fix depends on:** `GECKOTERMINAL_API_KEY` in the **repo-root** `.env`
(`/opt/dexvra/.env` — the web app does not read `bot/.env`). Until it is set the
site stays on the shared free tier and a busy minute still ends in a cooldown;
everything degrades honestly, but the ceiling is the ceiling.

### …and the bot was the one spending it — "chartnya mana"

The web app was cut back six ways and the charts still came back
`(GeckoTerminal 429)`. Everything above is about the web app's SHARE of the
ceiling, and the web app was never the one eating it: the bot suite on the same
box was, and it had no idea the website existed.

**The ceiling is per IP, so the two processes' budgets have to ADD UP TO IT.**
`GT_MAX_RPM` defaulted to 25 against a ~30/min ceiling — "comfortably under",
and true for as long as the bot was the only thing on the box. It has not been
for a while. Three changes, and the first two are the same rule in two modules:

| where | was | is |
| --- | --- | --- |
| `pumpChecker` | `fetchMarket` — GT-first, every approved listing, every 3 min | `fetchPrice` — DexScreener first |
| `gtPairs.fetchPool` | GT first, DexScreener as fallback | DexScreener first where it indexes the chain |
| `GT_MAX_RPM` default | 25 (a solo ceiling) | 15 (half of 30 — a SPLIT) |

- **A PRICE has two free sources; a CANDLE has one.** That asymmetry is the
  whole argument. GeckoTerminal is the only free OHLCV for arbitrary DEX
  tokens, so a request spent there on a number DexScreener also publishes is a
  chart that does not draw. `fetchPrice` is for callers that read `priceUsd`
  and `mcap` and throw the rest away; `fetchMarket` stays GT-first and is still
  right for anything publishing a 24h change, liquidity, a pool address or a
  logo — GT is the better source for all of those, and on Robinhood/Plasma the
  only one.
- **It is one ORDER, not a second client.** `fetchMarket(chain, addr,
  { cheap })` reuses the same two readers and the same merge; a third private
  answer to "is GeckoTerminal up" is what this repo keeps paying for.
  ⚠️ And the cheap pass must REUSE a DexScreener *miss* rather than re-ask —
  `dsFirst || await fetchDS(…)` re-asks on every miss, because a miss is null,
  which doubles the load on the source the change exists to prefer.
- ⚠️ **A stored pump baseline is now compared against the other source — and
  that is not new.** `fetchMarket` has always fallen through to DexScreener
  while GT was cooled down, so a GT-recorded baseline has been measured against
  DexScreener readings intermittently, flipping poll to poll. Reading one
  source consistently is steadier than alternating, and the ladder's floor is
  +100%: a source disagreement large enough to fabricate a step is the poisoned
  pool `pickTrusted` already catches.
- **The buy bot's interval was NOT lengthened, and the measurement is why.**
  That was the plan — and `BUYBOT_POOL_MIN_MS` turns out not to be a GT knob
  any more. Detection comes off the chain (`group/chainTrades.js` reads the
  pool's own Swap events on every EVM and Solana chain), and the metadata read
  is capped by `META_TTL_MS` at one a minute per pool however fast the loop
  runs. So lengthening it would have bought alert latency for almost no quota.
  What the buy bot actually spends GT on is that metadata read — hence the
  source order, which costs nothing at all.
- **A `[gt]` boot line in the bot too**, beside the build sha, because the two
  lines together are the only way to see how the one allowance is being split.
  The KEY is never printed; it would land in pm2's log.
- **`buybot:check` names the neighbour.** It used to advise checking "whether
  you are sharing an IP with something else hitting GT's ~30 req/min" — which
  sent an operator hunting for a stranger. It is the website, on this box, and
  a diagnostic that knows the answer should say it.

```bash
cd bot && node scripts/run-tests.js test/gtQuota.test.js   # 11 tests, no network
pm2 logs dexvra-bot --lines 50 --nostream | grep -F '[gt]'  # the bot's half
pm2 logs dexvra     --lines 50 --nostream | grep -F '[gt]'  # the site's half
```

⚠️ **This touches `bot/`, so the deploy is the ecosystem restart, not just
`pm2 restart dexvra`** — see "Two bot processes, one config".

**Config a fix depends on:** nothing. `GECKOTERMINAL_API_KEY` is still the only
thing that raises the real ceiling rather than dividing it; until it is set,
30/min is 30/min and this only decides who gets which share.

### "apakah anda yakin, coba audit" — six of these were in the FIX

Asked straight after the two features above landed, and the answer was no.
Every defect found is one of this file's own recurring shapes, reintroduced by
the code written to stop it.

- ⚠️ **A 429 FROM COINGECKO COST ONE CALL PER ROW, AND THE BOT PAYS THE SAME
  BILL.** The sweep paced its calls and then, on a rate-limited minute, spent
  every remaining row proving the same refusal — sixteen requests into a service
  that had already said no, every one of them landing as "undecided" anyway. A
  429 now arms a PROCESS-WIDE cooldown and the rest of the sweep is not asked at
  all. `bot/src/services/tokenLogo.js` states the identical rule about
  GeckoTerminal's cooldown and names what ignoring it cost: *"one rate limit
  deleted eighty-three rows' worth of evidence."*
- **CoinGecko was asked even when DexScreener had already answered.** It is the
  paced, per-IP, shared-with-the-bot one; a call made when the artwork is
  already in hand is a call the next row does not get. Two waves now: the two
  indexes together, then CoinGecko only if they came up empty.
- ⚠️ **`status: "ok"` WITH NO GEOMETRY DREW NOTHING AT ALL** — no chart, no
  message, no error. `box` starts at `{0,0}` and only a ResizeObserver callback
  filled it, so a context without one rendered a blank panel for ever, which
  reads exactly like a chart still loading. It measures immediately now, and
  "we have candles and cannot draw them here" is its own sentence. The live dot
  was showing over that blank panel too: the reassuring reading of a state that
  was not.
- ⚠️ **The cache key was built from an UNVALIDATED chain.** `/api/ohlcv` checked
  the chain inside its loader, i.e. after `ohlcv:<chain>:…` had been handed to a
  cache with no bound and no eviction — a memory leak anybody could drive from a
  query string, for answers nobody could use. The chain is checked first now,
  **and `lib/cache.ts` is bounded** (1200 entries, evicted by last-write order,
  never by expiry — an expired entry is still the stale copy that keeps a
  provider outage from emptying the board).
- **An EMPTY candle list from a hinted pool ended the lookup.** A DexScreener
  pair address can be a real-but-thin GT pool that has never traded on that
  timeframe; reporting "no candles" for it hid the deep pool with a year of
  them. An empty answer now re-resolves, and a worse answer from the deeper pool
  never replaces candles the hint already gave us.
- ⚠️ **A comment described a ranking that did not exist.** "the board hands them
  over ranked" — it handed them over in whatever order the store held. The sweep
  looks up eight rows a pass and a board can be eighty short, so the order is a
  decision: featured rows first, then by 24h volume.
- **`//host/logo.png` was treated as same-origin.** It starts with a slash and
  loads from a stranger's server — the one url shape that looks local and is
  not. It goes through the proxy now.
- **Bodies nobody was going to read were left open.** `isImage`'s GET, the
  proxy's redirect hops and its wrong-content-type path all abandoned a response
  body, which keeps the socket busy until the GC gets round to it on a server
  doing this per token. All three release now, and an image declaring more than
  3MB is refused before it is downloaded rather than after.
- **`cloudfront.net` came off the proxy allowlist.** It would have made us an
  image CDN for every AWS customer alive — somebody else's bandwidth and
  somebody else's content, served from our domain.
- Two of the new guard tests were asserting on CHARACTER DISTANCE between two
  lines, so adding a comment between them failed the build. A test about
  formatting is not a test about behaviour; both compare positions in the
  comment-stripped source now.

**One consequence worth knowing about:** an admin who CLEARS a listing's logo
will see the site resolve one again, because an empty `logoUrl` is exactly the
state the sweep exists to fill. To pin a different image, set it — a stored
logo always wins. There is deliberately no "this token has no logo" flag: the
monogram is what a row with no artwork draws, and it is drawn from the ticker.

### "tambahkan logo project nya" — the only tool that filled them also deleted rows

Reported with a screenshot of the home board, `$TRUMP` drawing its `TP`
monogram (2026-08-26). The resolver was not the gap: `listings:fix` already
reaches **seven** sources. What was missing is that the same run **removes every
row it could not find artwork for**, and `--logos-only` does not change that —
it skips the dedupe pass, not the deletions. So an operator who wanted logos
filled had no way to run it without also losing tokens.

- **`--keep` is the opt-out, and the delete stays the DEFAULT.** It answers an
  earlier request in this script's own header (*"jika tidak ada logo hapus aja
  tokenya"*), and quietly reversing that would surprise whoever relies on it.
- ⚠️ **`--keep` is TOTAL.** A flag that spared the logo pass and still dropped
  duplicates would be the reassuring reading of its own name — this file's most
  expensive recurring shape. Mutation-tested: reinstating that one delete fails
  the test.
- **The rows that finish with no artwork are NAMED, with their address.** A
  count sends the operator back to the board to work out which — a diagnosis
  with no hands attached is a bug report the code files against its owner.
- **The header says which mode the run is in before it does anything**, in the
  dry run too.
- ⚠️ **Nothing here can be verified from a sandbox.** DexScreener, CoinGecko and
  GeckoTerminal are unreachable from the dev environment, so whether a logo
  exists is a property of the SERVER's egress today — the rule `raid:check`,
  `launchpads:check` and `fonts:check` already state. The script prints the
  build stamp twice for the same reason.

```bash
cd bot && npm run listings:fix -- --logos-only --keep            # dry run: what would be filled
cd bot && npm run listings:fix -- --logos-only --keep --apply    # fill them; delete nothing
cd bot && node scripts/run-tests.js test/fixListingsKeep.test.js # 6 tests, no network
```

### "jangan ambil dari gecko terminal" — the cleanup was starving the buy bot

Sent while the operator watched their own production stop, over and over, in
the middle of the logo run:

```
WARN [buybot] GeckoTerminal backing off for 120s — HTTP 429 (rate limited).
Buy alerts are paused process-wide until it lifts.
```

`resolveLogo` asked all five sources **concurrently, for every row**. So a token
whose artwork DexScreener already had still spent a GeckoTerminal request —
and 463 listings is 463 requests into a ~30/min **per-IP** ceiling shared with
the running bot. The cleanup was not slow; it was eating the thing it shares.

- **Two waves. The free sources first.** DexScreener (no tight limit), the
  launchpad (pump.fun and friends, artwork from the token's first minute),
  pools.trade, and Trust Wallet's constructed GitHub path. Most rows are
  answered here and **never reach the metered ones at all**.
- ⚠️ **GeckoTerminal is DEFERRED, never dropped.** On ROBINHOOD it is one of
  only two places the artwork can be — DexScreener does not index that chain
  and CoinGecko has no platform id for it — so never asking it would turn "we
  did not look" into a permanent `undecided` for a whole chain. Asking it last
  is the fix; not asking it is a different bug.
- **The site's resolver has always done this** (`src/lib/providers/tokenLogo.ts`
  states the rule in its own header: GT "is only asked when 1 and 2 came up
  empty"). The bot's never learnt it — two resolvers, one lesson, learnt once.
- **The CONVENTION stays last of all.** `dexscreener-cdn` is a path we build,
  not an answer anybody gave: a guess must always lose to an answer.
- Mutation-tested — restoring the single concurrent wave fails four tests, two
  of them tests that predate this change.

```bash
cd bot && node scripts/run-tests.js test/tokenLogo.test.js   # 28 tests, no network
```

**Config a fix depends on:** nothing — but `GECKOTERMINAL_API_KEY` in
`bot/.env` is still the only thing that raises the real ceiling rather than
dividing it, and a cleanup over hundreds of rows is exactly when that shows.

### "punya logo pas listing, skrg sudah ilang" — two ways a row loses artwork it HAD

Reported with a screenshot of `$BREAKING`'s token page (2026-08-26): a paid
Solana listing, five days old, drawing the site's `BR` monogram. Every section
above is about a row that never had a logo. **This one had one, and lost it**,
which is a different failure and needed a different answer — and the two causes
found are both the same shape, a value deleted by something that was not asked
to delete anything.

#### 1. A RE-LIST ERASED IT

`addListing` treats a chain+address it already holds as the same listing and
keeps its id — and then wrote the incoming row over the stored one **whole**:

```js
created = { ...rec, id: rows[dupIdx].id, … };   // rec, not a merge
rows[dupIdx] = created;
```

`buildRow` renders an absent optional field as `undefined`
(`logoUrl: input.logoUrl ? … : undefined`). So every re-POST of a token the
site already carried **deleted whatever it did not re-supply**: the logo the
project uploaded on the listing form, their socials, the overview — and
`trendingRank` / `trendStart` / `trendExp`, i.e. a trending window somebody had
paid for, ended mid-flight.

There are four callers that re-POST an existing token in the ordinary course of
business — a second purchase through `fulfillListing`, `autoLister`, the board
filler through `createFromInfo`, a project re-submitting the public form — and
none of them carries a logo it was never given.

- **`src/lib/relist.ts` is the rule, and it is "ABSENT MUST NOT ERASE", not
  "never change".** A re-list that carries a value still wins: an operator
  re-listing with new artwork gets the new artwork. What it may no longer do is
  turn something into nothing by saying nothing — the same asymmetry
  `applyResolvedLogo` is built on, pointing the other way.
- **Clearing a field is the PATCH path's job.** `sanitizePatch` reads `""` as
  "clear this" precisely because an edit can mean it; a create that arrives
  without a field is not a statement about that field. A blank string counts as
  absent here for the same reason — it is what an untouched form field becomes.
- **The guard lives at the STORE, not at the caller.** `deleteListing`'s own
  header already says why: *"a caller can be wrong about what it is holding,
  and the store cannot."* The DELETE path has refused to touch a paid listing
  for months; the CREATE path was destroying the same rows.
- Pure and mutation-tested — reinstating the wholesale overwrite fails
  `logoPipeline.test.ts`.

#### 2. THE UPLOADED FILE IS GONE, AND TWO CORRECT GUARDS HELD THE DEAD URL IN PLACE

An uploaded logo is `/api/media/<24hex>.png`, written to `data/uploads/`.
`data/listings.json` is mirrored to Mongo and restored from it — store.ts says
so at the restore path, *"fresh container after a VPS reset"* — and
**`data/uploads/` is not mirrored at all.** So a box that loses its disk comes
back with every listing intact, every one still asserting its `/api/media/…`,
and not one of those files on disk.

⚠️ **And the row is then monogrammed FOR EVER**, by two rules that are each
right on their own:

| rule | why it is right | what it does here |
| --- | --- | --- |
| `pickLogo` ranks `stored` first | somebody CHOSE that image | the row reads as "has a logo", so the resolver never queues it — the queue is `convention \|\| none` |
| `applyResolvedLogo` never overwrites a `logoUrl` | it is what makes a background sweep safe | even a logo resolved in memory could never be persisted |

- **A stored upload with no file is not a stored logo** — it is a 404 wearing
  the shape of a decision, and it loses to every rung below it.
- **ONE directory listing per board rebuild**, not one stat per row: the board
  reprices ~200 rows every 60s.
- ⚠️ **"The directory could not be READ" is not "the files are gone."** An
  unmounted volume, a permissions change and a container mid-restore all answer
  identically, and reading that as a deletion would strip the artwork off every
  paid listing on the site in one sweep. `lostUploads` reports **nothing**
  missing when it cannot look. A missing directory is empty (nothing was ever
  uploaded on this box); an unreadable one is unknown.
- **It can only ever clear an UPLOAD.** A CDN blip, a hotlink block or a rate
  limit are not facts about the token and none is knowable from this server;
  clearing an external logo would delete a project's artwork over a bad minute.
  An upload is on our own disk, so its absence is a local fact.
- **The row is cleared in the STORE too**, or the resolver's answer has nowhere
  to land — and it is said out loud once, because artwork disappearing off a
  paid listing is a fact an operator is owed even when the site heals it.
- **`UPLOADS_DIR` is one owner now.** Three files declared
  `path.join(process.cwd(), "data", "uploads")`, and it matters more once the
  board asks whether an upload is still there: a reader pointed at the wrong
  directory reports every paid listing's logo as lost. ⚠️ It deliberately does
  **not** honour `DATA_DIR` — `store.ts` does, so on a box that sets it the
  listings and the uploads already live apart, and teaching this path about it
  would move where the app LOOKS without moving the files.

#### …and the operator was the detector, so there is a check

Three things produce that monogram and the board renders all three identically:
the row lost its logo, the file is gone, or **our own proxy refuses a working
url** because its host is missing from `/api/logo`'s allowlist. They need three
different fixes.

```bash
npm run logos:check                       # every listed token
npm run logos:check -- solana VJdpSDD…    # the one somebody is asking about
npm run logos:check -- --bad              # only the rows that fail
```

- **It drives the RUNNING SERVER and pulls every logo through `/api/logo`** —
  the same url `logoSrc` hands the browser. Whether a CDN answers is a property
  of this box's egress today (the rule `raid:check`, `launchpads:check`,
  `fonts:check` and `chart:check` all state), and a check that reasoned about
  the url instead of loading it would print green over exactly the rows that
  draw monograms. It also cannot import `src/**/*.ts` — production runs Node 18,
  where that throws.
- **With `INTERNAL_API_TOKEN` set it also reads the STORED row**, which is what
  separates "this row lost its logo" from "this logo will not load". ⚠️ Without
  it the answer is genuinely ambiguous for a CDN-shaped url — the seed listings
  STORE that exact string — and it says so rather than guessing: the first cut
  reported *"nobody has given this token artwork"* over rows that had one.
- **`/api/tokens` carries the build stamp now**, for the reason `fonts:check`
  prints one: every round of this begins with somebody reading a check as a
  statement about the fix they just deployed.
- Non-zero when any row would draw a monogram, so green means "the board's
  artwork is safe" and not "the server answered".

```bash
npm test    # relist / mediaFile / logoWrite / logoPipeline
```

⚠️ **What could NOT be verified here.** The merge and both takeover locks are
proved end to end against a running server: a re-list with no optional fields
leaves the logo, the socials, the overview and a live trending window untouched
and one carrying a new logo still wins; a public submission for a live listing
answers 409 and changes nothing. The lost-upload healing is proved by its unit
rules and its wiring only: it runs inside `loadListedTokens`, which needs at least one
market provider to answer, and this sandbox has no egress — on a box where
every provider is down the board falls back to `rowsToBoardTokens` and the
ladder does not run at all. `npm run logos:check` on the server is how that one
gets measured.

**Config a fix depends on:** nothing. `INTERNAL_API_TOKEN` only makes the check
more specific. ⚠️ And the durability hole is still open by design:
`data/uploads/` is not in the Mongo mirror, so a lost disk still loses the
uploaded FILES — what changed is that the site now notices and re-resolves
instead of drawing a monogram for ever.

#### …and the first live run named a cause nobody had considered

`npm run logos:check -- solana VJdpSDD…` on the box, the moment it was
deployed:

```
· $BREAKING  solana  external  ipfs.io/ipfs/bafkrei…  HTTP 404
```

**404, not 400** — so the host passed the allowlist, our proxy reached it, and
the gateway simply did not have the CID. The row never lost its logo and the
url was never wrong. `/api/logo` held **one hardcoded IPFS gateway**:

```js
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
```

⚠️ **"Never one hardcoded host" is this file's own first rule**, written when
Jupiter retired `quote-api.jup.ag/v6` and every Solana buy died — and the logo
proxy had been breaking it since the day `ipfs://` support was added. A launchpad
pins its artwork wherever it pins it; asking one public gateway and giving up is
a coin toss per token.

- **`IPFS_GATEWAYS` is a LIST**, env-overridable (`IPFS_GATEWAYS=`), so a gateway
  going dark costs a line in `.env` rather than a deploy — the `pads.js`
  contract. Every entry is asserted to pass the allowlist, or the failover would
  build urls the guard then refuses: a fallback that cannot fire, which reads
  exactly like one that never helps.
- ⚠️ **IT FAILS OVER ON AN HTTP STATUS, WHICH THE STANDING RULE FORBIDS** — and
  that is deliberate, not an oversight. The rule says transport-only because
  *"an HTTP status means the host is there and answered, and the same request
  gets the same status everywhere else."* **That is not true of a
  content-addressed fetch.** A CID is the hash of the bytes, so another gateway
  serving that CID serves byte-identical content: a 404 is a fact about the
  GATEWAY, not about the token. A DexScreener CDN 404 still ends the lookup, and
  `candidates()` is the one place that distinction lives.
- **The gateway the caller named is tried FIRST.** A working gateway must not be
  demoted by a fallback list.
- **Bounded in tries and in TIME.** Without a deadline the worst case is every
  gateway's full timeout end to end, per token, on a board asking for two
  hundred.
- ⚠️ **A redirect somewhere we do not allow ends the whole request** rather than
  falling through to the next gateway: that failure is about US being pointed at
  something, not about the content being unavailable, and retrying elsewhere
  would bury it.
- ⚠️ **`logos:check` TRUNCATED THE URL ON THE ROWS THAT FAILED.** The column is
  elided to keep the table readable, and it elided the one line whose whole job
  is showing the url that broke — `ipfs.io/ipfs/bafkrei…` cut at exactly 46
  characters, which reads as a malformed CID rather than a clipped one. An
  operator cannot copy it, paste it, or tell the two apart. Same defect as
  `From $1,000,0…` on the row that exists to show a value. The full url now
  prints under any row that did not load.

**Config a fix depends on:** nothing — but ⚠️ **whether a given gateway serves a
given CID is a property of the server's egress and of what that gateway has
pinned today**, which is precisely why the list is env-overridable and why
`logos:check` measures it on the box rather than reasoning about it here.

#### "apakah anda yakin coba audit lgi" — and the worst one was not the logo

Asked straight after the above landed. The answer was no, and the largest thing
found is in the same function and is not about artwork at all.

⚠️ **ANYONE COULD UNPUBLISH A PAYING CUSTOMER BY TYPING THEIR CONTRACT INTO THE
PUBLIC FORM.** `/api/submit` is unauthenticated and calls
`addListing(row, { status: "pending" })`. On a duplicate, `addListing` keeps the
existing row's id — so the submission never created anything, it **took that row
over**: the status went back to `pending`, `approvedRows()` filters on
`approved`, and the listing left the site. Five times per IP per ten minutes.
Measured, with the route guard removed and only the store lock in place: the
row came back reading `$STOLEN`. It also replaced the name, and — because a
public submitter may pick a package tier — handed out whatever tier they asked
for.

**Two locks, because each one leaves the other's half open.**

- **The route refuses a duplicate outright**, 409, naming which state it is in
  ("already listed" and "already in the review queue" are different things to
  the person typing, and neither is their fault). One token, one listing — the
  rule the bot's own flow states *before* it will take a form
  (`listed.blockIfListed`). Refusing is the only answer that cannot be turned
  into an edit of somebody else's row.
- **`keepStatus` at the store: a create may PROMOTE a row, never demote one.**
  Demotion is still perfectly possible through `setStatus`, which is what an
  admin rejecting a listing calls. What may not happen is a row losing its
  standing as a *side effect* of somebody creating something. It is at the
  store for the reason `deleteListing`'s guard is: *a caller can be wrong about
  what it is holding, and the store cannot.*
- ⚠️ **And the form reported the refusal as a success.** `pay()` fired the
  request and forgot it (`void fetch(…).catch(() => {})`), wrote the local "My
  listings" record and went straight to *"Submission received!"* — so a 400, a
  429, a dead network and now this 409 all showed a project a green tick over a
  queue entry that does not exist. It awaits the answer now, shows the server's
  own sentence, and writes the local record only after the server takes it.

And four more, all this file's own recurring shapes:

- ⚠️ **`lostUploads` keyed its answer by trimmed URL and the caller asked with
  the raw store value.** `lost.has(row.logoUrl)` was therefore false for exactly
  the rows the module exists to find — and the test written for it **asserted
  the mismatch and passed**. Two normalisers for one lookup key; `mediaName` is
  the only one now, and `isLostUpload` is the only way to ask.
- ⚠️ **`logos:check` would have been RED FOR EVER.** It failed on any row
  drawing a monogram — but a board always carries rows nobody has made artwork
  for, and the resolver's backlog is not a fault. A check that is always red is
  worse than no check: it trains the reader to ignore the red, which is the
  state `chart:preview` sat in for weeks. It now separates **broken** (a stored
  logo that will not load, an upload whose file is gone, a url our own proxy
  refuses) from **nothing to draw yet**, and only the first turns the exit code.
- **The `needLogo.sort` comment had been orphaned** by the block inserted above
  it — left describing the wrong line, which is the "a comment describing
  nothing" this file names one section over.
- **`logos:check` carries a port of `logoSrc`** (it cannot import `src/**/*.ts`
  — production runs Node 18), and a port is a second owner. A guard pins the
  four branches in both files, because a check that fetched the raw url would
  print green over every logo `/api/logo` refuses — one of the three causes it
  exists to name.

```bash
npm test    # relist / mediaFile / logoWrite / logoPipeline — the two locks included
```

### "token morty tidak ada logonya padahal di dexscrener ada" — the guard was not asking the renderer's question

Reported with a screenshot of DexScreener showing `$MORTY`'s artwork beside our
board drawing its monogram. Every source in the ladder was working: DexScreener
handed us the url. **`isImage` threw it away**, and it threw it away for a
reason that had nothing to do with the file.

`isImage` probes `["HEAD", "GET"]` — but only a **405/501** ever reached the
GET. Every other HEAD outcome returned: a non-2xx status, a non-image
content-type, an exception. So a CDN answering HEAD with 403 (or 404, or an
HTML error page, or by hanging up) was written off — while `/api/logo/route.ts`,
which issues a **plain GET, exactly like the browser**, could fetch that file
the whole time.

- ⚠️ **A GUARD IS ONLY HONEST WHILE IT MEASURES THE STACK THE RENDERER USES.**
  This is the `fonts:check` lesson — nine green ticks over a banner publishing
  boxes, because `warnBoxes()` measured a font stack that renderer did not draw
  with — one module over and pointing the same way. Any HEAD outcome short of
  "yes, an image" is retried as GET now, and only GET's answer is final.
- **This is NOT "fail over on a TRANSPORT error only" being broken.** That
  rule's stated reason is that an HTTP status means the host answered and *the
  same request gets the same status everywhere else* — and **HEAD and GET are
  different requests** to the same host, which is the one case the reason does
  not cover. Same shape as the IPFS gateway list failing over on a 404: there,
  a CID is the hash of the bytes, so the status is a fact about the gateway; here
  it is a fact about the method.
- The cost is one extra request per REJECTED candidate, against unmetered image
  CDNs, and the sweep is capped at eight rows.

**And a verification we could not COMPLETE was being written down as an
answer.** `pick()` read `if (await verify(url))`, so a url we were handed and
then failed to open — a timeout, a 5xx, a CDN refusing this box — fell through
to `ok: unreachable.length === 0`, which stayed **true**. `sweepLogos` wrote
that as `kind: "miss"`, would not look again for **twelve hours**, and the log
line said *"N with no artwork anywhere"* about tokens whose artwork we had in
hand. That is the module's own headline contract inverted: `ok: true, url: null`
is supposed to mean *every source answered and this project has no artwork*.

- **`checkImage` returns three verdicts**, because two of them are not the same
  fact: `image` · `not-image` (it ANSWERED and is not one — a 404, an HTML error
  page) · `unreachable` (no decision — DNS, a timeout, a 5xx, a refusal). A
  refusal or a 5xx is a fact about the HOST; only a non-refusal 4xx is a fact
  about the file.
- **An unverifiable candidate is an unreachable SOURCE**, so `ok` goes false and
  the sweep records `undecided` — retried in 30 minutes rather than 12 hours —
  and the url that could not be checked is NAMED.
- **A real `not-image` stays a decided miss.** Downgrading it would re-ask every
  30 minutes for ever, which is the other half of the same line.
- ⚠️ **The test fixture could not reach the branch it was written for.** Node
  stamps `content-type: text/plain` on a `Response` built from a STRING, so
  `reply(200, null)` still arrived carrying a type and the "no content-type at
  all" case had never been exercised. Bytes get no default type. A test
  measuring its own fake, for the second time in this file.
- Mutation-tested: HEAD's verdict being final again, the unverifiable candidate
  reading as "not artwork", and a 5xx reading as an answer each fail between one
  and three tests.

```bash
npm test    # tokenLogo (37) + logoFill (15)
```

### …and the site had never taken its half of the split

The bot's client was cut to `GT_MAX_RPM=15` — *"the ceiling is per IP, so the
two processes' budgets have to ADD UP TO IT"* — and **the web app never got the
other half.** Its only pacing was a 120 ms floor between requests, which is
~500 req/min: no budget at all. So the bot held politely to fifteen while the
site took whatever it liked, and both of them ate the 429 the split existed to
prevent. **A split one side observes is not a split.**

- **It is a PACE, not a refusal.** Over budget a request WAITS for a slot, up to
  `GT_BUDGET_WAIT_MS` (3s) — a chart that draws a second late beats one that
  does not draw. Only then does it give up.
- **It gives up the way the cooldown does** — `status: 0` — which every caller
  already reads as "could not ask" rather than "nothing there".
- ⚠️ **And it names itself, not GeckoTerminal.** Reporting our own pacing as
  `GeckoTerminal 429` sends an operator to check a service that is perfectly
  healthy, and reads as a fact about the quota rather than about us. The
  sentence names the two knobs that lift it.
- **A ROLLING window, never a per-minute bucket** — a bucket lets 15 requests go
  at :59 and 15 more at :00, which is exactly the burst the ceiling punishes.
- **The slot is counted when it is TAKEN, not when the response lands.** A
  request then skipped by the cooldown re-check has still reserved its place;
  over-counting spends a little under the allowance, under-counting spends over
  it, and over it is the 429.
- **The boot line PRINTS the budget** (`· budget 15/min from THIS process`),
  because a budget nobody can read is how this one stayed missing while the
  file it belongs to argued for it in prose.

```bash
pm2 logs dexvra     --lines 50 --nostream | grep -F '[gt]'   # the site's half
pm2 logs dexvra-bot --lines 50 --nostream | grep -F '[gt]'   # the bot's half
```

**Config a fix depends on:** nothing — `GT_MAX_RPM` in the **repo-root** `.env`
raises the site's share and `0` turns it off, and `GECKOTERMINAL_API_KEY` is
still the only thing that raises the real ceiling rather than dividing it.


## "bot tidak merespon untuk paket listing setelah di minta drop ca" — the form was queued behind every timer job

Reported 2026-08-28: the listing flow's CA prompt standing in the chat, a
pump.fun mint pasted under it, and nothing ever coming back — the bot alive
(it had just sent the prompt) and silent. **Nothing had crashed.** The contract
step awaited `fetchMarket` and `fetchTokenDescription`, and both wait on
`gtTurn()` → `gtSlot(PRIO_BACKGROUND)` — the shared GeckoTerminal queue, which
has **no deadline of its own**: one release per `GT_MIN_GAP_MS`, capped at 200
entries. The day before, the keyless budget was halved to 5/min (a 12-SECOND
gap per slot), so behind a normal day of timer pipelines — the trending
poster, autoTrend, the pump checker, the candle reads — a **user-prompted**
paste sat in the background tier for minutes. From Telegram that is a dead
bot, and it was reported as one. It "previously worked" because the budget was
15/min until the split was enforced.

- **The autofill is BOUNDED at the caller** (`LISTING_AUTOFILL_MS`, 8s per
  source). Autofill is an ENRICHMENT — every field it fills, the form lets the
  user edit — so a slow source contributes nothing and the form goes on: the
  registry's own dead-pad rule, applied to the form that reads through it. The
  background pipelines keep their queue semantics untouched; only the form
  stops waiting on them. The abandoned lookup still lands in its cache.
- **The paste is ANSWERED before the indexers are asked** — a "🔎 Reading your
  token's profile…" card goes out immediately, and the review card (or the
  next prompt) replaces it. A prompted input followed by seconds of nothing is
  "the button does nothing", the atrun lesson on a text prompt.
- ⚠️ **`bounded`'s timer is NOT unref'd** — the `gtDrain` rule one module
  over, relearnt by watching all four tests get "cancelledByParent": a user is
  waiting on that timer, and an unref'd one does not hold the event loop open,
  so a process with nothing else pending exits with the form hung forever.
- ⚠️ **A flow handler that throws now ANSWERS.** `textRouter`'s catch logged a
  warn and said nothing, so ANY error inside a form step left the prompt
  standing over silence — the refusal-off-screen defect, on text input. Both
  routers reply "That didn't go through — please send it again."
- Mutation-tested: unbounding the lookups and re-silencing the catch each fail
  their tests.

```bash
cd bot && node scripts/run-tests.js test/listingAutofill.test.js   # 4 tests, no network
```

**Config a fix depends on:** nothing. `LISTING_AUTOFILL_MS` widens the wait for
an operator with a GT key and an empty queue; `GECKOTERMINAL_API_KEY` is still
what makes the queue itself short.

## "robinhood chain price dll tidak ada datanya" — a chain of $0 rows, and no line anywhere saying why

Reported with a screenshot of the home board: seven Robinhood listings —
$GME, $INDEX, $PONS, $AAPL, $VEX, $WALL3, $WOJAK — every one rendering
`$0` price · `—` change · `$0` MCAP · `$0` VOL · `0` txns. Three different
failures render EXACTLY like that, and they need three different fixes:
GeckoTerminal has no data for those tokens (nothing to configure — a fresh
launchpad token has no indexed pool), GT is refusing/limiting the box (quota),
or GT answers fine and the site's own pipeline is broken. Nothing on the board,
in the store or in the logs could say which.

- ⚠️ **A chain whose every provider fails, failed SILENTLY.** `loadListedTokens`
  ran the per-chain fetches under `Promise.allSettled` and never looked at the
  rejections — a chain could throw on every cycle for a week and the only
  symptom was its rows sitting on their captured-at-listing zeros. One
  greppable `[market] <chain>: every provider failed this cycle — <why>` line
  per chain per cycle now.
- ⚠️ **The zeros themselves were CLAIMS.** Those `$0`s were the store's
  captured-at-listing defaults on rows no provider had priced — printed on a
  public board as three measurements per row that nobody made. `figureReading`
  is `changeReading`'s money-column twin, in the same module for the same
  reason: a zero from a row whose source never measured anything is a dash; a
  LIVE zero keeps its zero (a measured quiet day is a fact); a captured nonzero
  still prints (the demo board is built from those). Every money cell on BOTH
  row components goes through it — the 24h column already drew its dash while
  PRICE beside it claimed `$0`, two cells one inch apart disagreeing about what
  unknown looks like — and a source-scan test refuses any cell reading the raw
  field again.
- **`npm run market:check` says WHICH of the three it is, on the box.** It
  drives the RUNNING server's `/api/tokens` (what the board actually serves,
  build stamp included) and then GeckoTerminal DIRECTLY with the site's own
  request shape, per token: `GT prices it right now` → the fault is the site's
  half, read `pm2 logs dexvra | grep -F '[market]'` then `'[gt]'`; `GT has no
  record` → the token genuinely has no indexed pool and the board is honest
  about it; a 404/429 names the config/quota. ⚠️ The script carries a PORT of
  `chains.ts`' `geckoNetwork` map (production runs Node 18 — a check script
  cannot import `src/**/*.ts`, the `logos:check` rule), and a guard test pins
  the port equal to the real map — the first run of that guard caught the port
  missing thirteen chains, which is the guard doing its job on its author.

```bash
npm run market:check                # every chain, the worst one probed against GT
npm run market:check -- robinhood   # one chain, per token, with the next step named
```

**Config a fix depends on:** nothing for the code. Whether Robinhood rows can
price at all is a fact about GT's coverage of those tokens, measured on the
box — and `GECKOTERMINAL_API_KEY` in the repo-root `.env` is still the only
thing that raises the shared ceiling rather than dividing it.

### …and the first live run of the check named it: the budget race Robinhood always loses

`npm run market:check -- robinhood` on the box: every other chain mostly
priced (solana 162/192, bsc 75/78, base 17/17), **robinhood 0/66 — every row
blank** — and the direct GT probe answered **429**. That is not bad luck, it
is arithmetic: the site's own demand (~19 GT chunks per 60s cycle across all
chains) exceeds its 15/min budget, every chain fires CONCURRENTLY, and
whichever chunks queue last lose. A chain DexScreener also covers falls back
and prices anyway; **Robinhood is `dexscreener: null` — the ONE chain with no
second source — so it lost the race every cycle, deterministically**, while
the chains that could afford to lose were spending the budget it needed.

- **GT-only chains draw from the budget FIRST**, awaited before the covered
  chains start. `partitionByFallback` lives in `dexscreener.ts` beside the
  coverage map it reads (a second list of "which chains DS covers" would
  drift), and the priority is pinned by a source test — a priority group is
  only a priority while it is AWAITED first; launched concurrently it is just
  a longer list.
- ⚠️ **The first cut of this edit never landed** — the patch script failed on
  a later assertion AFTER the body edits and BEFORE the write, so `tsc`
  passed on an unused import over the unchanged concurrent block. The source
  test caught it; a green typecheck is not a landed change.
- **One good cycle now buys three hours of board**: `lastGood` serves the
  last real observation for `LAST_GOOD_TTL_MS`, so once Robinhood prices
  once, a later lost race degrades to slightly stale instead of `—`.
- **The ceiling itself is still the ceiling.** Priority decides who wins the
  site's share; it cannot make ~19 chunks fit in 15. `GECKOTERMINAL_API_KEY`
  in the repo-root `.env` (sixth time in this file) is the only thing that
  raises it — and with 66 robinhood listings and the bot suite on the same
  IP, this box has outgrown the free tier.

### "mengapa tidak pakai sumber dari dexscreener.com?" — because a fact had expired

The right question, and the answer used to be "DexScreener does not index
Robinhood Chain" — stated in five places across three packages, each with the
same justification, all written when the chain launched. **DexScreener added
Robinhood around July 2026** (`dexscreener.com/new-pairs/robinhood`), and from
that day every one of those entries meant the opposite of its own comment:
every robinhood read paid the shared ~30/min GT quota for a number DexScreener
now also publishes — on the chain with the most listings on the box.

- **The flip is one row in each package's own map**: `dexscreener: "robinhood"`
  in `src/config/chains.ts`, `DEXSCREENER_SLUG` in `bot/src/config/chains.js`
  (which also gives robinhood buy alerts a real chart button — the "known
  exception" list in `buyCta.test.js` is empty now), `GT_PRIMARY` in
  `bot/src/group/gtPairs.js` shrinks to `plasma` (robinhood pool reads go
  DS-first), and `DS_CHAIN_KEY` in `tradebot/core.js`.
- **Every consumer already knew what to do with a covered chain** — DS-first
  pricing, the market fallback, the CDN logo convention, the chart links —
  because none of them ever hardcoded "robinhood is special"; they all read
  their registry. The whole change is data.
- ⚠️ **The stale fact lived in TESTS as much as in code.** Seven tests across
  the three packages asserted "DexScreener does not carry Robinhood" as a
  permanent truth; each now tests the same RULE against a chain id that has no
  registry entry at all (`no-such-chain`), so the rule outlives the roster —
  a test pinned to a third party's current coverage is a test that expires
  without notice.
- **Whether DS actually answers for a given robinhood token is measured on the
  box** (`npm run market:check -- robinhood`, `buybot:check`), never assumed —
  the change is fail-open everywhere: an empty DS answer costs nothing, GT
  stays primary for the full market read.
- **This is the real quota relief.** The priority fix decided who WINS the
  site's GT share; this shrinks what everyone needs from it: robinhood board
  chunks gain a fallback, the buy-bot's robinhood metadata reads leave GT, and
  `GECKOTERMINAL_API_KEY` moves from "urgent" back to "headroom" — it is still
  the only thing that raises the ceiling, and GT is still the only free OHLCV
  (candles) source, so the sentence stays true; it just stops being the only
  path to a priced board.

#### ⚠️ …and the flip made it WORSE for one deploy: 62/66 → 0/66

The next `market:check` on the box read `robinhood 0/66 priced` on build
`87dca08`. The deploy was correct; the change was not. **"No consumer
hardcoded robinhood is special" — stated in that very commit message — was
false in exactly one place**, and it is the place that decides this chain's
market:

`fetchChainMarket` branches for the pools.trade chain to ADD the launchpad,
and it did that by replacing the indexed path wholesale: `fetchListedMarket`
(GT alone) + the launchpad, never `fetchIndexedMarket` (GT **then DexScreener
for the leftovers**). So robinhood was the one chain that never had the
gap-fill — invisible while DS did not carry the chain, and the moment the
registry said it did, the slug took away robinhood's GT-ONLY PRIORITY (it
"has a fallback" now) over a code path that still could not reach one. Both
halves were individually defensible; together they were strictly worse than
either.

- **A registry saying a source exists, over a code path that cannot reach it,
  is worse than not having the source.** The priority scheduler and the
  coverage map now agree because they read the same fact and the same
  function does the asking.
- ⚠️ **The regression shipped because no test drove that branch** — the
  indexed-merge tests all target `fetchIndexedMarket`, which robinhood never
  called. The guard is a source scan (the branch lives behind an `"@/"`-alias
  import this runner cannot resolve) and it is MUTATION-TESTED: putting
  `fetchListedMarket` back fails it.
- **`market:check` is what caught it, twice, in a minute** — the board's own
  `0/66` next to `162/192`. That is the check earning its keep: the first run
  named the budget race, this one named a regression I introduced.

#### …and then the CHECK was the thing that was wrong

Next run: `robinhood 58/66 priced` — recovered — under a red
`GT answered 429 … GECKOTERMINAL_API_KEY is the only thing that raises the
ceiling`, and a non-zero exit. **A working board reported as a failure.** Three
defects, all mine, all this file's own recurring shapes:

- ⚠️ **It probed ONE source and hung its whole verdict on it.** The site gained
  a DexScreener fallback for these chains; the check never learned. A GT 429
  says nothing about whether the board can price — DS may be answering, which
  is precisely why the board read 58/66 while the check called it broken.
  Both sources are probed now, with the site's own request shapes, and the
  per-token line says WHICH one has the price.
- ⚠️ **"Could not ask" was being reported as "the board is broken."** The
  distinction this repo keeps everywhere else, missing from the one script
  whose job is diagnosing. Neither source reachable now prints *"this run says
  nothing about the board"*, points at the board's own live count as the
  answer, and only fails if that count is zero.
- ⚠️ **It was on its way to being PERMANENTLY red**, which is the state
  `chart:preview` sat in for weeks — and a check that is always red trains the
  reader to ignore the red. Exit codes follow the BOARD now: red only when a
  blank row is priced by a source RIGHT NOW (the site's fault); a token no
  source has is the board being honest and exits **zero**; one probe's rate
  limit never turns the code on its own.
- **Both ported chain maps are guarded** (GT and DS), because a stale slug in
  either makes the check report "no record" for a token the site prices — a
  check lying in the reassuring direction.

## "vol 0 padahal ada transaksi buy and sale"

Reported with a screenshot of the home board, where one row asserted both
halves of a contradiction:

```
$MRNA   +185.0%   MCAP $157.7K   VOL $0   TXNS 13 · 6 buys / 7 sells
```

**Nothing in the data layer invented that zero**, and the first instinct — that
`?? 0` in the two market readers had turned a missing volume into a fact — was
wrong. Measured against the live API before writing a line:

```
MRNA  vol24h = 0.06   txns 6/7        AMZN  vol24h = 0.31   txns 0/1
GOOGL vol24h = 0.04   txns 4/4        AMZN  vol24h = 0      txns 0/0
```

The volumes were real. `fmtCap` ended in `Math.round(n)`, so **every genuine
figure under half a dollar rendered as `$0`** — and the board printed that
beside its own transaction count, asserting no trading happened over data
proving it had. The row with a true zero had 0 buys and 0 sells, which is the
one state in which `$0` is a fact.

- **A printed zero is a claim.** This repo already refuses the same shape for an
  unreadable 24h change on the trending board; it had never been applied to
  money. Below a dollar `fmtCap` now keeps exactly enough decimals that a real
  number cannot render as zero — `$0.06`, `$0.31`, `$0.004` — and no more.
- **A TRUE zero still prints `$0`, and `null` still prints `—`.** Three states,
  three spellings: *is zero* · *is small* · *not known*. Collapsing any pair is
  the defect.
- ⚠️ **No branch may emit a bare `<`.** `<$0.01` is the obvious spelling and is
  unavailable: `bot/src/helpers/format.js` carries a 1:1 port of this function
  and its output reaches Telegram with `parse_mode: HTML`, where one `<` makes
  it reject the whole message — a 400, which `queuedSend` does not retry, so
  the post simply vanishes. The trade bot's `&lt;0.01%` paid for that lesson.
- **Both copies were fixed together and a test asserts they agree exactly**, or
  a figure reads one way on the site and another in a channel post.
- **The measurement came first.** Three causes produce `$0` — the upstream
  omitting the field, the upstream reporting zero, and this rounding — and they
  need different fixes. One `curl` against the running site separated them in
  ten seconds; guessing would have bought a nullable-volume refactor rippling
  through the types, the sort and the score, for a bug that was one line.

```bash
npm test                                                      # src/lib/format.test.ts
cd bot && node scripts/run-tests.js test/fmtCapZero.test.js
```

### "Chart unavailable right now" — and four files owning one number

The token page answered `Couldn't read the chart just now (rate limited —
cooling down for 88s)`, and the ask was "semua token chartnya tersedia".

⚠️ **That ask cannot be fully met on the free tier, and saying otherwise would
be the reassuring reading.** A PRICE has two free sources; a CANDLE has one.
GeckoTerminal is the only free OHLCV for an arbitrary DEX token, its ceiling is
~30 requests a minute counted PER IP, and this box splits that between the bot
suite and the web app. One 429 anywhere arms a process-wide cooldown that
blanks EVERY chart on the site until it lifts. `GECKOTERMINAL_API_KEY` is the
only thing that raises that ceiling rather than dividing it; everything else
reduces how often it is hit.

What was worth fixing is that the app was paying for the same answer repeatedly:

- ⚠️ **`POOL_TTL = 10 * 60_000` was declared in FOUR files** — `providers/index.ts`,
  `/api/pool`, `/api/ohlcv`, `/api/trades` — and all four built the SAME cache
  key by hand. Four copies of one number sharing one key means whichever writes
  last sets the expiry, and raising one of them looks like it works while three
  others quietly disagree. `poolCache.ts` is the one owner now, beside
  `topPoolAddress`, which was already the one owner of *which* pool.
- **A token's deepest pool is not a per-minute fact**, so the TTL is an hour
  rather than ten minutes. Resolving a pool is a GT request, and every chart for
  a token whose pool has expired pays it again before it can even ask for
  candles.
- **`forgetPool` exists so a longer TTL cannot backfire.** A pool that dies
  mid-window would otherwise be handed back for the rest of the hour — the exact
  cost the longer TTL is meant to buy.
- ⚠️ **The guard test that broke was asserting a LITERAL.** It matched
  `cache.set(\`pool:…\`, m.poolAddress, POOL_CACHE_TTL)` — so it passed happily
  on the four-way duplication it was meant to describe, and failed on the fix.
  It asserts the property now: no file may declare its own pool TTL or build the
  key by hand.

```bash
npm test    # gtBudget — the one-owner guard, and the rest of the GT budget
```

**Config a fix depends on:** `GECKOTERMINAL_API_KEY` in the repo-root `.env`
for the site, and `bot/.env` for the bot. Until one is set, 30/min is 30/min and
a busy minute still ends in a cooldown — this only makes the minute go further.

### "Mending tambahkan api dari dexscreener" — the ceiling was never going to move

Reported a fourth time, with the token page reading `Chart unavailable right
now · Couldn't read the chart just now (GeckoTerminal 429 (rate limited))`.
Every round above cut what we SPEND — six GT doors down to one client, an
hour-long pool cache, DexScreener-first pricing in the bot — and every round
made the minute go further without ever removing the minute. The operator's own
answer is the only one that does:

    A PRICE HAS TWO FREE SOURCES; A CANDLE HAS ONE.

`src/lib/providers/dsChart.ts` is the second one, and two of its rules would
each have shipped a source that answers perfectly and draws nothing:

- ⚠️ **DexScreener sends MILLISECONDS; everything downstream is SECONDS.**
  `Candle.t` is GeckoTerminal's unit, `CandleChart` multiplies by 1000, and
  `normalizeCandles` refuses a stamp more than six hours ahead — so a
  millisecond feed is not merely wrong, every candle is silently DROPPED as
  "the future" and the panel reports "no candles on this timeframe" about a
  source that answered. `normalize.toMs`, pointing the other way. Converted by
  MAGNITUDE, because both spellings are plausible from an undocumented feed and
  guessing one costs the whole chart.
- ⚠️ **A DS PAIR ADDRESS IS NOT A GT POOL ID** — the rule this repo already
  states in seven places. `/api/pool` and `/api/trades` read the `pool:` cache
  and hand its value to GeckoTerminal, and the panel built a
  `geckoterminal.com/<network>/pools/<pool>` link out of it. The pair gets its
  own field and its own namespace; `pool` still only ever carries a GT pool, and
  the "open at the source" link is built by whoever knows which source answered.

⚠️ **AND THE REQUEST SHAPE IS A GUESS.** DexScreener publishes **no** documented
OHLCV endpoint — its own chart is a TradingView chart on an internal datafeed,
and nothing in this repo had ever called one. That is exactly the state
`pads.js` marks `verified: false` and was designed for, so it ships under the
same contract: a base LIST with `DS_CHART_API` pinning one **and** skipping it,
a PATH template list, `DS_CHART_BARS_KEY` for the envelope, `DS_CHART=0` to kill
it. **A renamed segment costs a line in `.env`, not a deploy** — which is the
whole licence for shipping a shape nobody here has exercised. And it can never
be the only source: **a guess must lose to an answer**, so GeckoTerminal stays
first whenever it can answer.

- **TWO FAILOVER RULES, AND MIXING THEM IS THE BUG.** Across BASES: transport
  only — `JUP_BASES`' rule, because a status means the host answered and the
  same request gets it everywhere else. Across PATHS: a 404 only, because that
  is a DIFFERENT RESOURCE on the same host and "that spelling is not here" is
  exactly when the other spelling is worth trying. A 429 says nothing about
  which path is right, so it retries neither.
- **A 429 arms its own process-wide cooldown.** A client that hammers through
  its own 429 is precisely the defect `gt.ts` was written to end, and adding a
  second upstream without one would reintroduce it a host over.
- **GT is not ASKED while its cooldown holds.** `gtGet` would answer without a
  request, so skipping costs nothing upstream — and answering during exactly
  that window is the entire reason a second source exists. That is the state the
  screenshot was taken in.
- **Both reasons travel** when neither answered, and the sentence keeps the words
  *couldn't read*: the panel classifies error-vs-answer on that substring, and
  only an error gets the fast retry that lets a chart appear the moment a
  cooldown lifts.
- ⚠️ **The no-candles branch carries the SPECIFIC reason.** It used to assert
  *"This pool has no candles on this timeframe yet"* for every way a source can
  answer with nothing — so a token NEITHER index has a pair for was told its
  pool was empty, which claims a pool that does not exist.
- **The panel SAYS when it drew from the fallback** (`via DexScreener`). Without
  it, a chart from the second source and one from GT are the same picture, and
  *"the fallback works"* and *"the fallback never fires"* are the reassuring
  reading this repo keeps paying for.

```bash
npm run build && npm start &
npm run chart:check                       # per source, on the box; non-zero if neither draws
npm run chart:check -- bsc 0x8b7a…7777    # one token you are looking at
```

⚠️ **The check drives the RUNNING SERVER, not the provider module.** Importing
`src/**/*.ts` needs node's type stripping and **production runs 18.19**, where
that import simply throws — a check that cannot run on the box is "apt-get
install is not a fix, it is a request", one feature over. It asks each source
separately (`?source=`), because with GeckoTerminal healthy the DexScreener path
never runs and a check that only asked normally would report a green chart while
saying nothing about the fallback.

⚠️ **`chart:preview` had been permanently red and therefore useless as a gate.**
It still asserted *"an unlisted token gets the chart too"* — written before that
chart was deliberately removed ("Kalo token belum listing hapus chartnya"). So it
had exited non-zero on every run since, and a check that asserts a deleted
feature is worse than no check: it trains the reader to ignore the red. It
asserts the DECISION now, and gained the fallback state — judged by LOOKING at
the render, 21/21.

⚠️ **The chart-route build-stamp guard matched `{ ok: true, `** — the one-line
spelling — so an UNSTAMPED multi-line response would have passed it, which is the
one shape it exists to catch. It counts the property now.

**Config a fix depends on:** nothing; every knob has a working default. But
whether the guessed shape answers is a property of the server's egress, so
`npm run chart:check` on the box is the only way to learn it — and
`GECKOTERMINAL_API_KEY` is still the only thing that raises the real ceiling
rather than dividing it.

#### The audit round — the fix cached the very thing it was written for

Run against both features by five independent lenses, and every defect found is
one of this file's own recurring shapes, reintroduced by the code written to
stop it.

- ⚠️ **A GECKOTERMINAL RATE LIMIT WAS BEING CACHED AS THE CHART'S ANSWER**, for
  the timeframe's TTL — up to FIFTEEN MINUTES on 1d, longer than the 120s
  cooldown it was reporting. `load()` IS the cached loader, and the rule stated
  at `Unreadable`'s own definition is that only an ANSWER may be cached. It used
  to reach the route's catch by THROWING out of `fetchCandles`; wrapping
  GeckoTerminal in a try/catch so DexScreener could be tried afterwards quietly
  turned that throw into a RETURN. Proved by measurement rather than by reading:
  three identical requests against a stub produce six upstream hits.
- ⚠️ **ONE SOURCE ANSWERING IS NOT EVERY SOURCE ANSWERING.** With GT cooling
  down and DexScreener replying *"no pair for this token"*, the route published
  *"No candles yet"* about a token GT indexes perfectly well — on the panel state
  that never fast-retries, so it stayed wrong until the reader reloaded.
- ⚠️ **THE VOLUME FLOOR BOUND ONE BOARD OUT OF FOUR.** `/trending` — the page
  whose entire heading is *Top Gainers* — sorted `b.chg[frame] - a.chg[frame]`,
  the RAW field, through neither gate, so even a five-million-percent reading
  could take its 🥇 medal. The **Ticker** crowned, on every page, the token the
  board directly underneath ranked tenth. `/watchlist` and the home **wire
  headline** did the same. `byChange` is the one owner for a whole list;
  `tradedEnough` is the filter for a curated few; a test pins every ranking
  surface so a fifth cannot be missed.
- ⚠️ **`trending:check --floors` HAD ITS OWN COPY OF THE REFUSAL COUNT**, missing
  the "we actually looked" half — 44 refusals where the bot reports 25. A check
  that measures its own copy of the question proves nothing.
- ⚠️ **A TOKEN NOBODY PRICED IS NOT A TOKEN THAT FAILED THE FLOORS.** `byGain`
  prices at most 25 a chain; counting the tail as refused told an operator with
  100 listings that 75 of their tokens were too small, about tokens the pass
  never opened. And **the test for it was vacuous** — the log buffer it read was
  module-level, so `.find()` returned an earlier test's line and the assertion
  passed whatever the code did.
- ⚠️ **THE PANEL PROMISED A FILLER THAT WAS SWITCHED OFF**, four paragraphs above
  saying a chain with no spares "stays short until somebody lists tokens on it".
- ⚠️ **`fmtCap` printed `$NaN` on the site where the bot's 1:1 port prints `—`** —
  two copies the repo requires to agree exactly, drifting on the one input the
  agreement test never tried.
- **The base-failover rule was true in the comment and false in the code**, and
  the test for it was vacuous because the shipped base list has ONE entry: a test
  driving it cannot tell a correct loop from a broken one. `dsCandles` takes a
  documented `bases` seam now.
- ⚠️ **"Nothing is up on this timeframe" became a FALSE claim** the moment
  `movers` started excluding quiet tokens — the board above the card reads
  +58.2% while the card says nothing is up.
- **`chart:preview` had been permanently red**, asserting a chart on the unlisted
  page that was deliberately deleted. A check that asserts a removed feature is
  worse than no check: it trains the reader to ignore the red.

Every guarantee is MUTATION-TESTED rather than argued — reaching around the
floors in the floor fill, dropping them from the promotion pass, bypassing them
on a forced run, dropping the filler's refusal, letting the base rule leak,
skipping the millisecond conversion, taking the quote-side pair, and each of the
above — and each fails between one and four tests.

### "chartnya bisa di set kaya di atas ke bawah" — the vertical belongs to the reader

Reported with the same `$BREAKING` screenshot (2026-08-26). The token had gone
from **$0.000803 to $0.0281 in two days** and the chart of it was a flat line
along the floor of the panel with one spike at the right-hand edge. Every
number on it was correct. The picture was useless — **on a LINEAR axis a 35×
move spends 96% of the height on the last 4% of the story** — and there was
nothing the reader could do about it: the y-axis was computed from the window
and that was the end of it.

Two answers, and they are one transform, so they are one module
(`src/lib/chartScale.ts`):

- **LIN / LOG**, in the header. On a log axis a doubling is the same distance
  wherever it happens, so the early history is as readable as the spike. That
  is the answer to *this* picture.
- **A MANUAL ADJUST.** Drag the price gutter to stretch or squash, drag the
  chart to move it up and down, double-click (or ⤢ Auto) for the automatic
  range back. TradingView's grammar, because it is the one people already know.

- **The adjust is `{zoom, shift}`, NOT a stored `{lo, hi}`.** A stored pair
  would go on describing a price range the market has since left, so a chart
  left alone for an hour would drift off its own candles while the reader
  watched. Two dimensionless numbers describe a relationship to whatever the
  auto range is *now*, which survives new candles arriving underneath it.
- **`shift` is measured in AUTO spans and the drag against the VISIBLE one**,
  so `panByDrag` divides by the zoom. Without that, panning a chart stretched
  10× flings it off screen in a few pixels; the same drag has to travel the
  same distance on the panel at every zoom.
- **A stretch keeps the middle of the view where it was.** Zooming that also
  slid the chart up the axis is a control nobody can aim — you lose the candle
  you were looking at.
- ⚠️ **A LINEAR PRICE AXIS MAY NOT GO BELOW ZERO.** Squash far enough and the
  padded range walks past the origin and the gutter starts labelling negative
  dollars, on the panel somebody is reading to decide whether to buy. Log space
  has no such floor (10⁻⁹ is a price), so the clamp only binds where it means
  something.
- ⚠️ **A log axis must never be handed a non-positive price.** `Math.log10(0)`
  is `-Infinity` and one of those turns the whole axis into NaN, which renders
  as an empty panel that reads exactly like a chart still loading — the state
  this repo has already paid for twice.
- **The grid ticks are evenly spaced in the AXIS's space, not in dollars**, or
  a log chart's five lines bunch at one end.
- ⚠️ **A stretched chart is CLIPPED.** Unclipped, the wicks run straight
  through the volume histogram and the time stamps. …but **the last-price tag
  is PINNED, not clipped**: it is the number the reader came for, and a scale
  they dragged must not be able to take it off screen. It rides the edge, which
  is why the grid label still gives way to it.
- ⚠️ **A phone can still scroll the page.** A vertical touch drag across the
  plot is how a phone scrolls, so only a MOUSE pans the chart body;
  `touch-action:none` is taken on the narrow gutter alone, which is the one
  place that trade is worth making.
- ⚠️ **`useId()` returns `:r0:`** — legal in an id, and a colon inside a
  `url(#…)` reference is one browser quirk away from a clip that silently does
  nothing, on somebody else's browser and nowhere near a test. Stripped to word
  characters.
- **The MODE survives a timeframe switch and the ADJUST does not.** Somebody
  who wants a log axis wants it on every tab; a stretch aimed at two days of
  15m candles is meaningless over six months of daily ones, and inheriting it
  opens the new tab on an axis with no candles in it.
- ⚠️ **AND THE PANEL SAYS WHEN THE READER HAS MOVED IT.** A log chart and a
  linear one of the same token are different pictures, and so are an auto range
  and a stretched one; anybody comparing two screenshots is owed the
  difference. Two buttons rather than one toggle, so the mode is readable OFF
  the picture, and `⤢ Auto` exists only while the axis is not the data's own —
  the escape hatch and the tell at once. Same rule as the `via DexScreener`
  chip one feature over.

#### ⚠️ The gutter is INSIDE the plot, and pointer events bubble

Every pointer event over the price axis ran BOTH handlers and the two fought
over one drag. **Measured, not reasoned about**: with the three
`stopPropagation` calls removed, a 60px pan moved the chart **210px**, and the
same axis drag produced a different zoom. Which handler wins in which order is
not worth working out — a drag belongs to the element it started on.

It still "worked": the chart did stretch and did move. So the preview's check
had to change too — `> 20px` passed happily on the broken build, and
`|moved − 60| < 8` is what catches it. **A control that responds is not a
control that obeys.**

#### It is judged by LOOKING at it

`chart:preview` renders the reported shape (`ramp()`, a 35× climb) and measures
where **half the move** sits — the price at which the token had done half its
multiple belongs somewhere near the middle of a chart of that move:

```
LIN: half the move sits 16% up the price area     ← the reported picture
LOG: half the move sits 50% up the price area
```

- **Against the PRICE AREA, not the whole svg.** The volume band and the time
  axis are not part of the scale, and counting them flatters a linear chart by
  a fifth — the first cut measured that way and read 26%.
- ⚠️ **The clip is MUTATION-TESTED in the page**: the attribute is pulled off,
  the same points are probed again, and it is put back. Two cheaper checks were
  tried first and both were worthless — `getBoundingClientRect` on clipped SVG
  comes back collapsed or stale, and a run where nothing overflows makes any
  "nothing spilled" assertion true of a chart with no clip at all. This one
  fails if the clip stops working AND fails if the probe stops being able to
  see a spill.

#### 403 → 400: the host started talking, and the guess is what it refuses now

The first `chart:check` after the browser headers deployed:

```
USDC (Solana)   ✓ GeckoTerminal 26 candle(s)    ✗ DexScreener io.dexscreener.com 400
WBNB (BSC)      ✓ GeckoTerminal 384 candle(s)   ✗ DexScreener io.dexscreener.com 400
WETH (Ethereum) ✗ GeckoTerminal 429             ✗ DexScreener io.dexscreener.com 400
```

**The number changed, and that IS the result.** 403 is "I refuse you"; 400 is "I am
talking to you and your request is wrong". The headers got past the bot filter,
and what is left is the part this file always said was a guess. Three things,
and two of them are our own rules broken:

- ⚠️ **WE WERE DISCARDING THE REASON — on the one status that carries it.** This
  file's own rule is *"an HTTP error puts the explanation in the response
  body"*, and `getJson` cancelled the body and returned a bare
  `io.dexscreener.com 400`. That says the guessed shape is wrong and nothing
  about WHICH part, which is the difference between a one-line `.env` fix and
  another round of guessing. `bodyHint()` carries it now — flattened (an HTML
  error page is not a message for a reader) and bounded to a phrase.
- ⚠️ **THE QUERY STRING WAS THE ONE PART OF THE REQUEST THAT WAS NOT
  OVERRIDABLE.** The whole licence for shipping an unverified shape is that
  every part of it costs a line in `.env` rather than a deploy — and the query
  is the half most likely to be wrong, which the 400 then proved.
  `DS_CHART_QUERY` takes `{from} {to} {res} {limit}`.
- **A 400 now tries the OTHER path spelling, a 403 still does not.** 404 ("not
  here") and 400 ("not with these parameters") are both about THIS spelling, and
  v2 and v3 of an API routinely take different params — which is the whole
  reason two templates are listed. A refusal says nothing about which path is
  right.
- ⚠️ **The attempted URL travels, but ONLY under the `?source=` pin.** An
  operator cannot fix a request shape they cannot see — the `logos:check`
  truncation defect, one feature over — and a visitor must never see a raw
  upstream URL in the chart panel. The pin is the check script's seam and
  nothing else sets it.
- **The check says how to FIND the real shape**, because the endpoint is the one
  DexScreener's own chart calls: DevTools → Network → filter "bars", then paste
  the query into `DS_CHART_QUERY` and the path into `DS_CHART_PATH`. A status
  alone is not actionable; naming the browser as the authoritative source is
  the difference between a diagnosis and a shrug.

⚠️ **What is still unknown, and cannot be learned here:** the correct shape. This
sandbox has no egress, and the endpoint is undocumented — so the last step
genuinely belongs to somebody with a browser and the box. Everything above
exists so that step is a line in `.env`.

#### "saya ingin pakai api dexscreener aja untuk chart" — an ORDER, not a deletion

The DexScreener source already existed (the same operator asked for it, and it
shipped). What did not exist is a way to make it PRIMARY, and on that box
`io.dexscreener.com` was answering **403**. Two things:

- ⚠️ **THE 403 WAS PROBABLY OUR OWN REQUEST SHAPE.** `io.` is not a public API —
  it is the internal datafeed behind DexScreener's own TradingView chart, and it
  sits behind Cloudflare. We were sending nothing but `accept:
  application/json` from a datacenter IP, which is exactly the shape a bot
  filter refuses. It now sends what a browser sends (user-agent, referer,
  origin, accept-language) — the same compromise `/api/logo` already makes one
  CDN over. The DOCUMENTED `api.` host does not get them: it answered 200 from
  the box with none, so they are sent only where they might help.
  `DS_CHART_HEADERS` REPLACES the set (`Name: value` pairs separated by `|`),
  because whether a header combination gets past a bot filter is a property of
  the box's IP reputation today, not of this code.
- **`CHART_SOURCE` is the order**: `auto` (GT first, the shipped default),
  `dexscreener` (DS first, GT behind it), `geckoterminal` (GT only). Blank is
  `auto` — an unset var resolves to what shipped, never to a guess.

⚠️ **IT IS AN ORDER AND NEVER A DELETION, and that is not overruling the ask.**
DexScreener publishes no documented OHLCV endpoint, so `dsChart.ts` is a GUESS
about somebody else's private API. Making a guess primary is a legitimate trade
— it costs nothing while it works, and it leaves the whole ~30 req/min GT
allowance for the board, the pools and the trades feed. Making it the ONLY
source means the day DexScreener renames a path, every chart on the site goes
dark with no way back. `askGt` may therefore only be switched off by the
`?source=` PIN (the check script's seam), never by the preference — and that is
mutation-tested: letting `PREF` silence GeckoTerminal fails the guard.

- ⚠️ **The boot line prints the order**, for the reason the `[gt]` tier line
  exists: a setting that never arrived and a setting that did not help are
  indistinguishable from a browser, and this repo has lost evenings to an
  `.env` written to the wrong file.
- ⚠️ **A type PREDICATE narrows the FALSE branch too.** `(x): x is DsCandles`
  left `ds` as `null` after the ordering blocks, so every use below read as
  `never` and the "which kind of nothing" logic stopped type-checking while
  still compiling — the guard rail off, silently. A plain boolean does not.
- ⚠️ **The build-stamp guard was counting a code sample inside a COMMENT.** The
  repo's own rule — a scan for a line has to read the code, because comments
  quote the defect they guard against — had not been applied to that one test.

```bash
pm2 logs dexvra --lines 20 --nostream | grep -F '[chart]'   # which order is live
npm run chart:check                                          # per source, on the box
```

**Config a fix depends on:** nothing — `CHART_SOURCE` is optional and blank is
the shipped behaviour. But ⚠️ **whether the guessed shape answers at all is a
property of the server's egress**, so `chart:check` on the box is the only way
to learn it, and `GECKOTERMINAL_API_KEY` is still the only thing that raises the
real ceiling rather than dividing it.

#### "Chart unavailable right now" again — and one retry that was hammering a refusal

```
Couldn't read the chart just now (GeckoTerminal is rate limited —
cooling down for 92s; io.dexscreener.com 403).
```

**Both sources at once, and the panel said so correctly** — that message is the
feature working: it names each host and each reason, which is why the cause was
readable at a glance instead of being another round of investigation. There is
no code fix for the ceiling itself; ⚠️ **`GECKOTERMINAL_API_KEY` in the
repo-root `.env` is the only thing that raises it rather than dividing it**, and
that sentence is now in this file five times.

But the retry underneath it was wrong:

- ⚠️ **A 403 IS A REFUSAL BY THE HOST, AND RETRYING IT EVERY FIVE SECONDS IS THE
  429 DEFECT ONE STATUS OVER.** The panel fast-retries a transient chart failure
  every 5s (up to 8 times) so a chart draws itself the moment a GeckoTerminal
  cooldown lifts — and that is free upstream, because `gtGet` answers a
  cooled-down request WITHOUT making one. DexScreener had no such guard for a
  403: with GT cooling down and `io.dexscreener.com` refusing this box, **every
  chart view spent eight requests proving the same refusal**. Exactly the shape
  this file already names for CoinGecko — *"a 429 now arms a process-wide
  cooldown and the rest of the sweep is not asked at all"*. 401/451 join it.
- **404 is deliberately NOT in that set.** It is an ANSWER about the pair
  ("DexScreener has no pair for this token"), not a refusal of us, and caching
  it as an outage would blind the fallback for every other token. The same line
  `logoFill` draws between "nothing there" and "could not ask", and the same one
  the IPFS gateway list draws in the other direction.
- Mutation-tested: putting the 429-only guard back fails the test.

⚠️ **And the rebuilds themselves cost quota.** The OHLCV cache is per PROCESS,
so every `pm2 restart dexvra` empties it and the next view of every open chart
re-fetches. Half a dozen deploys in a row on a box already sharing ~30 req/min
with the bot suite is enough to sit in a cooldown for a while, with nothing
wrong anywhere. Worth knowing before diagnosing a chart that is only cold.

#### The logo came back — and the same rule was missing a third time

`$BREAKING` drew its real artwork the moment the gateway list deployed, which
settles that one. Two things the same screenshot showed, and both are the same
sentence written for a third source.

- ⚠️ **THE COOLDOWN WAS REPORTING A REFUSAL AS A RATE LIMIT.** The panel read
  `io.dexscreener.com 403` on one request and `rate limited — cooling down for
  55s` on the next, about the same host and the same refusal. Every cooldown
  message hardcoded "rate limited" because only a 429 could arm one — the moment
  a 403 could too, that line became a lie, and the two need different reactions:
  a rate limit passes by itself, a host refusing this server does not. The
  cooldown carries its REASON now and the panel prints that. "Never discard the
  reason", one module over.
- ⚠️ **A SOURCE THAT REFUSES US MUST BE BENCHED — FOR EVERY SOURCE.** CoinGecko
  learnt this when a 429 on row one cost a request per row for the rest of the
  sweep. DexScreener never did, and it is the source that matters MOST for the
  logos: pump.fun artwork lives there and `resolveLogo` asks it FIRST. On a box
  whose IP DexScreener refuses, every sweep spent eight requests proving the
  same 403 — for ever — and every one of those rows came back `undecided` and
  was requeued 30 minutes later. `benched` is ONE table now rather than a
  variable per source, because this is the third time the rule has been written
  in this repo (`gt.ts`, `dsChart.ts`, here) and a fourth private copy is how
  two of them end up disagreeing. `REFUSAL` is 401/403/429/451; a 404 benches
  nothing, because that is an ANSWER about the token.

⚠️ **And a token with no logo on OUR board that has one on DexScreener is now a
measurement, not a guess** — if DexScreener refuses this box, our best logo
source is unavailable there and it will say so:

```bash
curl -s -o /dev/null -w "api.dexscreener.com → %{http_code}\n" \
  https://api.dexscreener.com/tokens/v1/solana/<mint>
```

A 200 means the source is reachable and the row is simply still in the
resolver's queue; a 403 means DexScreener is refusing this server, and no amount
of sweeping will change that — the logos then have to come from GeckoTerminal,
CoinGecko or the launchpad.

#### "bisa di geser ke kanan ke kiri chartnya" — the other axis

The vertical landed and the very next thing asked for was the horizontal, with
the reference named: *"kaya trading view … atau dexscreener"*. Fair — **a chart
you cannot move through time is a picture**, and the two tools everybody arrives
from both do it: drag sideways to travel, wheel to zoom, and the candle under
the cursor stays under the cursor.

- **The state is `{count, endOffset}`, NOT `{startIndex, endIndex}`** — the same
  decision the price scale makes storing `{zoom, shift}` rather than `{lo, hi}`,
  and for the same reason one axis over. New candles arrive at the RIGHT every
  poll, so a pair of absolute indices would slide one candle further into the
  past on every refresh while the reader watched. `endOffset` is measured from
  the newest candle: a reader parked at the live edge stays there, and one who
  scrolled back stays exactly where they scrolled to. Pinned by a test that adds
  candles under a scrolled window.
- **ONE GESTURE, TWO AXES.** A body drag travels sideways and moves the price
  scale vertically at once, which is the grammar both references use. The gutter
  stays price-only.
- ⚠️ **The phone GAINS the horizontal and still never loses the vertical page
  scroll.** `touch-action: pan-y` hands the browser the vertical and leaves us
  the horizontal — which is exactly the half worth having on a phone. The
  earlier rule ("only a mouse may pan the body") was right when the body drag
  meant only the price axis; it would now cost a phone the one gesture it most
  wants.
- ⚠️ **THE WHEEL NEEDS A NATIVE, NON-PASSIVE LISTENER.** React attaches
  `onWheel` passively, and a passive listener **cannot** `preventDefault` — so
  the handler would zoom the chart and let the page scroll away underneath it at
  the same time. Bound with `addEventListener(…, { passive: false })`, and
  because it is bound ONCE it reads the geometry through a ref: a stale `geo`
  in that closure would zoom against a window that no longer exists.
- ⚠️ **The live dot does not claim "live" over candles from two days ago.**
  Scrolled back, the chart is still refreshing but what the reader is looking at
  is not the present; the pulsing dot would be the reassuring reading of a state
  that is not. A `HISTORY` chip takes its place, in the same microlabel voice as
  `via DexScreener`.
- **Every gesture is CLAMPED to the data** — a reader cannot scroll past the
  newest candle or before the oldest, so no drag can empty the panel. The
  horizontal version of the price axis refusing to walk below zero.
- **A slow drag accumulates.** Rounding each event to zero candles is a chart
  that responds without obeying — the same defect the double-applied zoom had,
  pointing the other way.
- ⚠️ **`limit` IS A QUERY PARAM, NOT A REQUEST COUNT.** The timeframes fetched
  180–200 candles, barely more than one screen fits, so there was nothing to
  scroll back INTO. Raising them (288 / 384 / 336 / 360 / 365 — a day of 5m
  through a year of daily) costs payload and **nothing else**: one request per
  timeframe either way, and the shared ~30/min GeckoTerminal ceiling is
  untouched.

⚠️ **And the preview's first pan check was measuring the wrong thing** — it
compared an axis stamp taken BEFORE the zoom, and the window had been clamped
back to the same first candle, so it reported the drag as broken while the drag
was fine. A check that fails on working code is as expensive as one that passes
on broken code. It zooms in hard first (with the whole history on screen there
is nowhere to travel TO) and compares against the state immediately before the
drag.

#### …and `logos:check` failed on its own happy path

`pm2 restart dexvra && npm run logos:check` is the order an operator actually
types after a deploy, and Next takes a few seconds to bind — so the check
reported *"the server did not answer"* for the one sequence it was written to be
used in. It retries the first connection now, bounded, and SAYS it is waiting.
A check that fails on its own happy path teaches the reader to ignore it, which
is the state `chart:preview` sat in for weeks.

```bash
npm test                                     # chartScale (29) + the panel guards
npm run build && npm start &
npm run chart:preview                        # 43 checks, both axes, and a phone
```

#### The audit round — the new module had dropped half of the six lines it replaced

- ⚠️ **THE LINEAR PADDING FLOOR WENT MISSING, ON THE VERY CHART THIS EXISTS
  FOR.** The code `priceScale` grew out of was
  `lo = Math.max(range.lo - pad, range.lo * 0.5)` — pad by 6%, but **never more
  than one halving below the lowest price**. The first cut kept the padding and
  dropped the floor. On a 35× move, 6% of the *range* is far bigger than the
  whole bottom of it, so `lo - pad` goes negative and the axis bottomed out at
  **$0**: a third of the panel handed to prices that never existed, squashing
  the early history that much further onto the floor. A fix making its own
  symptom worse. It is a LINEAR rule — log padding is symmetric in ratio and
  behaves by itself — and it is mutation-tested.
- ⚠️ **The `dragging` cursor came off a REF, so it never cleared.** A ref does
  not re-render: the class arrived on the first move and then stayed after the
  drag ended, until something else happened to re-render. `:active` needs no
  state and cannot get stuck.
- **`releasePointerCapture` was called on an element that may never have
  captured.** On touch the body drag is deliberately not started, so every
  touch-scroll across the chart arrives at `endDrag` with nothing to release.
  Chromium treats that as a no-op — **measured**, the phone check in
  `chart:preview` taps the chart and scrolls past it — but the spec allows a
  `NotFoundError` and this is the path every phone reader takes. Guarded with
  `hasPointerCapture`.
- ⚠️ **`chart:preview`'s phone context had no `hasTouch`**, so the "phone"
  checks were driving the DESKTOP pointer path and reporting it as the phone's —
  a guard measuring a stack the reader does not use, one surface over.
- ⚠️ **The clip probe went stale the moment the floor was restored** — the
  narrower auto range stopped pushing any candle past the price area, so there
  was nothing to clip and the check had nothing to prove. **The vacuity guard
  said so instead of passing quietly**, which is the entire reason it is there.
  Worth knowing why the fix was fiddly: the zone where the clip matters is only
  ~120px tall, between the floor of the price area and the bottom of the svg,
  which clips everything past it by itself. A 260px shove sails straight out of
  the zone and looks exactly like a chart that never overflowed.
- The header said **30x** where the token did **35x** — the number the whole
  section argues from.

```bash
npm test                                     # chartScale (18) + the panel guards
npm run build && npm start &
npm run chart:preview                        # 35 checks, incl. LIN/LOG, every drag, and a phone
```



**Config a fix depends on:** nothing.

## "Mengapa masih tidak bisa buy token yang masih bonding curve?"

Because the four modules that read a curve were on `main` and **wired to
nothing**. `abi:check` could describe a curve perfectly and no button could
spend through one. This wires it — and the wiring is the small half.

⚠️ **A NAIVE WIRING WOULD HAVE SHIPPED INERT, and passed every test.**
`curveRoute.sane()` is the last gate and it refuses without an independent
price. The obvious source is `marketOf`, which asks DexScreener and
GeckoTerminal — and **both index POOLS**. A token still on a bonding curve has
no pool; that is the entire premise of the feature. So the gate would have
refused 100% of its own target set, at the last stage, after a dozen RPC reads
— wired, green, and never once firing. From Telegram that is indistinguishable
from a broken bot, which this repo already treats as costing what a wrong fill
costs.

An adversarial audit (six independent lenses over the buy path, the sell path,
the pricing sources, the tests, the messaging, and one whose only job was to
find how the design loses money) found eleven more. Each is fixed below, and
the four that could move money are MUTATION-TESTED rather than argued.

### `curvePrice.js` — the number that authorises the trade

Three tiers, ranked by how independent they actually are, and the weakest says
so out loud:

| # | source | independent of the curve? | of the slots? | tol |
| --- | --- | --- | --- | --- |
| 1 | the launchpad's USD price × Coinbase spot | ✅ two third parties | ✅ | 35% |
| 2 | the pad's market cap ÷ on-chain `totalSupply()` | ✅ | ✅ | 35% |
| 3 | the rate recent fills actually PAID | ❌ same transactions | ✅ different FIELD | 60%, `weak` |
| — | nothing | | | **refuse, naming WHICH nothing** |

- **Tier 3 is why it is not inert on the operator's own box.** Their
  `launchpads:check` says `✗ pons — can't reach api.pons.fun`, so tiers 1–2 may
  never answer there. What the contract PAID OUT is a different field from the
  argument `ratioE18` is read from — a trader's chosen bound versus the
  contract's actual payout — so it genuinely catches a slot that is not
  denominated in the output token. It catches nothing about staleness, curve
  movement, or a history somebody wrote on purpose, which is exactly why it
  carries a wider band and a `weak` flag, and why **a weak price may check the
  interface but may never become the on-chain floor**.
- ⚠️ **NOTHING HERE MAY BE ANSWERED BY THE CURVE.** That is the thing under
  test. `curveQuote()` exists and is deliberately kept apart: it is the curve
  quoting itself, right for a minimum-out floor and disqualified from `sane()`.
  A source scan pins that `priceWeiPerToken` never touches `chain.call`.
- ⚠️ **`tokenDecimals` ANSWERS 18 FOR A READ THAT FAILED**, and this is the one
  number that scales the answer by a power of ten. On a 6-decimal token that
  guess is off by 10¹², `sane()` refuses, and the refusal reads as *"the curve
  disagrees with the market"* — a confident wrong diagnosis pointing at the
  token instead of at our own throttled RPC. `tokenDecimalsOrNull` is the EVM
  twin of `solana.splDecimalsOrNull`, which exists for the same reason.
- **"Could not ask" and "nothing there" stay different refusals.** One is a line
  in `.env`; the other is a statement about the token.

### The money-loss paths the audit found, and what closed them

- ⚠️ **A CONSTANT ADDRESS SLOT WOULD HAVE PAID SOMEBODY ELSE.** The token and
  the sender are classified above it, so an address identical across every
  sample is a STRANGER'S — a recipient, a referrer, a router, and nothing can
  tell which. Replayed verbatim it is invisible to every gate downstream:
  `estimateGas` succeeds (the call is valid) and the price check succeeds (the
  AMOUNT is right — it is the destination that is wrong), so the buy lands with
  the tokens minted elsewhere and the only thing that notices is a balance read
  after the money is gone. It is UNKNOWN now, which is a refusal. **The zero
  address is exempt**: it is the same 32 bytes as the number 0, and sending to
  nobody is not sending to a stranger.
- ⚠️ **AN UNLIMITED APPROVAL TO A LOG-SCORED ADDRESS WAS THE ONLY UNBOUNDED
  LOSS.** Every other risk here is capped by one trade; that one is capped by
  the whole bag, for ever, and it outlives the trade. `approveExact` grants
  `amountRaw` and nothing more — the line `v4.js` already draws for a discovered
  router. And it **re-reads** the allowance rather than assuming: a token whose
  `approve` returns false leaves it short with nothing thrown.
- ⚠️ **AND THE ALLOWANCE GATE RAN FIRST**, above build, above the price check,
  so a `stage:'approve'` refusal said nothing about whether the call was even
  buildable. The caller granted, re-called, and could still be refused — with
  the approval standing for a sell that never happened. Everything that can
  refuse for free now refuses for free; only `simulate` genuinely cannot be
  pre-run without an allowance.
- ⚠️ **`sane()` IS SIZE-INVARIANT AND CANNOT SEE CURVATURE.** Both sides of its
  comparison are linear in size, so `size` cancels and the verdict is identical
  for a 0.001 and a 100 ETH buy. A bonding curve is convex, so a stranger's
  bound stretched to our size is either an always-revert or no bound at all.
  `SIZE_BAND` (4× either way) refuses outside a narrow band — and is LIFTED
  when the caller supplies its own independently-priced floor, because that
  bound is ours and correctly sized by construction.
- ⚠️ **TWO SLOTS THAT BOTH SCALE IS A REFUSAL.** `expected` is one variable,
  reassigned by each, so with two the LAST one becomes what `sane()` checks —
  on a `sell(tokensIn, minEthOut)` that compares tokens against wei. Worse, the
  slippage cut landed in BOTH: a 100% sell that hands over 95% and still books
  the position closed.
- ⚠️ **eth_call IS THE GATE, NOT eth_estimateGas.** `core.js` says twice that
  the Robinhood node strips revert data and returns a non-standard error
  envelope on `eth_estimateGas` — which is why `v3SwapGas` swallows a failed
  estimate and why the existing curve branch quotes with a `staticCall` and
  sends a flat limit. Robinhood is where Pons lives, i.e. the chain this whole
  feature is for: gating on the estimate there turns a node quirk into a
  permanent refusal, reported to the user as the CURVE rejecting them, with the
  reason stripped. The estimate is now best-effort, for the limit only.
- ⚠️ **A CALL WE ONLY HALF-READ IS REFUSED.** `argsOf` stops at eight words and
  the builder emits exactly the classified slots, so a wider call was silently
  TRUNCATED into malformed calldata — usually caught by the decoder reverting,
  i.e. by luck rather than by rule.
- ⚠️ **ONE SAMPLE PER TRANSACTION, NEVER PER LOG.** A curve that emits a FEE
  transfer alongside the trade produced two samples for one trade — identical
  calldata, and one of them carrying the fee as its `amount`. That silently
  satisfied `minSamples: 2` from a single trade, and let the observed rate price
  a buy at its own fee. Samples now carry `to` and an `exact` flag, and a payout
  that did not reach the trader is never a fill rate.
- ⚠️ **`ok` MEANT "a BUY was observed", AND `prepareSell` GATED ON IT** — so a
  curve whose recent trades are all sells could not be SOLD, which is exactly
  the market in which somebody wants out. A decoded sell leg is a complete
  answer to the sell question; the buy refuses on its own, where the sentence
  can name the fix.
- ⚠️ **A CONFIRMED BUY THAT RECEIVED NOTHING WAS BOOKED AS A SUCCESS.** The
  pending guard needs BOTH a missing receipt and no balance gain, so
  `status === 1` with zero tokens fell straight through: full cost added to the
  position, `gotTokens: 0`, green tick. On v2/v3/v4 a positive minimum-out makes
  that unreachable; a discovered curve makes it reachable.
- ⚠️ **A CURVE THAT REJECTS OUR CALL IS FORGOTTEN.** The cache held the
  discovered address for half an hour, so a pad that redeployed left every buy
  in that window aimed at an abandoned contract with no path back except
  waiting — a stuck state indistinguishable from a broken feature.
- ⚠️ **DISCOVERY RUNS INSIDE `withWalletLock`**, so it has a ceiling
  (`CURVE_DISCOVER_MS`, 12s). Ethers' own request timeout is 300s, and every
  queued operation for that wallet — a triggered stop-loss, an auto-protect
  rescue, a copy-exit leg — waits behind it.
- ⚠️ **`canTradeNow` GAINED A CURVE LEG, or every automated path stays inert
  while the manual button works.** The dev snipe, the CA snipe, `_fireLaunch`'s
  gate and the launch retry ring all poll it. It reads the CACHE only: this is
  polled on a timer, and a dozen RPC reads per probe would cost the launch the
  snipe exists to catch. A cached yes is a cheap yes; the absence of one is "we
  have not looked", never "this token cannot be traded".
- **Every amount is normalised at the boundary.** `core.js` prices in Numbers
  and these modules are BigInt: an un-normalised float reached `hi - lo` and
  threw `Cannot mix BigInt` out of `core.buy`, which the router renders as
  "Something glitched handling that" — the gate CRASHING instead of refusing,
  with the user never learning a refusal happened.
- **`err.curve_refused`, in both languages.** "the curve rejected this call
  (execution reverted…)" matched the `reverted` in the slippage rule and came
  out as *"the price moved"* — a false diagnosis about a call the chain
  declined. And a refusal that matched nothing fell to `err.generic`, i.e. "try
  again in a moment". It deliberately does NOT say *"retrying won't change it"*:
  most of these are fixed by one more trade on the pad. Separately,
  `can't route through yet` now maps to `err.no_route`, where it always
  belonged.
- **The receipt NAMES the discovered route** and says which price checked it. A
  gate nobody can read is the same as no gate, and a strong check and a weak one
  are different assurances — the `via DexScreener` rule, one process over.

### ⚠️ …and the CARD would still have had no Buy button

`core.buy` filling a curve changes nothing if the only surface a user can press
it from never offers the tap. On EVM, `tokenSnapshot` ended at
`if (!m) return null` — no pool, no indexer, so **"❌ Couldn't price it"** and no
buttons, about a token trading perfectly well on its pad. Every gate above
would have been reachable only from a snipe.

- **The Solana branch has had a launchpad leg since it was written**; the EVM
  branch never got one — `launchpads.*` appears only inside `isSvm`. It has one
  now.
- ⚠️ **And the pad alone is not enough**, because the operator's own box reports
  `✗ pons — can't reach api.pons.fun`: a launchpad-only leg is null exactly
  where it is needed. So the last source is the token's **own trades**, on the
  chain we are already talking to — no third party at all, and the one source
  that cannot be unreachable.
- **`routable` is MEASURED.** `curveSnapshot` returns `routable: false` always
  and says why in its own header; this overrides it with whether an interface
  was actually read, the same way the Solana branch overrides it with
  `_solRoutable`. Reading a price is still not being able to fill.
- **`liquidityUsd` is `null`, never `0`.** A curve has no pool depth to report,
  and `0` on a card reads as a rug — the rule `launchpads.js` already states for
  this exact field.

### "walaupun token launch di launchpad manapun" — the two things that were narrow

Nothing here was ever pad-SPECIFIC: the interface is read off real trades, so
the pad is data. But two constraints made it work on a Pons-shaped launch and
not on the rest.

- ⚠️ **THE WINDOW WAS FIXED AT 5000 BLOCKS** — under three hours on a
  two-second chain. A pad whose tokens trade a few times a day reads as "no
  trades found" there, which is a statement about the WINDOW reported as a fact
  about the TOKEN. `ifaceFor` escalates (`CURVE_WINDOWS`, 5000 → 60k → 400k),
  and **only on that one answer**: widening the first look instead would make
  every lookup pay for the slowest pad, on a call that sits inside the wallet
  lock, and a dead node asked three times is three times the same silence.
- ⚠️ **A PAD PRICED IN ITS OWN ERC-20 WAS REFUSED.** Robinhood's pads take the
  native coin; Virtuals-class pads take their own token. That buy pays no
  `msg.value`, so **which** token it takes is in neither the calldata nor this
  token's own logs — it is in the transaction's OTHER Transfer logs, where the
  trader paid the curve. One extra read, and only for the pads that need it.
  - **ONE quote token, or none.** Samples that disagree are two pads behind one
    selector, or a router in the middle; picking the commonest would put a
    guessed token address on a money path.
  - **Two legs, using the EXISTING router** — the same V2/V3 swap `buy()`
    already makes, aimed at the quote token, then an exact approval, then the
    curve. Not a new money path.
  - ⚠️ **A failure BETWEEN the legs leaves the user holding the quote token**,
    and every such error says so. The v4 wrapping path set that precedent with
    *"Your ETH is safe as WETH in the wallet"*.
  - ⚠️ **`size` is decided where the DIRECTION is known**, not derived later. A
    buy's size is what was PAID (native, or the quote); a sell's is what was
    handed over. Three places had to learn it and two of them were caught by a
    test rather than by reading: `observedRate` divided by `value`, so the
    whole fallback tier was **dead on exactly the pads whose HTTP host is most
    likely unreachable**; and the size band compared the tokens a trade
    RECEIVED against the quote we were about to PAY — two currencies — refusing
    every such buy as "a very different size", which reads as a rule working
    when it is a unit bug.
  - ⚠️ **A quote pad may not be priceable until after leg one**, because the
    observed rate is per unit of what the pad CHARGES. Whether that rate
    EXISTS is knowable from the samples alone, so the refusal still happens
    **before any money moves**.
  - **The independently-priced floor is DROPPED for the second leg.** It was
    computed for native we no longer hold in full — leg one spent its own
    slippage — so carrying it over would set a bound above what the curve can
    now pay and revert our own buy.
  - **The sell swaps the proceeds back**, best-effort: the tokens are already in
    the wallet, so a failed swap-back is a nuisance and never a loss, and
    refusing the whole sell over it would be worse.

### The insertion point, and why there is only one

`resolveCurve` resolves the **pools.trade** factory only, so a Pons token
answers `''`, which is then read as "graduated" and routed to the DEX. One
insertion inside `pick.kind === 'v2' && !_v2Fillable(pick)`, after the v4 probe
returns null, closes both dead ends — and ⚠️ **the second is the one the target
tokens actually hit**: the `can't route through yet` throw is guarded on the
token being INDEXED, and a pre-migration token is not, so control used to fall
through to the V2 router and die at `getAmountsOut`.

⚠️ **AND THE FIRST ARGUMENT IS THE PROVIDER, NOT `chain`.** The local `chain` is
the config record from `chainOf` and has no `getLogs`. Passing it does not
throw — it answers *"could not read the chain head"* and the buy falls back to
the old sentence, so the feature ships inert with no error anywhere. That is why
`curveBuyPath.test.js` asserts a **POSITIVE**: a refusal-only suite passes on
the broken wiring, and mutation-testing that exact substitution fails four tests.

```bash
cd tradebot && node --test curveIface.test.js curveRoute.test.js curveTrade.test.js curvePrice.test.js curveBuyPath.test.js curveSellPath.test.js
cd tradebot && npm run abi:check              # what THIS box can read off a curve
```

**Config a fix depends on:** nothing — but ⚠️ **it ships ON and that CHANGES an
existing install on deploy**, deliberately, the way the trending floors did.
`CURVE_ROUTE=0` is the kill switch and restores the old behaviour EXACTLY (the
old sentence, not a new one about a feature the operator turned off — pinned by
a test). `CURVE_DISCOVER_MS` bounds the discovery.

⚠️ **What could NOT be verified from here.** Every module is driven against stub
chains because this sandbox has no egress, so what remains unmeasured is
whether a real Pons curve's arguments classify at all, whether that node's
`eth_call` accepts a value-carrying call, and whether any EVM pad in
`shared/launchpads/pads.js` publishes a usable pre-migration price. The first
real buy on the box is the measurement, and `npm run abi:check -- <the token>
--curve` is what predicts it — section **4** now prints what each argument
MEANS, which is the same inference the buy path runs.

### "bot tidak bisa beli token di beberapa launchpad jika masih bonding curve" — INDEXED made it worse

Reported (2026-08-28) with the feature above fully deployed: the same Pons
token, the same card — price, cap, liquidity, volume all filled in, *"This
token's liquidity is on Pons v2, which Dexvra can't route through yet … Price
above is live from the indexer"*, and no Buy button. **That last sentence was
the diagnosis.** DexScreener indexes several pads' bonding curves as ordinary
pairs — Pons on Robinhood among them, since DS added the chain — and
`tokenSnapshot`'s curve leg only ran when `marketOf` answered NULL. An indexed
curve token took the `dexVenue:'ext', routable:false` branch without the curve
reader ever being consulted, `telegram.js` gates every Buy button on exactly
that field, and `core.buy` — whose own curve leg fills this exact shape,
indexed or not — was unreachable from the one surface a user can press Buy on.
**Being indexed made a token LESS buyable than being invisible.**

- **The indexed branch consults `_curveIface` now** and returns a routable
  curve snapshot when the interface reads: the indexer's numbers stay (they are
  facts, and the card the operator screenshotted showed them), the route comes
  from the chain. Bounded (`CURVE_DISCOVER_MS`) and cached (curveTrade: hits
  30 min, misses 90s), and an AMM can never read as a curve — the curve is the
  contract the token itself moves to and from, which a router never is.
- ⚠️ **AND `canTradeNow`'s curve leg now WARMS the cache it reads.** It read
  the cache ONLY, on the stated assumption that "buy() does the discovering,
  and the first buy warms this for every prober after it" — an assumption that
  is false for exactly the tokens the leg exists for: a snipe-watched launch
  never gets a manual first buy. The dev snipe, the CA snipe, `_fireLaunch`'s
  gate and the retry ring all poll `canTradeNow`; nothing ever filled the
  cache; so every automated path still bought at graduation while the manual
  button worked. The probe still answers NOW from the cache (the callers are
  timers, and a dozen serial reads per probe costs the launch) — the discovery
  runs FIRE-AND-FORGET, bounded, paced per token (`CURVE_WARM_MS`, default
  120s), and the next poll reads what it learned. A brand-new curve with no
  trades stays unreadable until somebody trades on the pad; the snipe now
  fires within a poll or two of that first observed trade instead of at
  graduation.
- Both are MUTATION-TESTED as positives, the `curveBuyPath` rule (a wiring
  that does nothing refuses beautifully): restoring the unconditional
  `routable:false` and dropping the warm each fail their tests.
- ⚠️ **And the window ladder was stopping one rung short on a range-capped
  node.** A node that REJECTS the wide `getLogs` (Robinhood's public RPC caps
  ranges — fbf33e2's subject) while serving every step produced a stepped walk
  that cleanly covered the whole span, found nothing — and was reported as
  *"could not read"*, because one `lastErr` variable could not tell the wide
  ask's failure from a hole in the walk. `ifaceFor` escalates to the wider
  windows only on *"no trades found"* and caches only a non-transport verdict,
  so a quiet pad's token was re-walked from scratch on every attempt and never
  once looked in the window its trades were actually in. `stepErrs` separates
  the two: zero step errors is zero holes (the step size always covers the
  span within the budget), so the answer escalates and caches. Mutation-tested
  — collapsing the two errors back into one fails two tests, including the
  ladder-climbs-on-a-capped-node one in `curveTrade.test.js`.

```bash
cd tradebot && node --test curveCardPath.test.js   # 4 tests, no network
```

**Config a fix depends on:** nothing. `CURVE_WARM_MS` paces the background
warm; `CURVE_ROUTE=0` still kills the whole route, card leg included.

#### "masih sama aja" again — the walk was structurally BLIND to a quiet token's trades

The same token, the fix above deployed-or-not, the same card — and this time
the tell was on the card itself: **24h volume frozen at $320.96 across three
renders 90 minutes apart**. The token's last trades were HOURS old, and the
window ladder cannot see a trade that old on this node no matter how often it
retries: Robinhood's public RPC **silently empties** wide `eth_getLogs` (a
50,000-block ask answered `[]` over real trades — the incident that forced the
stepped walk), and the wider windows' steps grow with the span (400,000/24 ≈
16,667 blocks), so past some age EVERY range big enough to reach a trade
within the step budget comes back empty. The walk honestly reports "no trades
found", caches the miss for 90s, and re-reports it for ever — about a token
DexScreener was pricing on the same render.

- **The trades are found by their HASHES, from two seed sources — the chain's
  own first.** The node that empties a wide ADDRESS-filtered ask has answered
  wide TOPIC-filtered asks on this same box (it is how the preflight found the
  real Pons factory), so source 1 is the curve's own Transfer legs, topic-
  filtered by the pool address the indexer names (for an indexed curve token
  the DS pair address IS the curve contract) — no address in the filter, on
  purpose: the address is what re-triggers the cap, and a foreign token's log
  costs nothing because only the HASH travels. Source 2 is GeckoTerminal's
  pool-trades endpoint, where GT carries the pool. `ifaceFor` seeds discovery
  from the hashes when a window comes up empty — after the FIRST window, so a
  fresh launch still resolves without a seed request, and a quiet token skips
  the two wide windows that are usually blind to it anyway.
- ⚠️ **The hashes are POINTERS, never facts.** Everything decoded still comes
  off the chain's own receipts and transactions — the same trust base as
  `getLogs` — so a wrong or fabricated hash yields no receipt or no Transfer
  of OUR token and contributes nothing; classification, `sane()` and
  `simulate` are untouched. An indexer that is down costs the seed and
  nothing else: the ladder still runs, and the seed is also tried once after
  a walk that ended in transport failure (a different transport says nothing
  about this one).
- **The card path finally SAYS why it refused** — `[curve] card <chain>/<ca>
  unroutable: <why>` at info, because "not deployed", "discovery timed out"
  and "genuinely unreadable" were indistinguishable from Telegram, and every
  round of this report has started from zero because of it.
- Mutation-tested: disabling the seed fails the unit test AND the end-to-end
  card test that reproduces the reported state verbatim (every `getLogs`
  silently empty, DS pricing the token, GT naming the trades).

```bash
cd tradebot && node --test curveCardPath.test.js curveTrade.test.js   # incl. the seeded-discovery tests
```

**Config a fix depends on:** nothing. Whether GT serves the trades for a given
pool is a property of the box's egress — `npm run abi:check -- <token> --curve`
on the box is still the measurement when a card stays unroutable, and the
`[curve]` log line now names the stage that refused.

#### "ini token kan belum bonding" — the FIRST buyer could never buy, and that is the launch snipe

The next report was a token the operator had JUST launched: 0% to graduation,
0.002069 ETH raised, no trades. The observed route needs two trades of
different sizes on the token itself, so the first buyer of a fresh launch was
structurally refused — and the first buy is the entire point of sniping a
launch.

**The LEARNED-SHAPE TRANSFER is the answer, and byte-identity is its licence.**
A launchpad deploys the same curve for every token it launches. Every
successful discovery now RECORDS the pad's buy shape (selector + per-slot
roles, constants included; the sibling's ratio deliberately dropped — it is the
sibling's price), keyed by `keccak256(getCode(curve))` and persisted to
`DATA_DIR/curveShapes.json`. A fresh token whose indexer-named pool carries
**byte-identical code** gets the shape transferred: identical deployed code —
immutables live in the code — executes identically, only storage differs, and
the storage question ("is this really MY token's curve?") is answered by
`simulate`, because a curve bound to another token reverts the call.

- **What replaces `sane()` on a transfer** — there is nothing observed on THIS
  token to feed it: the shape was sane()-checkable when it was learned, the
  code identity carries the meaning over, and the on-chain floor is OURS from
  a STRONG price — `buildFromShape` refuses to build without one, refuses a
  shape with no minimum-out slot (gas alone is no gate), refuses two scaling
  slots, and re-refuses a stranger's constant address even out of the stored
  file (a file is not a proof).
- **Tier 2b joined `curvePrice`: the INDEXER's cap ÷ on-chain supply.** On the
  operator's box the pad's HTTP host is unreachable and a fresh launch has no
  fills for tier 3 — so without this there was NO strong price for exactly the
  tokens the transfer exists for. DexScreener publishes a cap for indexed
  curve tokens; same independence class as tiers 1–2.
- **The classify-short case rides the same proof**: a token with ONE observed
  buy (decodable, not classifiable — "only 1 sample") falls back to the
  learned shape when the selector matches what was observed.
- **One taught sibling, ever, is enough** — the registry survives restarts,
  and any traded token on the pad teaches it organically (a card open, a buy,
  the snipe warm). Transfer is native-paid buys only; a transferred SELL is
  deliberately out — a sell's argument semantics cannot be disambiguated
  without observation, and "one sale by anyone teaches it" already stands.
- Mutation-tested: ignoring the bytecode identity fails the different-code
  test; the mandatory-floor, stranger-constant and no-minimum-out refusals
  each carry their own.

#### ⚠️ …and the walk's STEP SCALED WITH THE SPAN, so the ladder never reached anything

Three cards over 22 minutes carried the identical sentence — *"no trades found
for this token in the last 400000 blocks (also walked 24 smaller ranges)"* —
about a token whose launch buy is plainly on chain. **The number in that
sentence was the range we WANTED, and the range we COVERED was nothing at
all.** The stepped walk exists because this node answers a too-wide
`eth_getLogs` with `[]` rather than an error, and its step was
`ceil(span / budget)`: 209 blocks at the 5,000 window, **2,500** at 60,000,
**16,667** at 400,000. Every step of every window past the first was itself
too wide, silently emptied, and the ladder's whole purpose — reaching an older
trade — could not work. Meanwhile the snipe loop reads this same chain in
~60-block ranges all day.

- **The step is FIXED now** (`CURVE_LOG_STEP`, 500), because the range a node
  serves is a property of the NODE, not of how far back we want to look. How
  FAR we reach is the budget's job (`CURVE_LOG_STEPS`, 48).
- **TWO PASSES, coarse then fine.** Coarse keeps the old cheap behaviour for a
  node that serves wide ranges (and is what reaches a trade far back in the
  window); fine re-walks near the head in node-sized asks, and only when
  coarse found nothing. ⚠️ A node where every coarse step ERRORED is not
  re-walked — that is the same silence 48 more times, this file's own dead-node
  rule, which the second pass would otherwise triple the cost of.
- **The refusal quotes the range WALKED, not the range wanted.** "The last
  400000 blocks" described a search that did not happen, and it is why the same
  sentence came back three times while the real reach never changed.
- **`steppedLogs` is the one owner** and the seed, the sibling-curve scan and
  the decoder all read through it — the wide single ask was silently empty in
  every one of them.
- Mutation-tested: dropping the fine pass fails the new silent-cap test (a stub
  node that empties anything wider than it serves, with the trade older than
  the first window).

- ⚠️ **A TOKEN WITH *SOME* HISTORY BUT NOT ENOUGH promised a Buy it could not
  honour.** Two SAME-SIZED buys DECODE — so `ok` is true and the card offers
  Buy — but classify wrongly: with no variation to correlate against, a real
  minimum-out reads as a `constant`, `buildCurveCall` returns ok with
  `expected: null`, and `sane()` refuses every buy. The self-teach ran only for
  a token with NO history, so nothing taught the pad. Now: a shape with no
  amount-tracking slot is never RECORDED (it is keyed on the pad's bytecode, so
  a degenerate reading from one thin token would overwrite the good shape a
  properly-traded sibling taught, for every token on that pad), the teach runs
  on the classify-short case too, and `prepareBuy` falls back to the learned
  shape whenever the observed build cannot produce an expectation.
- ⚠️ **A ROUTED BUY NAMED NOTHING IT WAS PAID IN.** The quote detection
  required the payment Transfer to run TRADER → curve, so a pad whose website
  routes the buy (user → router → curve) pays from the router's address, no leg
  matched, and `quoteOf` — which needs every sample to carry one — went null.
  The live refusal was exactly that: *"this pad's buy is not paid in the native
  coin, and its trades do not show what it IS paid in"*, about a pad that
  plainly charges something. What the curve RECEIVED is the fact; who forwarded
  it is not. `quoteOf` still refuses samples that disagree, which is what keeps
  a router's own fee transfer from being read as the price.
- ⚠️ **AND THE REFUSAL NOW NAMES THE STAGE.** `err.curve_refused` swallowed
  `prep.why` whole, so a price refusal, a classify refusal and a simulate
  refusal all read as the same "a few more trades on the pad" — the "a value
  nobody can read is the same as no value" defect on the money path, and the
  reason four rounds of "masih sama aja" began with nothing to go on. The
  template is ours and carries markup; only the appended stage is escaped.
  (Five call sites also wrapped the whole friendly template in `esc()`, so its
  `<b>` tags reached Telegram as literal text.)
- ⚠️ **A LAUNCH NO INDEXER KNOWS YET had no curve address at all.** The pool
  lookup asked DexScreener and GeckoTerminal only, so a token minutes old that
  neither had indexed fell to *"❌ Couldn't price it"* — the exact state a
  launch snipe exists to act in. The pad's factory names the token AND its pool
  in ONE log, so the announcement that names this token is the binding, and
  every contract that log names becomes a CANDIDATE. They are offered, never
  trusted: the same log names the dex factory and the quote token, and
  `_shapeFor`'s bytecode gate picks — filtering to logs that name our token is
  what keeps a matched candidate OUR launch's curve rather than a sibling's.
  Only walked when the indexers gave nothing, so an indexed token pays nothing.
  Mutation-tested: taking the first candidate instead of the matching one fails
  the unindexed-launch test.

```bash
cd tradebot && node --test curveShape.test.js curveCardPath.test.js curveIface.test.js
```

**Config a fix depends on:** nothing — and the pad teaches ITSELF, see below.

#### …and "teach it by pasting a traded token first" was the same defect again

The transfer shipped needing the pad to be primed once, by hand. The next
report was the same screenshot: a fresh Pons launch, no Buy button — because
from Telegram, a route that needs a manual priming step is a route that does
not work. **"apt-get install is not a fix, it is a request"**, on the feature
that had now been reported four times.

- **`siblings()` is the self-teaching pass.** When nothing has taught the
  pad, the bot finds one of the pad's OTHER tokens, reads its interface, and
  records the shape — which then transfers to ours. Recursion stopped at depth
  1 by `learning`.
- ⚠️ **AND ITS FIRST SOURCE HAD TO BE THE CHAIN.** The first cut asked
  GeckoTerminal for the pad's other pools, and on the one chain this feature
  is for GT need not carry the pad at all: the next card came back *"no trades
  found … nothing to read its interface from yet"* — nothing had taught the
  pad and nothing could — while the bot's own snipe loop had already seen
  **227 Pons launches** from the factory's announcements. Those are read now
  (`padFactory.announcersFor`, shared with `watchers.js` so a factory address
  has ONE owner), address+topic filtered, which is the narrow ask this node
  serves. The event's ABI is unknown, so **bytecode identity does the
  identification**: every address a launch log names is a candidate, and the
  ones whose code hashes equal our curve's are sibling curves by construction.
  A sibling's own Transfer legs then name its token, and carry the hashes the
  decode needs — no indexer at any point. GT's dex list stays as the second
  source.
- ⚠️ **THE BYTECODE GATE HOLDS ON THE TEACHING PATH TOO.** A sibling teaches
  nothing until `_shapeFor` matches OUR curve's code — so a wrong list, a
  different pad, or a hostile answer contributes nothing at all. Pinned by its
  own test and mutation-tested: taking the sibling's own pool as the key
  instead of ours fails it. ⚠️ The code comparison in the CANDIDATE scan is a
  cost filter and says so — mutation-testing proved it changes no outcome,
  because a shape is recorded under the code hash of the curve it was read
  from and `_shapeFor` looks it up under ours. Writing it up as the boundary
  would have been a comment describing a guard that is somewhere else.
- ⚠️ **AND THE REASON MOVED ONTO THE CARD.** The card path already logged why
  it refused, and the operator's `grep '[curve]'` came back EMPTY on a box
  rendering that exact card: the snipe loop writes several lines a second, so
  the one line that mattered had scrolled past `--lines 200`. A diagnostic
  that exists and cannot be retrieved is "a value nobody can read is the same
  as no value" — it cost four rounds. `curveWhy` rides on the snapshot and
  `unroutableCard` prints one short line, only when a reason was recorded.

### "sudah berhasil tpi bot respon lama sekali" — two RPC waves that never needed to be serial

The curve buy landed (a Pons bonding-curve token rendering the full card with
Buy 0.01 / 0.05 / 0.1, Limit buy and DCA), and the next thing the operator
said was that the card takes too long to arrive. Measured against the code
rather than guessed: `tokenCard` awaited `tokeninfo.enrich` — which on a curve
token reads the curve's interface, the slowest read this bot makes — and only
THEN read a `totalSupply` plus two balances per wallet, five wallets deep. Two
waves that know nothing about each other, in series, on the one screen a user
stares at after pasting an address.

- **The balances START before the scan is awaited and are COLLECTED after it.**
  They need one thing, the token's decimals, and `tokenMeta` is already
  fetching it — the same lesson the file's own header states about `tokenMeta`
  itself, one wave further down. ⚠️ `.catch` at CREATION, because every early
  return (no price, an unroutable card) leaves the promise in flight and an
  unhandled rejection for a balance read would take the process down.
- **`gasSnapshot` and `marketStats` moved up beside the snapshot** in `enrich`
  for the same reason: neither reads anything the snapshot produces, and both
  sat in the task list behind it.
- **`[ui] card … total=Xms enrich=Yms rest=Zms` past `CARD_SLOW_MS`** (1.2s).
  "The paste is slow" and "the wallet reads are slow" send an operator to
  different places — a scan timeout versus the RPC — and the existing
  `[ui] slow cb:` line reports only the whole handler. Silent under the
  threshold: a fast card must not write a line per paste into a log the snipe
  loop is already filling.
- ⚠️ **The gas guard was pinned to a LINE, not a property**, so moving the read
  earlier failed a test about gas being real. It asserts the property now — the
  read is made, it lands on `info.gas`, it is collected in the bounded task
  list — and the new overlap guard is mutation-tested: putting the serial
  `await core.tokenAcrossWallets(...)` back fails it.

⚠️ **What this does NOT fix: the RPC itself.** `SOLANA_RPC`-style paid
endpoints are the standing lever on every read here (see "The two biggest
levers are CONFIG, not code"), and on Robinhood the public node is what the
curve walk, the balances and the meta reads all share.

```bash
pm2 logs dexvra-tradebot --nostream --lines 400 | grep -F '[ui] card'
```

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

## The snipe watched one launchpad per chain, and a dev snipe that arrived first could never fill

"add api pons untuk snipe trading ga hanya robinhood chain atau pons launchpad
tpi beberapa launchpad dan make sure sniper trading snipe dev wallet is working
bneran beli" (2026-08-27). Two defects, and the second is the one that made the
first invisible.

**Discovery was one launchpad per chain.** The Robinhood snipe filters ONE
factory address for ONE `TokenCreated` signature; the EVM chains scan
`PairCreated`; Solana polls pump.fun. A token born anywhere else — Pons on
Robinhood, LetsBonk or Moonshot on Solana, four.meme on BNB, Virtuals on Base —
was invisible until it migrated to a DEX, hours after the window anybody snipes
in. And `eth_getLogs` answers an unknown topic with an EMPTY ARRAY, so a second
launchpad appearing on a chain does not read as a missing feature: it reads as a
quiet chain, behind a green /health — the exact shape of the pump.fun outage.

- **`padSnipeCycle` polls the shared registry's feeds, for every chain any pad
  covers.** Adding a launchpad to the snipe is now a row in
  `shared/launchpads/pads.js` and nothing else — every pad in the table gained a
  `feedPath`, and Pons is a row like any other (`LAUNCHPAD_PONS_API` pins its
  host, `LAUNCHPAD_PONS=0` kills it, same as every pad). It is a SECOND way in
  beside the event scans, not a replacement: a log read from our own node is
  faster than a third-party HTTP poll and needs no third party.
- **`_fireLaunch` is the one fire path** — the follower match, the dedup, the
  safety gate, the affordability check, the buy and the purchase message. Four
  discovery sources each carried their own copy and three had already drifted
  (only one recorded launches while nobody was armed; only the EVM ones told a
  user their wallet was short; the Solana one skipped an empty wallet silently
  — the inert-watch failure, on the money path). `autoSnipeConsent.test.js` now
  pins the purchase-site count at exactly ONE.
- **One cursor per pad per chain, first look seeds only** — the rules the Solana
  extra-pad helper already had, now for every chain. pump.fun keeps its own
  poller and its own cursor; the pad loop explicitly skips it, or two pollers
  share one feed and that is "one repo, two answers" again.
- **A feed that 404s is backed off HERE, not in the registry's breaker.** The
  breaker deliberately benches only transport failures because for a TOKEN
  lookup an HTTP status is an answer. For a FEED a 404 is a fact about the
  path: it will 404 next tick too, for ever, and this loop asks every few
  seconds. `_padSnipeStats.pads` keeps the reason per pad, in /health.
- ⚠️ **`_snipeMark` lowercased every address, and base58 is case-SENSITIVE.**
  Fine while each chain's seen-set only ever saw its own scan; the moment two
  feeds can name the same Solana mint, two different mints can fold onto one
  key and the second launch is silently dropped as "already sniped".
  `_addrKey` — the registry's rule — per chain.

**And a launch seen too early was a launch dropped for ever.** Every discovery
source sees a token at the earliest possible moment, which is precisely the
moment there is usually nothing to trade against: a pump.fun mint is not on
Jupiter for the first seconds, a pad feed names a token that has no pool at
all, and a dev's token exists before the dev opens its pool. The buy failed
with "no route" — and the cursor had already advanced, the seen-set had already
marked it, so nothing could ever offer it again. The Solana path's comment said
"retried while it's fresh" over code that could not. **That is why the
dev-wallet snipe "worked" and never bought**: seeing the launch before the pool
opens is the entire value of following a dev, and it was the one case
guaranteed to fail.

- **The retry ring** (`_launchRetry`, `LAUNCH_RETRY_MS` 3 min, `=0` disables)
  holds a launch whose ONLY problem is timing and re-offers it until
  `core.canTradeNow` — the single owner of "can a swap be filled right now" —
  flips, or the clock runs out. Probes are bounded and round-robin, with the
  same tighter Solana budget as the CA snipe, for the same reason: a Solana
  probe is an aggregator quote against the host every real buy needs.
- **`_notYetTradeable` separates "no market YET" from every real failure.**
  "No route / no liquidity / zero quote / no pool" goes in the ring and is NOT
  a failure DM — a warning per launch that fills twenty seconds later teaches
  the user to swipe past the warnings that matter. A revert, a short balance, a
  429, and "liquidity is on a venue Dexvra can't route through" stay failures;
  the last one is deliberately excluded from the retry ring because it will not
  change.
- **The ring remembers who already bought** (`done`), because re-offering a
  launch to a user whose buy held is a double spend — strictly worse than the
  miss it exists to fix. A dev target's own `bought` map is the second line.
- **Pad-discovered launches are GATED on `canTradeNow` before the first buy**;
  the event scans are not. A `PairCreated` log means the pool exists in the
  block just read — spending a round trip to confirm what the log said is how a
  sniper arrives late. There the failure is the signal, and it lands in the
  ring.
- ⚠️ **The short-balance notice printed lamports through `formatEther`.** It
  was EVM-only before `_canAfford` unified the check; on Solana it would have
  said "Need 0.000000002" for two SOL — a number that reads as a bug in the bot,
  on the one message whose job is to say what to top up. `formatUnits(v, 9)` on
  the SVM branch.
- **`tradebot/launchpads.js` no longer keeps its own chain list.** `chainFor`
  was a hand-written map of three chains, so a pad added to the table for a
  fourth chain (Pons/Robinhood, here) was dropped RIGHT THERE: `covers()` said
  no and the pad was never asked anything — nothing threw, nothing logged. It
  derives from `lp.padsFor()` now; a `RENAMES` map (empty) is the only local
  fact left.

### "apakah anda yakin??" — the audit found nine more, and the worst was the feature disabling itself

Asked straight after the above landed. A five-lens adversarial audit (every
finding attacked by two independent refuters; 20 raw claims, 13 survived, plus
three found by re-reading before the audit ran) — and the worst finding is this
file's oldest shape: **the reassuring reading was available, and it was wrong.**

- ⚠️ **The pad loop's mark was silently disabling the graduation snipe.** The
  pad feed marks a curve token at MINT, minutes-to-days before anything can
  fill it; the retry ring gave up after its three-minute window and the mark
  stayed. When the token graduated into the PairCreated log — the one place
  these tokens were ALWAYS bought before this feature existed — the dedup
  skipped everyone, dev followers included. A launchpad integration built to
  widen discovery had quietly turned the working path off, on every pad-covered
  EVM chain, for any launch that takes longer than three minutes to graduate —
  which is nearly all of them. `_snipeUnmark`: a launch NOBODY was served (no
  fill, no broadcast) is unmarked on every terminal ring outcome — expiry, cap
  eviction, audience-gone, ring-disabled — so its graduation event can offer
  it; a launch somebody HOLDS stays marked, because for them the graduation
  buy is the double spend. And a re-sighted token is emptied of its snipe-all
  audience, never `continue`d whole — snipeCycle's shape, now on all three
  event scans, so dev followers (idempotent via their own `bought` map) still
  fill at graduation.
- ⚠️ **The dev budget's check-then-claim spanned a network await.** The safety
  gate sits between "does it fit" and "claim it", and the ring now fires
  concurrently with the discovery loops — two launches by one dev could both
  read a stale `spentEth` inside that await, both pass, both claim: real money
  past the user's cap by a full fan-out. Both the dedup and the cap are
  re-checked AFTER the await, synchronously with the claim.
- ⚠️ **A re-scan's requeue forgot who was already served.** The emptied
  snipe-all audience now rides as `skip`, so a launch parked during a re-scan
  carries the first pass's fills in `done` — without it the ring re-bought for
  a user whose fill happened before the requeue existed.
- **The ring retro-sniped for users who armed after the launch.** The audience
  is FROZEN at queue time (`eligible`) — arming is forward-looking, the
  audit-#2 rule, and the ring re-reading `_armedOn` at fire time was a window
  around it.
- **solSnipeCycle still dropped over-budget launches** — the exact shape just
  fixed in padSnipeCycle, one loop up. Overflow queues there too.
- **A registry-breaker SKIP was counted as a feed failure** — "we never asked"
  recorded as "it did not answer", and the two benches fed each other's
  counters. A skip updates the visible `why` and nothing else.
- **A feed whose items carry no readable `createdAt` seeded forever** and read
  green: the cursor could never advance, so no launch there could ever fire,
  while every stat said the pad was healthy. It records exactly that, as a
  parse problem (`_FEED_PATH`/field fix), never a bench.
- ⚠️ **`health()` assigned over the ring loop's own heartbeat**, so a stuck or
  disabled ring rendered green because its counters still existed. Merged, with
  `enabled` stated; `padSnipe.err` carries its age, or Tuesday's error reads as
  now's.
- ⚠️ **`_canAfford` read a dead RPC as an empty wallet** — `ethBalance` answers
  0n for both, so a funded Solana user would have been told "wallet has
  0.00000" and the told-once flag latched on a balance nobody read.
  `ethBalanceOrNull`, the same fix the removal guard needed one section up.

Refuted and NOT acted on, for the record: the `LAUNCH_RETRY_MS=0` "pad snipe
can't buy" claim (the gate still fires tradeable launches inline), and the
pons-probe boot alert (by design — `verified:false` pads are supposed to be
loud until checked on the box).

```bash
cd tradebot && node --test padSnipe.test.js         # 34 tests now — every finding above is pinned
```

### "pons launchpad tidak anda add??" — it WAS added, and the ✗ proved it; the fix is on-chain

The first `launchpads:check` on the box: `✗ pons — can't reach api.pons.fun`,
read as "pons was never added". The row existing is what proves it was — what
failed is the GUESSED HTTP hosts, which answer neither from the server
(timeout) nor from anywhere this repo is developed (egress-blocked). The same
run also measured `moonshot` (DNS dead — host retired) and `four.meme`
(403 — the datacenter-IP block the launchpads section already predicts).

So Pons discovery is **on-chain now** (`_ponsScan` in `tradebot/watchers.js`),
and that is the better design, not a fallback: Pons launches straight into a
Uniswap v3 (V1) / v4-hook (V2) pool on Robinhood Chain, announced by its own
factory's `TokenLaunched` event — a **different contract and signature** from
the `TokenCreated` the primary scan filters, i.e. exactly the second-launchpad
blind spot this feature exists to close, on the bot's own chain. The chain is
the one source the box already reads for every trade; no third party, no
egress. The event's `deployer` is the actual dev wallet, so the dev snipe
matches with zero extra reads. The HTTP pad stays for display metadata only.

- **The factory address and event signature are researched guesses** —
  cross-checked against Pons's public integration docs and the chain explorer,
  but NOT verifiable against a live RPC from the sandbox this was written in.
  So both are env-overridable (`PONS_FACTORY`, `PONS_EVENT`), the kill switch
  is shared with the HTTP pad (`LAUNCHPAD_PONS=0` — one feature, one switch),
  and every way the guess can be wrong is DIAGNOSED, never silent:
  a factory with no code → `ponsErr` names the address; a factory that emits
  logs the filter never matches → `ponsErr` says the SIGNATURE is stale (the
  raw-vs-decoded probe, rate-limited to one per 10 min); nothing emitted →
  `ponsSeen` stays 0 in /health beside a null error, a quiet pad.
- **Its own cursor, its own failure surface.** A Pons outage or a stale Pons
  ABI costs Pons launches, never the pools.trade scan sharing the loop.
- **The code verdict is cached per FACTORY** — a verdict about one address
  must not answer for another, or a corrected `.env` stays condemned.
- **Nothing from the event reaches the money path.** The buy is priced,
  routed and gated by `core.buy`/`canTradeNow` like every discovery source;
  Pons V1 pools are plain v3 and V2 pools are the v4 hooks `v4.js` already
  autodiscovers, which is why no routing code was needed.
- **`npm run preflight:robinhood` now probes it** (section 4p): code, recent
  `TokenLaunched` count with the latest launches decoded, and the computed
  stale-signature diagnosis with the factory's real topic0 list as the lead.
  That command, on the box, is what turns this integration from "researched"
  to "verified".

```bash
cd tradebot && node --test padSnipe.test.js          # includes the 5 Pons-scan tests
cd tradebot && npm run preflight:robinhood           # 4p verifies the factory against the live chain
```

**Config a fix depends on:** nothing to turn on. If 4p says the factory or
signature is wrong, the fix is `PONS_FACTORY=` / `PONS_EVENT=` in
`/opt/dexvra/tradebot/.env` (the trade bot reads its OWN `.env` — the rule
above) and a `--update-env` restart.

#### The probe answered, and BOTH researched guesses were wrong

The section above ships a factory address and an event signature taken from
Pons's public docs, and says in as many words that only the box can settle
them. It did, and the answer was **no on both counts**:

- **Neither address had contract code.** `getCode` on the box came back `0x`
  for `0xA5aA…` and `0x0c37…`, so the scan was condemned before it ever
  filtered a log — and it said so, correctly, in `/health`.
- ⚠️ **And the signature could never have matched either.** The documented
  `TokenLaunched(address,address,address,address,address,uint256,…)` hashes to
  `0xdb51ea…`; the launchpad that really announces a Pons launch emits
  `0x8d4aad…`. So even with the right address the filter would have returned an
  empty array for ever — **the exact shape this whole feature exists to close**,
  reproduced by the fix for it. Two guesses, and each one alone was enough to
  make the scan inert.

Both defaults are now what `preflight:robinhood` READ OFF THE CHAIN
(`0x7ed598bc…` and `0xe33e9e47…`, which both announced the same launch at block
47496254; `PONS_TOPIC0_DEFAULT` is the measured topic). What could NOT be read
is the ABI behind that topic — **1050 candidate `name(argtypes)` spellings were
hashed against it and none matched** — and that is the interesting half.

- ⚠️ **A TOPIC0 IS NOT AN ABI, AND THIS SCAN AIMS A BUY.** Knowing which log
  announces a launch says nothing about which of its words is the token, and a
  launch log NAMES the pool and the quote token too. Reading the wrong word
  buys a stranger's contract with somebody's money — so `_ponsResolve` guesses
  **nothing**: the token is the address the log NAMES *and* that the same
  transaction MINTED (an ERC-20 `Transfer` out of the zero address). Two
  independent facts, and their intersection is decided by the chain rather than
  by an assumed argument position.
- **It REFUSES rather than picks.** Anything but exactly one survivor fires
  nothing and says why. The cost of refusing is a missed snipe — a shrug, the
  rule this file has stated since the CA snipe; the cost of picking is the
  wrong token.
- **The one predictable ambiguity is ELIMINATED by asking the chain, never by
  position:** a v2-style launch mints its LP token too, and the pair is named
  by the log as the pool — so a second candidate is dropped when it answers
  `token0()`. An eliminator, never a selector; two survivors still refuse.
- **`Transfer` is matched on THREE topics, not four.** A Uniswap v3 position
  NFT is minted from the zero address in exactly these transactions, and ERC-721
  carries its id as a third indexed topic.
- **The deployer is the transaction's SENDER** — the inference the
  `PairCreated` scan already documents. It only ever decides whether a dev
  follower matches, never what gets bought, so being wrong costs a miss.
- **`PONS_EVENT` takes EITHER spelling, decided by shape**: a full
  `event Foo(...)` signature, or the bare 32-byte topic0 an explorer shows. The
  old instruction — *"PONS_EVENT must be the signature whose keccak matches that
  topic0"* — is a research task, not an instruction, and 1050 hashes say an
  operator has no better chance than this session had. `PONS_KNOWN_SIGS` is the
  bridge: a pasted topic0 whose spelling we DO know lights the named decode back
  up by itself, with no receipt read at all.
- ⚠️ **MATCHING A LOG IS HALF THE TRIGGER, so 4p no longer calls a topic match
  "alive".** It resolves every launch it finds **through the bot's own
  `_ponsResolve`** and goes RED when none resolves — a probe green on the log
  count alone would print a tick over a scan that names no token and therefore
  buys nothing. That is `fonts:check`'s nine green ticks over a banner
  publishing boxes, one feature over: a guard is only honest while it measures
  the stack the thing it guards actually runs.
- **4t prints both `.env` lines COMPLETE** — `PONS_FACTORY=` and now
  `PONS_EVENT=` with the topic it just found. This file's first rule, and the
  one this very round already cost an operator a broken shell over.
- ⚠️ **The raw-mismatch probe is rate-limited to one look per 10 min**, which is
  right in production and is inherited state in a suite: one test consuming it
  leaves the next reading a null `ponsErr`, which looks exactly like the
  diagnosis being broken. `reset()` states it (`_ponsResetProbe`) rather than
  letting test order decide. The CURSOR is deliberately NOT reset — a test that
  seeds it is testing the seeding rule.
- Four guarantees are MUTATION-TESTED rather than argued: picking instead of
  refusing on ambiguity, dropping the minted-in-its-own-transaction half of the
  proof, dropping the `token0()` eliminator, and restoring the documented
  topic0. Each fails between one and seven tests.

```bash
cd tradebot && node --test padSnipe.test.js          # 48 tests, no network
cd tradebot && npm run preflight:robinhood           # 4p: resolves each launch, RED if none does
```

⚠️ **Still not verified from here, and it cannot be:** whether that topic0 is
the launch event on every Pons deployment, and whether a real Pons launch
transaction mints exactly one address the log also names. Both are properties of
the chain, so 4p on the box is the measurement — and if it goes red, the whole
fix is the two lines 4t prints.


#### …and a Pons token still could not be BOUGHT, because V3 was off

The scan above finds the launch. Filling it is a separate question, and the
answer was no: **`chains.js` shipped Robinhood's Uniswap V3
`factory`/`router`/`quoter` blank**, `v3Cfg()` needs factory AND router, so the
V3 leg was disabled outright — and a Pons V1 launch goes *straight into a
Uniswap V3 pool*. So every Pons V1 token reached `bestDexVenue` with no V2 pair
and no V3 config, and the card said *"This token's liquidity is on Pons v2,
which Dexvra can't route through yet"* about an ordinary Uniswap pool it was
simply not configured to look in. `preflight:robinhood` has been printing the
instruction the whole time — *"they are untradeable until these are set"*.

- **The addresses are a CITATION, not a guess.** The old comment sent the next
  person to "Uniswap's deployments page"; this is that page, quoted:
  `github.com/Uniswap/contracts` → `deployments/json/4663.json`.
- **AND IT CROSS-CHECKS**, which is what separates it from the two researched
  Pons values that were both wrong one section up. That same file's
  `UniswapV2Router02` is byte-for-byte the `DEX_ROUTER` this repo has been
  trading through since it was written — so the record and this file describe
  the same deployment, and a record that ever stops matching is a record of some
  other chain. `robinhoodRouting.test.js` pins that equality for that reason.
- ⚠️ **A citation is still not a measurement**, and this feature has just been
  taught that twice in one round. A wrong value here FAILS SAFE — a factory with
  no code makes `getPool` throw and `v3BestPool` answer null; a wrong router
  cannot pass the `estimateGas` the V3 buy does before it signs — but "fails
  safe" is not "is correct", so **`preflight:robinhood` now `getCode`s both**
  and says whether it is looking at the shipped default or an operator's own
  value. Red there is a real answer; the fix is `scripts/v3-discover.js`.
- **The QUOTER is never read** — V3 pricing is off the pool's own `slot0`, which
  is why a canonical quoter copied from another chain could sit here wrong for
  so long without being noticed. It is carried so the record is complete.
- **Blank env means UNSET, not "set to nothing".** A `.env` carrying a bare
  `ROBINHOOD_V3_ROUTER=` must not switch the leg back off; a test pins it.

Whether a pad's guessed feed path is right is measured on the box, not assumed
— every new feed is `verified: false` until `launchpads:check` proves it, and a
wrong path costs a `.env` line (`LAUNCHPAD_<PAD>_FEED_PATH`), not a deploy.

**Config a fix depends on:** nothing. Every pad ships on, blank means on, and
the retry ring has a working default. `PAD_SNIPE_POLL_MS`, `LAUNCH_RETRY_MS`,
`LAUNCHPAD_FEED_BACKOFF_MS` exist for an operator who wants different pacing —
and pons.fun's real API shape has NOT been verified from inside this sandbox
(its host blocks this egress), so the first `launchpads:check` on the server is
the moment `LAUNCHPAD_PONS_API` / `_FEED_PATH` / `_TOKEN_PATH` may need a line.

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
