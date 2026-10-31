// The web app's PORT of shared/dexscreener/pair.js, held to the original.
//
// "bot tidak bisa baca ca token" (2026-10-30) was fixed in both bots through
// one shared module; dexvra.io's search box had the same blind spot and carries
// a TypeScript copy (lib/dsPairLink.ts says why). A port is a second owner, and
// two owners of one rule eventually disagree — so the original is LOADED here
// and every fixture must get the same answer from both. A drift fails the build.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseDsLink, pickPair, sameAddress, dsQuery, LINK_RE, SEARCH_RE } from "./dsPairLink.ts";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "../..");
const shared = require(path.join(ROOT, "shared/dexscreener/pair.js"));

const PAIR = "0x20da3ebe08379117fdb7f15ff55456813b546554"; // the reported URL's address
const TOKEN = "0x9aB1c2D3e4F5a6B7c8D9e0F1a2B3c4D5e6F7a8B9";
const SOL_POOL = "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm";

const LINKS = [
  `https://dexscreener.com/bsc/${PAIR}`,
  `dexscreener.com/bsc/${PAIR}`,
  `https://www.dexscreener.com/solana/${SOL_POOL}?maker=x`,
  `https://dexscreener.com/search?q=${PAIR}`,
  `https://dexscreener.com/new-pairs/bsc`,
  `look at https://dexscreener.com/bsc/${PAIR}`,
  `https://dexscreener.com/bsc/${PAIR} gm`,
  `https://example.com/bsc/${PAIR}`,
  PAIR,
  "",
  "gm",
];

test("parseDsLink answers exactly what the shared module answers", () => {
  for (const l of LINKS) assert.deepEqual(parseDsLink(l), shared.parseLink(l), `diverged on ${JSON.stringify(l)}`);
});

test("the two link patterns are the same pattern", () => {
  // Behaviour is the real test above; this catches a drift the fixtures do not
  // happen to exercise. The original keeps them as private consts, so its
  // source is read rather than its exports.
  const src = fs.readFileSync(path.join(ROOT, "shared/dexscreener/pair.js"), "utf8");
  const seg = /const ADDR_SEG = '([^']+)';/.exec(src);
  assert.ok(seg, "the shared module no longer declares ADDR_SEG — this guard can see nothing");
  assert.ok(LINK_RE.source.includes(seg[1].replace(/\\\\/g, "\\")), "LINK_RE's address segment drifted");
  assert.ok(SEARCH_RE.source.includes(seg[1].replace(/\\\\/g, "\\")), "SEARCH_RE's address segment drifted");
});

test("sameAddress folds EVM hex only — a base58 pool lowercased is another account", () => {
  const cases: [string, string][] = [
    [PAIR, PAIR.toUpperCase().replace("0X", "0x")],
    [SOL_POOL, SOL_POOL.toLowerCase()],
    [SOL_POOL, SOL_POOL],
    ["", PAIR],
  ];
  for (const [a, b] of cases) assert.equal(sameAddress(a, b), shared.sameAddress(a, b), `diverged on ${a} / ${b}`);
  assert.equal(sameAddress(SOL_POOL, SOL_POOL.toLowerCase()), false);
});

test("pickPair takes the EXACT pair, deepest first — never the first pair in the answer", () => {
  const rec = (pairAddress: string, base: string, liq: number) => ({ chainId: "bsc", pairAddress, baseToken: { address: base }, liquidity: { usd: liq } });
  const bodies = [
    { pairs: [rec("0x" + "1".repeat(40), "0xother", 9e9), rec(PAIR, TOKEN, 5)] },
    { pairs: [rec(PAIR, TOKEN, 5), rec(PAIR.toUpperCase().replace("0X", "0x"), "0xdeeper", 50)] },
    { pair: rec(PAIR, TOKEN, 1) },
    { pairs: null },
    { pairs: [rec(PAIR, "", 5)] },
  ];
  for (const b of bodies) assert.deepEqual(pickPair(b, PAIR), shared.pickPair(b, PAIR), `diverged on ${JSON.stringify(b)}`);
  assert.equal(pickPair(bodies[0], PAIR)?.baseToken?.address, TOKEN, "a richer stranger's pair answered for ours");
  assert.equal(pickPair(bodies[1], PAIR)?.baseToken?.address, "0xdeeper");
});

test("dsQuery lowercases EVM hex only, exactly as the shared resolver builds its URL", () => {
  assert.equal(dsQuery("0xABCDEFabcdef0123456789012345678901234567"), "0xabcdefabcdef0123456789012345678901234567");
  assert.equal(dsQuery(SOL_POOL), SOL_POOL);
  const src = fs.readFileSync(path.join(ROOT, "shared/dexscreener/pair.js"), "utf8");
  assert.match(src, /\/\^0x\[0-9a-f\]\+\$\/i\.test\(addr\) \? addr\.toLowerCase\(\) : addr/, "the shared resolver changed how it keys an address");
});

// ── the route and the two screens ─────────────────────────────────────────────
// The route imports through "@/" aliases this runner cannot resolve, so the
// wiring is asserted on the comment-stripped source.

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const ROUTE = strip(fs.readFileSync(path.join(ROOT, "src/app/api/token-preview/route.ts"), "utf8"));
const TOPBAR = strip(fs.readFileSync(path.join(ROOT, "src/components/Topbar.tsx"), "utf8"));
const UNLISTED = strip(fs.readFileSync(path.join(ROOT, "src/components/UnlistedToken.tsx"), "utf8"));

test("the route reads a pasted link, and asks for a PAIR before spending GeckoTerminal on it", () => {
  assert.match(ROUTE, /const link = parseDsLink\(typed\)/, "a pasted link is not read");
  assert.match(ROUTE, /\/latest\/dex\/pairs\/\$\{slug\}\//, "the documented pair endpoint is never asked");
  const find = ROUTE.slice(ROUTE.indexOf("async function findAnyChain("), ROUTE.indexOf("export async function GET("));
  const pairAt = find.indexOf("fromDsPair(");
  const gtAt = find.indexOf("searchNetwork(");
  assert.ok(pairAt > 0 && gtAt > 0 && pairAt < gtAt, "a pair costs a GeckoTerminal search before it is recognised");
  // The chain-scoped path (the token page) asks too.
  assert.match(ROUTE, /fromDsPair\(address, \[chain\]\)/, "the token page reached with a pool in its URL never learns it is one");
});

test("'could not ask' is never cached as 'not a pair'", () => {
  const fn = ROUTE.slice(ROUTE.indexOf("async function fromDsPair("), ROUTE.indexOf("const candidateChains"));
  assert.ok(fn.length > 200, "fromDsPair is gone — this guard can see nothing");
  assert.match(fn, /if \(answers\.some\(\(a\) => !a\.ok\)\) throw new Error\(/, "a refusal resolves to null — cached() would store it as a fact about the address");
  assert.match(fn, /ok: r\.status === 404/, "a 404 must stay an ANSWER");
});

test("the search row opens the TOKEN the lookup returned; the token page leaves a pool for its token", () => {
  assert.match(TOPBAR, /parseDsLink\(homeQuery\) !== null/, "a pasted DexScreener link is not looked up at all");
  assert.match(TOPBAR, /encodeURIComponent\(probe\.address\)/);
  assert.match(UNLISTED, /if \(j\?\.pair && typeof j\.address === "string" && j\.address && j\.address !== address\)/);
  assert.match(UNLISTED, /router\.replace\(/, "a push would let Back land on the pool page again");
});
