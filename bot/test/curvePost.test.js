// "mengapa ketika listing price mc tba pdahal sudah ada price dan mc" — a paid
// Xpress listing for $WROTE (Wallet Route, Robinhood Chain) went out reading
// "Market cap: TBA · Price: TBA" while ponsfamily.com showed $0.000004 on a
// $4,494.71 cap in the same minute.
//
// The round before had already made the post's market read DexScreener-first,
// and that fixed a different cause. This token is 1% along a PONS BONDING
// CURVE: it has no pool at all, so neither indexer can price it however cheaply
// they are asked, and the launchpad leg below them asks Pons over HTTP on a
// host and a path this repo has never verified — the operator's own
// `launchpads:check` reports it unreachable.
//
// The one source that cannot be unreachable is the curve contract, and it was
// wired into the LISTING FORM (`discovery.fetchTokenInfoX`) and nowhere else —
// so the form autofilled a name and a ticker off the chain and the post
// announcing that very token printed TBA on both figures.
//
// ⚠️ THESE ARE POSITIVE TESTS. A wiring that does nothing refuses beautifully:
// a suite that only drove the failure cases would pass on the unwired code.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-curvepost-"));

const test = require("node:test");
const assert = require("node:assert");
const market = require("../src/marketdata");
const ponsChain = require("../src/ponsChain");

const WROTE = "0xfCd4CdEabe055315b1036A189eA54ca627Df390a";

/** What /api/pons answers for a live Pons curve — the shape the route returns. */
const LAUNCH = {
  launch: {
    address: WROTE,
    name: "Wallet Route",
    symbol: "WROTE",
    phase: "NotGraduated",
    graduated: false,
    logo: "ipfs://bafkreiwalletroute",
    priceUsd: 0.000004,
    mcapUsd: 4494.71,
    progressPct: 1,
    socials: {},
  },
};

/**
 * Classify every request by WHO is being asked, so a test can assert that a
 * source was reached — or that it never was.
 *
 * Anything that is not one of the three known hosts is a launchpad's own HTTP
 * API, and it FAILS: that is the operator's box, where the Pons pad's guessed
 * host is unreachable, and it is the state the chain leg exists for.
 */
function stubFetch(router) {
  const orig = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    const u = String(url);
    const who = u.includes("/api/pons")
      ? "chain"
      : u.includes("geckoterminal")
        ? "gt"
        : u.includes("dexscreener")
          ? "ds"
          : "pad";
    asked.push(who);
    const body = router(who, u);
    if (body === undefined) throw new Error("ENOTFOUND (the pad host is a guess)");
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { asked, restore: () => (global.fetch = orig) };
}

const POST_NEED = ["priceUsd", "mcap", "liq"];
const cheap = { cheap: true, need: POST_NEED };

test.beforeEach(() => ponsChain._reset());

test("a bonding-curve token is PRICED FROM THE CHAIN when no indexer and no pad can", async () => {
  const { asked, restore } = stubFetch((who) => (who === "chain" ? LAUNCH : who === "pad" ? undefined : null));
  try {
    const m = await market.fetchMarket("robinhood", WROTE, cheap);
    assert.ok(m, "the read must not come back null — this is the TBA that shipped");
    assert.strictEqual(m.priceUsd, 0.000004, "the price the pad's own page shows");
    assert.strictEqual(m.mcap, 4494.71, "the market cap the pad's own page shows");
    assert.ok(asked.includes("chain"), `the contract must be asked: ${asked.join(", ")}`);
  } finally {
    restore();
  }
});

test("…and the curve's state travels with it, so the card can say it is still bonding", async () => {
  const { restore } = stubFetch((who) => (who === "chain" ? LAUNCH : who === "pad" ? undefined : null));
  try {
    const m = await market.fetchMarket("robinhood", WROTE, cheap);
    assert.strictEqual(m.onCurve, true);
    assert.strictEqual(m.progressPct, 1);
    // ⚠️ No pool is the whole point. Inventing one here would send a chart link
    // somewhere that 404s.
    assert.strictEqual(m.poolAddress, null);
  } finally {
    restore();
  }
});

test("⚠️ an indexed token pays ONE chain request EVER, then none", async () => {
  // The concurrency above is not free and this is the price, bounded.
  //
  // The read is started alongside the indexers because read serially it is
  // fourth in a queue inside the post's 8s ceiling and would never get asked —
  // so an indexed Robinhood token now spends one localhost request whose answer
  // is thrown away. What keeps that from being a per-poll cost across nine
  // background pipelines is the memo: `fetchPonsLaunch` resolves BY ADDRESS off
  // the factory, so "Pons never launched this" is permanent, and every
  // subsequent read short-circuits with no request at all.
  const ds = {
    pairs: [
      {
        chainId: "robinhood",
        priceUsd: "1.5",
        marketCap: 1000,
        liquidity: { usd: 2000 },
        volume: { h24: 10 },
        priceChange: { h24: 1 },
        pairAddress: "0xpair",
        baseToken: { name: "Graduated", symbol: "GRAD" },
      },
    ],
  };
  const { asked, restore } = stubFetch((who) => (who === "ds" ? ds : null));
  try {
    const first = await market.fetchMarket("robinhood", "0xdead", cheap);
    assert.strictEqual(first.priceUsd, 1.5, "the indexer prices it, as it always did");
    assert.strictEqual(asked.filter((w) => w === "chain").length, 1, "one, concurrently");

    const before = asked.length;
    const again = await market.fetchMarket("robinhood", "0xdead", cheap);
    assert.strictEqual(again.priceUsd, 1.5);
    assert.ok(
      !asked.slice(before).includes("chain"),
      `the second read must not ask again: ${asked.slice(before).join(", ")}`,
    );
  } finally {
    restore();
  }
});

