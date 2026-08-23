// The wiring between the three logo pieces, and the proxy that serves what they
// find. These are source guards — weaker than driving the code, and used here
// because the pipeline module imports "@/"-aliased Next modules the test runner
// cannot resolve. Each one pins a defect that has actually happened.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAINS } from "../config/chains.ts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PIPELINE = read("src/lib/providers/index.ts");
const PROXY = read("src/app/api/logo/route.ts");
const COIN = read("src/components/Coin.tsx");
/** Comments quote the defect they guard against, so a scan for a banned line
 *  has to read the CODE. Without this the proxy's own warning about
 *  `redirect: "follow"` fails the test that forbids it. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("⚠️ the board no longer merges logos with `t.logoUrl ?? m.logoUrl`", () => {
  // That line could never reach its second operand: rowToBoardToken fills
  // logoUrl with the CDN convention, which is non-null on every DexScreener
  // chain — so a constructed path outranked the real image_url both indexes
  // were handing us, and the row drew a monogram.
  assert.ok(!/logoUrl: t\.logoUrl \?\? m\.logoUrl/.test(PIPELINE), "the inverted ladder is gone");
  assert.match(PIPELINE, /pickLogo\(\{/, "one owner decides which logo a row renders");
  assert.equal(PIPELINE.match(/pickLogo\(/g)?.length, 1, "called in exactly one place — no second ladder");
});

test("the ladder reads the STORED row, not the board token's filled-in guess", () => {
  assert.match(PIPELINE, /stored: row\?\.logoUrl/);
  assert.match(PIPELINE, /live: m\?\.logoUrl/);
  assert.match(PIPELINE, /resolved: knownLogo\(/);
});

test("a row with nothing but the convention is queued for the resolver", () => {
  assert.match(PIPELINE, /logo\.kind === "convention" \|\| logo\.kind === "none"/);
  assert.match(PIPELINE, /shouldLookUp\(/, "and only when it is worth spending a lookup on");
});

test("what the sweep finds is persisted, or it dies with the process", () => {
  assert.match(PIPELINE, /backfillLogos\(/);
  assert.match(PIPELINE, /persist: setResolvedLogo/);
});

test("the sweep is never awaited by a board render", () => {
  // Resolving means three rate-limited APIs and a verification fetch. The
  // render must not be behind that — backfillLogos returns immediately.
  assert.ok(!/await backfillLogos/.test(PIPELINE), "a board render must not wait on a logo lookup");
});

test("every chain declares a CoinGecko platform, or explicitly declares it has none", () => {
  // Same rule as the DexScreener id: nothing outside the registry may hardcode
  // a chain id, and a new chain must decide rather than inherit undefined.
  for (const c of Object.values(CHAINS)) {
    assert.ok("coingecko" in c, `${c.id} must declare a coingecko platform (null if unsupported)`);
    assert.ok(c.coingecko === null || typeof c.coingecko === "string");
  }
  assert.equal(CHAINS.robinhood.coingecko, null, "CoinGecko has no platform for Robinhood Chain");
  assert.equal(CHAINS.bsc.coingecko, "binance-smart-chain", "its id differs from ours and from DexScreener's");
});

// ── the proxy ───────────────────────────────────────────────────────────────

test("the proxy carries the hosts token artwork actually lives on", () => {
  // A host missing from the allowlist is a real, working logo url rendered as a
  // monogram — refused by us, silently, with nothing in the UI to say so.
  for (const host of ["mypinata.cloud", "nftstorage.link", "dweb.link", "arweave.net", "trustwallet.com", "jup.ag"])
    assert.match(PROXY, new RegExp(`"${host.replace(".", "\\.")}"`), `${host} must be allowed`);
});

test("an ipfs:// URI is turned into a gateway URL rather than refused", () => {
  assert.match(PROXY, /ipfs:\\\/\\\//);
  assert.match(PROXY, /IPFS_GATEWAY/);
});

test("⚠️ redirects are followed BY HAND and re-checked against the allowlist", () => {
  // `redirect: "follow"` hands the guard's whole job to the upstream: an
  // allowed host answering `302 http://169.254.169.254/…` would have this
  // server fetch its own cloud metadata and serve the bytes back.
  assert.match(PROXY, /redirect: "manual"/);
  assert.ok(!/redirect: "follow"/.test(code(PROXY)), "no follow left anywhere in the proxy");
  const loop = PROXY.slice(PROXY.indexOf("for (let hop"));
  assert.match(loop.slice(0, 600), /if \(!next \|\| !allowed\(next\)\)/, "every hop is validated");
});

test("only https, only images, and an SVG is served inert", () => {
  assert.match(PROXY, /u\.protocol !== "https:"/);
  assert.match(PROXY, /\^image\\\//);
  // An SVG is a DOCUMENT when opened directly, and one served from our own
  // origin can carry script. Refusing SVGs would drop real logos.
  assert.match(PROXY, /x-content-type-options/);
  assert.match(PROXY, /content-security-policy/);
});

test("a logo that cannot be served still renders as the monogram, never a broken tile", () => {
  assert.match(PROXY, /status: 404/, "a miss is a 404, which is what <Coin> listens for");
  assert.match(COIN, /onError=\{\(\) => setBroken\(true\)\}/);
  assert.match(COIN, /coin-mono/);
});
