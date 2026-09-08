// The listing form asked a project to type its own name, ticker, logo and
// socials by hand for a token whose contract publishes all four — because the
// autofill's three sources all index POOLS or ask an unverified HTTP host, and
// a token on a bonding curve has no pool.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-pons-"));

const test = require("node:test");
const assert = require("node:assert");
const pons = require("../src/ponsChain");

const LAUNCH = {
  address: "0x1bf09442710ab41d311aaf53e2fa93992d5204a4",
  symbol: "DRIP",
  name: "Drip Potato",
  logo: "ipfs://bafybeie7kgu2jfpwkwbdz26a7ahptlr45hg5g36sg5d6gngwllfb3mezz4",
  description: "A potato that drips. Community-run, fixed supply, locked at graduation.",
  phase: "NotGraduated",
  graduated: false,
  progressPct: 12.5,
  priceUsd: 0.000058,
  mcapUsd: 58000,
  ponsUrl: "https://ponsfamily.com/token/0x1bf09442710ab41d311aaf53e2fa93992d5204a4",
  socials: { twitter: "ponsdotfamily", telegram: "https://t.me/ponsy", discord: null, website: "https://ponsy.example", farcaster: null },
};

const withFetch = async (impl, fn) => {
  const previous = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = previous; }
};
const answer = (body, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });

test("a curve token autofills from the chain", async () => {
  pons._reset();
  const info = await withFetch(() => answer({ launch: LAUNCH }), () =>
    pons.fetchTokenInfo("robinhood", LAUNCH.address));
  assert.ok(info, "expected a record");
  assert.strictEqual(info.name, "Drip Potato");
  assert.strictEqual(info.symbol, "DRIP");
  assert.strictEqual(info.onCurve, true);
  assert.strictEqual(info.progressPct, 12.5);
  assert.strictEqual(info.launchpad, "Pons");
  assert.strictEqual(info.source, "pons-chain");
});

test("a bare handle becomes a URL and a full one is kept", async () => {
  pons._reset();
  const info = await withFetch(() => answer({ launch: LAUNCH }), () =>
    pons.fetchTokenInfo("robinhood", LAUNCH.address));
  assert.strictEqual(info.twitter, "https://x.com/ponsdotfamily");
  assert.strictEqual(info.telegram, "https://t.me/ponsy");
  assert.strictEqual(info.website, "https://ponsy.example");
});

// An ipfs:// logo is real artwork and an unusable URL: adminValidate takes
// https or an upload and nothing else, so passing it through verbatim fails the
// WHOLE listing over its picture.
test("an ipfs logo is rewritten, never passed through", () => {
  const out = pons.httpsLogo("ipfs://bafyabc");
  assert.ok(out.startsWith("https://"), out);
  assert.ok(out.endsWith("/bafyabc"), out);
  assert.strictEqual(pons.httpsLogo("ipfs://ipfs/bafyabc"), pons.httpsLogo("ipfs://bafyabc"));
  assert.strictEqual(pons.httpsLogo("https://cdn.example/a.png"), "https://cdn.example/a.png");
  assert.strictEqual(pons.httpsLogo(""), null);
  assert.strictEqual(pons.httpsLogo("javascript:alert(1)"), null);
});

// The gates read these three by name and treat 0 as "no data". A curve has no
// pool, so anything else here would auto-list a token nobody has priced.
test("the fields the auto-lister gates read stay 0", () => {
  const info = pons.toInfo(LAUNCH);
  assert.strictEqual(info.liq, 0);
  assert.strictEqual(info.vol24, 0);
  assert.strictEqual(info.pairCreatedAt, 0);
});

test("a graduated launch is not on a curve", () => {
  const info = pons.toInfo({ ...LAUNCH, phase: "PoolCreated", graduated: true });
  assert.strictEqual(info.onCurve, false);
  assert.strictEqual(info.graduated, true);
});

// "Pons never launched this token" and "we could not ask" are different facts,
// and only the first may be recorded against the address.
test("404 is an answer; a dead site is not", async () => {
  pons._reset();
  const missing = await withFetch(() => answer({}, 404), () =>
    pons.fetchTokenInfoX("robinhood", LAUNCH.address));
  assert.strictEqual(missing.ok, true);
  assert.strictEqual(missing.info, null);

  pons._reset();
  const down = await withFetch(() => Promise.reject(new Error("ECONNREFUSED")), () =>
    pons.fetchTokenInfoX("robinhood", LAUNCH.address));
  assert.strictEqual(down.ok, false);
  assert.match(down.why, /could not reach/);
});

// A site that is down must cost ONE attempt, not one per paste.
test("a failure parks the reader", async () => {
  pons._reset();
  let calls = 0;
  await withFetch(() => { calls++; return Promise.reject(new Error("ECONNREFUSED")); }, async () => {
    await pons.fetchTokenInfoX("robinhood", LAUNCH.address);
    await pons.fetchTokenInfoX("robinhood", LAUNCH.address);
  });
  assert.strictEqual(calls, 1, "the second lookup must not reach the network");
  pons._reset();
});

// A chain the pad does not declare is never asked — read from the registry,
// never from a second hardcoded list.
test("only the chains the Pons pad declares are read", async () => {
  pons._reset();
  let calls = 0;
  const out = await withFetch(() => { calls++; return answer({ launch: LAUNCH }); }, () =>
    pons.fetchTokenInfoX("solana", "So11111111111111111111111111111111111111112"));
  assert.strictEqual(calls, 0);
  assert.strictEqual(out.info, null);
  assert.strictEqual(out.ok, true);
  assert.ok(pons.covers("robinhood"), "robinhood is where the Pons pad lives");
});
