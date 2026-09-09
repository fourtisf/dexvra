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
const fulfil = require("../src/fulfillment");

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

// ── THE GECKOTERMINAL STAGE MAY NOT EAT THE WHOLE BUDGET ─────────────────────
//
// `$GG`, a pump.fun Solana token, published `price · market cap · liquidity as
// TBA` on a box where pump.fun answers fine and the pad is `verified: true`.
// DexScreener misses a bonding curve, the GT read then queues on
// gtSlot(PRIO_BACKGROUND) — which has NO DEADLINE OF ITS OWN — and it spent the
// caller's entire 8s, so `fillFromLaunchpad` two lines below was never reached.
//
// The chain leg was fixed for exactly this one round earlier. The pad leg one
// line above it was left serial: a lesson applied to one branch is a lesson
// half-learnt.

// ⚠️ A REAL MINT, NOT A LABEL. The first cut used `"GGmint"`, and the launchpad
// registry refuses an address that cannot be a Solana mint before it makes any
// request — so the test reported the pad as never asked while the code was
// working perfectly. A test measuring its own fake, which is why this is the
// address off the operator's own screenshot.
const GG = "BzAtM6svpCCHxjH7ZzNqBiPSm2D2v7K257damascpump";

/** A pump.fun-shaped answer from the launchpad registry's HTTP pad. */
const PUMP = {
  mint: GG,
  name: "Green God",
  symbol: "GG",
  image_uri: "https://ipfs.io/ipfs/bafyGG",
  usd_market_cap: 61234,
  price_usd: 0.0000612,
  real_token_reserves: 500000000000000,
};

test("⚠️ a slow GT does not cost the LAUNCHPAD its turn", async () => {
  // ⚠️ DRIVEN THROUGH `_readPostMarket`, THE REAL CALLER, and that is what makes
  // this test mean anything. The first cut called `fetchMarket` directly and
  // only asserted the pad was EVENTUALLY asked — which is true of the broken
  // code too, because `fetchGT` has an 8s timeout of its own and the pad is
  // reached after it, just far too late. All three mutants survived. What the
  // post actually cares about is whether a price arrives INSIDE
  // MARKET_BUDGET_MS, so the bound has to be in the test.
  const orig = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("geckoterminal")) {
      asked.push("gt");
      // The reported state: the shared queue, never arriving inside the budget.
      //
      // ⚠️ UNREF'd, and that is the opposite of the rule `bounded` states — for
      // the opposite reason. Nothing is waiting on this once the caller's bound
      // fires, so a reffed timer just holds the file's event loop open for its
      // full duration after the test has passed. `node --test` waits for that,
      // and the suite pays it. The scar this file's own header names, pointing
      // the other way.
      await new Promise((r) => {
        const t = setTimeout(r, 30_000);
        if (typeof t.unref === "function") t.unref();
      });
      return { ok: false, status: 504, json: async () => ({}) };
    }
    if (u.includes("dexscreener")) {
      asked.push("ds");
      return { ok: true, status: 200, json: async () => ({ pairs: [] }) }; // no pair on a curve
    }
    if (u.includes("pump.fun")) {
      asked.push("pad");
      return { ok: true, status: 200, json: async () => PUMP };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const { live } = await fulfil._readPostMarket("solana", GG, "test");
    assert.ok(asked.includes("pad"), `the launchpad must be asked: ${asked.join(", ")}`);
    assert.ok(live, "the post must get a market — this is the TBA that shipped");
    assert.strictEqual(live.priceUsd, 0.0000612);
    assert.strictEqual(live.mcap, 61234);
  } finally {
    global.fetch = orig;
  }
});

test("…and a caller with NO budget still waits on GT exactly as it always did", async () => {
  // The nine background pipelines pass no budget and must keep their behaviour.
  // GT answers here at 5s — comfortably past the slice a post would impose, and
  // fine for a timer job — so a slice applied unconditionally would throw this
  // answer away and re-ask the pads on every poll of every listing.
  const orig = global.fetch;
  let gtAsked = false;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("geckoterminal")) {
      gtAsked = true;
      // Reffed on purpose: this one IS awaited to completion — the assertion
      // below is that GT's answer survives, so the answer has to arrive.
      await new Promise((r) => setTimeout(r, 5000));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            attributes: { price_usd: "3", market_cap_usd: "300", total_reserve_in_usd: "30" },
            relationships: {},
          },
          included: [],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const m = await market.fetchMarket("solana", GG, { cheap: true, need: POST_NEED });
    assert.ok(gtAsked);
    assert.ok(m, "an unbounded caller must still get GT's answer");
    assert.strictEqual(m.priceUsd, 3, "…and it is GT's, not a pad's");
  } finally {
    global.fetch = orig;
  }
});
