// Tokens whose liquidity sits on a venue the engine cannot route through —
// Uniswap v4 above all.
//
// v4 keeps every pool inside ONE PoolManager singleton, keyed by a hash of the
// PoolKey. There is no pair contract and no per-pool contract, so V2's getPair
// and V3's getPool both come back empty and bestDexVenue finds nothing. The bot
// answered such a token with "❌ Couldn't price <ca> on <chain>. This usually
// means it hasn't got a pool yet… or it trades on another chain" — neither of
// which is true, and both of which read as a broken bot.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert");
const core = require("./core");

const CA = "0x10472b42E3b22A5B98D0820A55cc6Fd9034f4663";

/** A DexScreener response: one Uniswap v4 pool on Ethereum. */
function dsResponse(pairs) {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ pairs }) });
  return () => { global.fetch = realFetch; };
}

const V4_PAIR = {
  chainId: "ethereum",
  dexId: "uniswap",
  labels: ["v4"],
  priceUsd: "0.0042",
  marketCap: 4200000,
  liquidity: { usd: 310000 },
  volume: { h24: 88000 },
  baseToken: { name: "Sample Token", symbol: "SMPL" },
};

test("a Uniswap v4 market is found, and named as v4", async () => {
  const restore = dsResponse([V4_PAIR]);
  try {
    core._clearReadCaches();
    const m = await core.dsMarket(CA, "ethereum");
    assert.ok(m, "the market is visible to the indexer even with no pair contract");
    assert.strictEqual(m.priceUsd, 0.0042);
    assert.strictEqual(m.liqUsd, 310000);
    // DexScreener reports v4 as dexId "uniswap" + a "v4" LABEL. Reading only the
    // dexId would tell the user "Uniswap", which is a venue the bot DOES route
    // through — the exact wrong impression.
    assert.strictEqual(core.dsVenueLabel(m), "Uniswap v4");
  } finally { restore(); }
});

test("the deepest market decides which chain a pasted CA belongs to", async () => {
  const restore = dsResponse([
    { ...V4_PAIR, chainId: "base", liquidity: { usd: 10 } },
    { ...V4_PAIR, chainId: "ethereum", liquidity: { usd: 999999 } },
  ]);
  try {
    core._clearReadCaches();
    const chains = await core.dsChainsOf(CA);
    assert.strictEqual(chains[0], "ethereum", "deepest first");
    assert.ok(chains.includes("base"));
  } finally { restore(); }
});

test("a chain with no market on it is never returned", async () => {
  const restore = dsResponse([{ ...V4_PAIR, priceUsd: "0" }]);
  try {
    core._clearReadCaches();
    assert.deepStrictEqual(await core.dsChainsOf(CA), []);
    assert.strictEqual(await core.dsMarket(CA, "ethereum"), null);
  } finally { restore(); }
});

test("an indexer that is down changes nothing", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error("ENOTFOUND"); };
  try {
    core._clearReadCaches();
    assert.deepStrictEqual(await core.dsChainsOf(CA), []);
    assert.strictEqual(await core.dsMarket(CA, "ethereum"), null);
  } finally { global.fetch = realFetch; }
});

// ── The card and the buy path ────────────────────────────────────────────────
const TG = fs.readFileSync(path.join(__dirname, "telegram.js"), "utf8");
const CORE = fs.readFileSync(path.join(__dirname, "core.js"), "utf8");

test("an unroutable token gets a card with NO buy button", () => {
  // The whole point of the separate card: every Buy/Sell control on the normal
  // one would build a swap that cannot be filled. A trade screen that quotes a
  // price it can't honour is worse than one that says it can't.
  const start = TG.indexOf("function unroutableCard(");
  assert.ok(start > -1, "the unroutable card still exists");
  const body = TG.slice(start, TG.indexOf("\n}", start));
  assert.ok(!/\bbuy[:_]/i.test(body), "no buy callback is offered");
  assert.match(body, /extVenue/, "it names the venue it cannot route through");
  assert.match(body, /Chart/, "and still gives somewhere to go");
});

test("the card is reached before the buy controls are built", () => {
  const guard = TG.indexOf("if (info.routable === false) return unroutableCard(");
  const meta = TG.indexOf("const meta = await core.tokenMeta(ca, chainKey);");
  assert.ok(guard > -1 && meta > guard, "the guard sits ahead of the tradeable card");
});

test("the buy path names the venue instead of saying 'no pool? try again'", () => {
  // That message told the user to retry a buy that can never fill, however many
  // times they press it.
  const i = CORE.indexOf("if (pick.kind === 'v2' && !pick.pair) {");
  assert.ok(i > -1, "the unroutable-venue check is still in the buy path");
  assert.match(CORE.slice(i, i + 400), /dsVenueLabel\(m\)/);
});

test("routable is set on BOTH snapshot returns, not just the new one", () => {
  // A missing flag on the normal path reads as undefined, which is not === false
  // — so it would still trade, but the field would silently mean nothing.
  const rets = CORE.match(/routable: (true|false)/g) || [];
  assert.ok(rets.includes("routable: true") && rets.includes("routable: false"));
});
