// /api/ohlcv and the panel it feeds. Source guards, because the route imports
// "@/"-aliased Next modules the test runner cannot resolve — the numbers
// themselves are driven for real in ohlcv.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ROUTE = read("src/app/api/ohlcv/route.ts");
const CHART = read("src/components/CandleChart.tsx");
const PAGE = read("src/app/(site)/token/[chain]/[address]/page.tsx");
const POOL = read("src/app/api/pool/route.ts");
const GTPOOL = read("src/lib/providers/gtPool.ts");
const CSS = read("src/app/globals.css");
/** Comments quote the code they guard, so a POSITIONAL check has to read the
 *  code alone — the first mention of the cache key in this route is the comment
 *  explaining why it is built after the chain check. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("⚠️ the candles are asked for OUR token, not the pool's base side", () => {
  // GT's OHLCV defaults to `base`, which is our token only by luck: in a
  // WETH/OURTOKEN pool it is WETH, and the page would draw Ethereum's chart
  // under a memecoin's ticker — a WRONG number, not a missing one.
  assert.match(ROUTE, /token,/);
  assert.match(ROUTE, /never the pool's base side/i, "and the reason is written down where the param is set");
});

test("a 404 is an answer about the pool; anything else means GT never looked", () => {
  // Caching a 429 would let a two-minute backoff blank every chart on the site
  // for the TTL — the bot's changeFromCandles lesson, one surface over.
  assert.match(ROUTE, /if \(res\.status === 404\) return null;/);
  assert.match(ROUTE, /class Unreadable extends Error/);
  const handler = ROUTE.slice(ROUTE.indexOf("export async function GET"));
  assert.match(handler, /catch/, "a transient failure answers without being cached");
  assert.ok(!/cached\([^)]*Unreadable/.test(ROUTE));
});

test("a pool address from the caller is a HINT, and a 404 on it re-resolves", () => {
  // The token page passes the pool GeckoTerminal named, but a preview built
  // from DexScreener carries a PAIR address GT has never indexed.
  assert.match(ROUTE, /A caller-supplied pool is a HINT/);
  // Distance-free: a character window between two lines breaks the moment a
  // comment is added between them, which is a test about formatting.
  assert.match(ROUTE, /if \(candles == null \|\| candles\.length === 0\)/, "a 404 OR an empty list re-resolves");
  assert.match(ROUTE, /topPoolAddress\(network, address\)/, "…to the pool GT does know");
  assert.match(ROUTE, /deeper\.length > 0 \|\| candles == null/, "and a worse answer there never replaces a good one");
});

test("⚠️ every answer names the BUILD that produced it", () => {
  // A chart that fails and a chart whose fix was never deployed look identical
  // from outside. Working that out cost a round trip on this endpoint: the
  // server had merged a stale remote ref, so the old code answered and nothing
  // said so. The stamp is the cheapest possible tell, and /api/token-preview
  // already carries it for the same reason.
  assert.match(ROUTE, /build: string;/, "it is part of the response shape, not a debug flag");
  assert.match(ROUTE, /process\.env\.NEXT_PUBLIC_BUILD/);
  const responses = (ROUTE.match(/\{ ok: (?:true|false), /g) ?? []).length;
  const stamped = (ROUTE.match(/build: BUILD/g) ?? []).length;
  assert.equal(stamped, responses + 1, "every hand-built response, plus fail() — an unstamped one is the one you would be reading");
});

test("⚠️ the reason an upstream gave is never dropped on the way to the panel", () => {
  // The first live failure on the server answered a bare "Couldn't read the
  // chart just now." — the pool lookup throws a plain Error, so the branch that
  // only unwrapped `Unreadable` threw the reason away. Rate-limited, 404'd and
  // unreachable are three different problems, and that was one shrug for all.
  assert.match(ROUTE, /readWhy\(err\)/);
  assert.ok(!/: "Couldn't read the chart just now\."/.test(ROUTE), "no reasonless branch left");
});

test("'no pool yet' and 'we could not read it' stay different answers", () => {
  // An empty grid gives the reader the same reaction to both.
  assert.match(ROUTE, /No pool indexed for this token yet/);
  assert.match(ROUTE, /Couldn't read the chart just now/);
  assert.match(CHART, /status === "error" \? "Chart unavailable right now" : "No candles yet"/);
});

test("⚠️ an unknown chain is refused BEFORE the cache key is built", () => {
  // The key is `ohlcv:<chain>:…` and the cache lives as long as the process:
  // an unvalidated chain is an unbounded set of keys anybody can create from a
  // query string, for answers nobody could use.
  const handler = code(ROUTE.slice(ROUTE.indexOf("export async function GET")));
  const guard = handler.indexOf("if (!network)");
  const key = handler.indexOf("`ohlcv:");
  assert.ok(guard > 0 && key > guard, "the chain check comes first");
});

test("the panel never renders a blank box", () => {
  // status "ok" with no geometry yet drew NOTHING — no chart, no message —
  // which reads exactly like a chart still loading, for ever.
  assert.match(CHART, /status === "ok" && !geo && !tooSmall/);
  assert.match(CHART, /Not enough room here to draw the chart/);
  // …and the measurement no longer depends on ResizeObserver existing.
  assert.match(CHART, /measure\(\);/);
});

test("the address and pool that go into an upstream path are bounded", () => {
  assert.match(ROUTE, /safeAddress\(address\)/);
  assert.match(ROUTE, /safeAddress\(hint\)/);
  assert.match(GTPOOL, /a\.length <= 90 && !\/\[\^A-Za-z0-9:_-\]\/\.test\(a\)/);
});

test("one owner answers 'which pool do we chart?'", () => {
  // Two copies of that lookup drift into two plausible-looking pool addresses
  // with nothing to say which is right.
  assert.match(POOL, /topPoolAddress/);
  assert.match(ROUTE, /topPoolAddress/);
  assert.ok(!/api\.geckoterminal\.com/.test(POOL), "the route no longer holds its own copy");
});

test("the pool we chart is the DEEPEST, not whichever GT listed first", () => {
  // A token seen through a thin pool reads as a different asset.
  assert.match(GTPOOL, /reduce\(\(best, p\) =>/);
  assert.match(GTPOOL, /reserve_in_usd/);
});

// ── the panel ───────────────────────────────────────────────────────────────

test("⚠️ the token page draws no fabricated price history", () => {
  // syntheticTrend() is a curve generated from the ticker's hash. On a 34px
  // sparkline it is decoration; at 640×120 under the words "Price trend" it is
  // a claim about a market nobody measured.
  assert.ok(!/pathFrom\(t\.trend/.test(PAGE), "the hash-generated area chart is gone");
  assert.ok(!/<iframe/.test(PAGE), "and so is the third-party embed");
  assert.match(PAGE, /<CandleChart/);
});

test("the chart is candles, with volume, on a timeframe the reader picks", () => {
  assert.match(CHART, /ck-wick/);
  assert.match(CHART, /ck-body/);
  assert.match(CHART, /ck-vol/);
  assert.match(CHART, /TIMEFRAMES\.map/);
  assert.match(CHART, /role="tab"/);
});

test("a poll that fails never blanks a chart that is already drawn", () => {
  // A quiet poll that comes back empty/failed short-circuits while candles are
  // on screen — it no longer re-renders, it just reports the status upward.
  assert.match(CHART, /if \(quiet && drawn > 0\) return "ok";/);
  assert.match(CHART, /pollMsFor\(tf\)/, "a settled chart never polls faster than the answer can change");
});

test("⚠️ a transient cooldown recovers on screen, without hammering GeckoTerminal", () => {
  // The chart failure the operator saw was "cooling down for 1s" — the tail of
  // a 120s rate-limit window. A request made while the cooldown holds returns
  // WITHOUT reaching GT (providers/gt), so a quick client re-poll is free
  // upstream and lets the chart draw itself the moment the window clears,
  // instead of waiting out the slow 30–90s poll.
  assert.match(CHART, /st === "error" && recovering < RECOVER_MAX/, "only the transient state is fast-retried");
  assert.match(CHART, /RECOVER_MAX = 8/, "and it is bounded — a truly unreachable box falls back to the slow poll");
  // "none" (no pool indexed) is a real answer, never fast-retried.
  assert.ok(!/st === "none"[^;]*RECOVER/.test(CHART));
});

test("every drawn number is measured over the window that is actually drawn", () => {
  // A percentage taken over candles that were never drawn is a figure the
  // reader cannot check against the chart it sits on.
  assert.match(CHART, /const view = geo\?\.view \?\? \[\]/);
  assert.match(CHART, /windowChangePct\(view\)/);
  assert.match(CHART, /geo\.view\.map/);
});

test("⚠️ the time-axis anchor is the renderer's, and CSS does not override it", () => {
  // A CSS declaration beats an SVG presentation attribute, so `text-anchor` in
  // the stylesheet silently overrode the per-label anchor that keeps the end
  // stamps inside the plot — and the left-most label shipped as "3:46" for
  // 23:46, a WRONG time rather than a clipped one.
  assert.match(CHART, /textAnchor=\{anchor\}/);
  const ck = CSS.slice(CSS.indexOf("CANDLESTICK CHART"), CSS.indexOf("GENERAL TIDY-UPS"));
  assert.ok(!/\.ck-axis-x\{[^}]*text-anchor/.test(ck), "no text-anchor in the chart's stylesheet");
});
