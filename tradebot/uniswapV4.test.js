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

test("the buy path routes v4 first, and names the venue when it cannot", () => {
  // The old message ("no pool? try again") told the user to retry a buy that
  // could never fill, however many times they pressed it.
  const i = CORE.indexOf("if (pick.kind === 'v2' && !pick.pair) {");
  assert.ok(i > -1, "the no-pair branch is still in the buy path");
  const body = CORE.slice(i, i + 2200);
  assert.match(body, /v4\.canSwap\(chainKey\)/, "a v4 pool is tried before giving up");
  assert.match(body, /v4\.simulate\(/, "and simulated before anything is signed");
  assert.match(body, /dsVenueLabel\(m\)/, "the venue is named when there is nothing to route");
  // The order matters: naming the venue is the FALLBACK, not the first answer.
  assert.ok(body.indexOf("v4.canSwap") < body.indexOf("dsVenueLabel"), "v4 is tried first");
});

test("routable is set on BOTH snapshot returns, not just the new one", () => {
  // A missing flag on the normal path reads as undefined, which is not === false
  // — so it would still trade, but the field would silently mean nothing.
  const rets = CORE.match(/routable: (true|false)/g) || [];
  assert.ok(rets.includes("routable: true") && rets.includes("routable: false"));
});

// ── Two indexers, and a failure card that says what it checked ───────────────

test("GeckoTerminal answers when DexScreener does not", async () => {
  // One indexer is a single point of failure the operator cannot see past:
  // DexScreener throttles datacenter IPs, and an empty response from a throttled
  // request is indistinguishable from "this token has no market".
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("dexscreener")) return { ok: true, json: async () => ({ pairs: [] }) };
    return { ok: true, json: async () => ({ data: [{
      attributes: { base_token_price_usd: "0.0042", reserve_in_usd: "310000", fdv_usd: "4200000", name: "SMPL / WETH" },
      relationships: { dex: { data: { id: "uniswap-v4" } } },
    }] }) };
  };
  try {
    core._clearReadCaches();
    const m = await core.marketOf(CA, "ethereum");
    assert.ok(m, "the second opinion found it");
    assert.strictEqual(core.dsVenueLabel(m), "Uniswap v4", "and names the venue whole");
    // The probe asks the chain the user is ON first, and stops there — one
    // request per paste instead of one per enabled chain, which is what got the
    // free index answering 429.
    const probe = await core.marketProbe(CA, "ethereum");
    assert.deepStrictEqual(probe.chains, ["ethereum"]);
    assert.strictEqual(probe.source, "geckoterminal");
    assert.strictEqual(probe.degraded, false);
  } finally { global.fetch = realFetch; }
});

test("the probe reports what it checked when nothing is found", async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => ({ ok: true, json: async () => (String(url).includes("dexscreener") ? { pairs: [] } : { data: [] }) });
  try {
    core._clearReadCaches();
    const probe = await core.marketProbe(CA);
    assert.deepStrictEqual(probe.chains, []);
    assert.ok(probe.checked.length > 1, "it names every chain it looked on");
    assert.strictEqual(probe.source, "none");
    assert.strictEqual(probe.degraded, false, "the indexes answered — they just had nothing");
  } finally { global.fetch = realFetch; }
});

test("an EVM address is lowercased for the indexers, a Solana mint is not", async () => {
  // A CA pasted from a block explorer is EIP-55 checksummed. Base58 is
  // case-SIGNIFICANT, so the same treatment would destroy a Solana mint.
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => { seen.push(String(url)); return { ok: true, json: async () => ({ pairs: [] }) }; };
  try {
    core._clearReadCaches();
    await core.dsMarket(CA, "ethereum");
    assert.ok(seen.some((u) => u.includes(CA.toLowerCase())), "checksummed EVM address went out lowercased");
    seen.length = 0;
    core._clearReadCaches();
    const mint = "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump";
    await core.dsMarket(mint, "solana");
    assert.ok(seen.some((u) => u.includes(mint)), "the base58 mint went out untouched");
  } finally { global.fetch = realFetch; }
});

test("the dead-end card points at the chain that has the market", () => {
  const i = TG.indexOf("const probe = await core.marketProbe(ca,");
  assert.ok(i > -1, "the failure path still probes for a market");
  const body = TG.slice(i, i + 2400);
  assert.match(body, /Open on \$\{c\.name\}/, "it offers to open the card on the right chain");
  assert.match(body, /tok:\$\{c\.key\}::\$\{ca\}/, "wired to the real card callback");
  assert.match(body, /DexScreener, GeckoTerminal/, "and names what it consulted when it finds nothing");
  assert.match(body, /probe\.degraded/, "a throttled index is not reported as 'no market'");
});

test("a throttled index is reported as 'nobody answered', not 'no market'", async () => {
  // A 429 and an empty result used to arrive identically, and the card then
  // stated as fact that the token trades nowhere — about a token it had priced
  // twenty minutes earlier. That is the difference between a fact and a guess.
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  try {
    core._clearReadCaches();
    const probe = await core.marketProbe(CA, "robinhood");
    assert.deepStrictEqual(probe.chains, []);
    assert.strictEqual(probe.degraded, true);
  } finally { global.fetch = realFetch; }
});

test("a throttled answer is never cached", async () => {
  // Caching one rate-limited second for 30s spreads it across every paste in
  // the next half minute.
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 429, json: async () => ({}) }; };
  try {
    core._clearReadCaches();
    await core.dsMarket(CA, "ethereum");
    await core.dsMarket(CA, "ethereum");
    assert.strictEqual(calls, 2, "it asked again rather than replaying the failure");
  } finally { global.fetch = realFetch; }
});