test("⚠️ a read that FAILED is never memoed as 'Pons never launched this'", async () => {
  // The fail-safe direction, and the one that matters: writing a transport
  // failure into the memo would mark a live curve as "never launched" for the
  // life of the process — this section's own TBA, made permanent, and immune to
  // the park expiring because the memo is checked above it.
  //
  // ⚠️ IT IS ASSERTED ON THE ANSWER, NOT BY DRIVING TWICE AND LOOKING AT THE
  // REQUEST COUNT. The first cut called `_reset()` between the two calls — which
  // clears the memo, i.e. exactly the thing under test — so memoing the failure
  // survived the mutation run untouched. A park and a memo both suppress the
  // second request; only `{ok, why}` tells them apart, and that distinction is
  // the whole rule: ok:false is "we could not ask", ok:true is a fact about the
  // token.
  const { restore } = stubFetch((who) => (who === "chain" ? undefined : null));
  try {
    const first = await ponsChain.fetchTokenInfoX("robinhood", WROTE);
    assert.strictEqual(first.ok, false, "a transport failure is not an answer");
  } finally {
    restore();
  }

  const second = await ponsChain.fetchTokenInfoX("robinhood", WROTE);
  assert.strictEqual(second.ok, false, "still 'we could not ask' — parked, never memoed");
  assert.match(second.why, /parked/, `a failure must not become a verdict: ${second.why}`);
});

test("…and a real 'not a Pons launch' IS remembered, with no second request", async () => {
  // The other half, and the reason the concurrent read is affordable at all.
  const { asked, restore } = stubFetch(() => null);
  try {
    const first = await ponsChain.fetchTokenInfoX("robinhood", "0xgraduated");
    assert.strictEqual(first.ok, true, "the factory answered: it never launched this");
    const before = asked.length;
    const second = await ponsChain.fetchTokenInfoX("robinhood", "0xgraduated");
    assert.strictEqual(second.ok, true);
    assert.strictEqual(asked.length, before, "and it is never asked again");
  } finally {
    restore();
  }
});

test("⚠️ a LIVE POOL READING still beats the curve's copy of the same number", async () => {
  // The rule the rest of marketdata.js is built on: the chain leg FILLS HOLES
  // and may never overwrite an indexer that answered.
  //
  // ⚠️ THE FIXTURE HAS TO REACH THE MERGE. The first cut gave GeckoTerminal a
  // complete record — which closes the `!out.priceUsd || !out.mcap` gate above,
  // so the chain leg never ran and inverting the merge's precedence left this
  // test green. It was asserting the GATE while claiming to assert the RULE.
  // A partial indexer answer is the only shape that opens the gate with a
  // reading already in hand: GT prices it, nobody publishes a cap, and the
  // chain has both.
  const gt = {
    data: {
      attributes: { price_usd: "9.99", market_cap_usd: null, total_reserve_in_usd: "500" },
      relationships: {},
    },
    included: [],
  };
  const { asked, restore } = stubFetch((who) =>
    who === "gt" ? gt : who === "chain" ? LAUNCH : who === "pad" ? undefined : null,
  );
  try {
    const m = await market.fetchMarket("robinhood", WROTE, cheap);
    assert.ok(asked.includes("chain"), "precondition: the gate opened and the chain WAS asked");
    assert.strictEqual(m.priceUsd, 9.99, "the pool reading wins — not the curve's 0.000004");
    assert.strictEqual(m.mcap, 4494.71, "…and the hole it left is filled from the curve");
  } finally {
    restore();
  }
});

test("a chain that Pons does not cover is never asked at all", async () => {
  const { asked, restore } = stubFetch(() => null);
  try {
    await market.fetchMarket("bsc", "0xabc", cheap);
    assert.ok(!asked.includes("chain"), `solana/bsc must not reach /api/pons: ${asked.join(", ")}`);
  } finally {
    restore();
  }
});

test('"Pons never launched this token" costs nothing and is not an error', async () => {
  // A 404 from the route is an ANSWER about the token — the graduated-long-ago
  // case — and must leave the record exactly as the indexers left it.
  const { restore } = stubFetch((who) => (who === "pad" ? undefined : null));
  try {
    const m = await market.fetchMarket("robinhood", "0xnotpons", cheap);
    assert.strictEqual(m, null, "no source had it, and nothing was invented");
  } finally {
    restore();
  }
});
