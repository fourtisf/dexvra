// The on-chain sell check for chains no safety API covers ($NASDUCK was a
// Robinhood honeypot that passed because GoPlus does not cover Robinhood).
// Driven against a FAKE CHAIN: a pool, buyers out of it, and a token that
// either lets a holder sell back into the pool or reverts.
const test = require("node:test");
const assert = require("node:assert");
const sim = require("../src/services/sellSim");

const TOKEN = "0x78fc7e13bccab8a7aedc5b8465c3442d6d7d9d64";
const POOL = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const wallet = (i) => "0x" + String(i).padStart(4, "0").repeat(10);
const topic = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0");

/**
 * A chain. `buys` are [source, wallet] pairs, oldest first. `sell(holder, to)`
 * answers the simulated transfer: true → success, "false" → returns false,
 * anything else → a revert.
 */
function chain({ buys, sell, balance = () => 10n ** 21n, contracts = [POOL, ROUTER], logsError = null, calls = [] } = {}) {
  const contractSet = new Set(contracts.map((c) => c.toLowerCase()));
  return async (method, params) => {
    calls.push(method);
    if (method === "eth_blockNumber") return { result: "0x2710" };
    if (method === "eth_getLogs") {
      const f = params[0];
      const span = parseInt(f.toBlock, 16) - parseInt(f.fromBlock, 16) + 1;
      if (logsError && span > logsError) return { error: { code: -32005, message: "query returned more than 10000 results" } };
      return {
        result: buys.map(([src, dst], i) => ({ address: TOKEN, blockNumber: "0x" + (9000 + i).toString(16), topics: [sim.TRANSFER_TOPIC, topic(src), topic(dst), ] })),
      };
    }
    if (method === "eth_getCode") return { result: contractSet.has(params[0].toLowerCase()) ? "0x6080604052" : "0x" };
    if (method === "eth_call") {
      const { from, data } = params[0];
      if (data.startsWith("0x70a08231")) return { result: "0x" + balance("0x" + data.slice(-40)).toString(16).padStart(64, "0") };
      if (data.startsWith("0xa9059cbb")) {
        const to = "0x" + data.slice(10 + 24, 10 + 64);
        const v = sell(from.toLowerCase(), to);
        if (v === true) return { result: "0x" + "0".repeat(63) + "1" };
        if (v === "false") return { result: "0x" + "0".repeat(64) };
        return { error: { code: 3, message: "execution reverted: TRANSFER_FAILED" } };
      }
    }
    return { error: { code: -32601, message: `unexpected ${method}` } };
  };
}

const buysFromPool = [1, 2, 3, 4, 5].map((i) => [POOL, wallet(i)]);

test("the honeypot: every recent buyer's sell back into the pool reverts → sells:false", async () => {
  const r = await sim.sellCheckX("robinhood", TOKEN, { rpc: chain({ buys: buysFromPool, sell: () => "revert" }) });
  assert.equal(r.ok, true);
  assert.equal(r.sells, false);
  assert.equal(r.tried.length, sim.BUYERS);
  assert.match(r.why, /reverts for 3 of 3 recent buyers/);
});

test("control: a token whose holders CAN sell → sells:true", async () => {
  const r = await sim.sellCheckX("robinhood", TOKEN, { rpc: chain({ buys: buysFromPool, sell: () => true }) });
  assert.deepEqual([r.ok, r.sells], [true, true]);
});

test("the sell is simulated FROM the buyer TO the venue that sold it to them", async () => {
  const seen = [];
  await sim.sellCheckX("robinhood", TOKEN, { rpc: chain({ buys: buysFromPool, sell: (from, to) => (seen.push([from, to]), true) }) });
  assert.deepEqual(seen[0], [wallet(5), POOL], "newest buyer first, selling into the pool");
});

test("one buyer who can sell is enough — a per-wallet block is not a honeypot", async () => {
  const r = await sim.sellCheckX("robinhood", TOKEN, { rpc: chain({ buys: buysFromPool, sell: (from) => (from === wallet(4) ? true : "revert") }) });
  assert.equal(r.sells, true);
});

test("an ERC-20 that answers FALSE has refused the sell just the same", async () => {
  const r = await sim.sellCheckX("robinhood", TOKEN, { rpc: chain({ buys: buysFromPool, sell: () => "false" }) });
  assert.equal(r.sells, false);
});

test("a sell the NODE refused (rate limit, not a revert) is no proof of a honeypot", async () => {
  const base = chain({ buys: buysFromPool, sell: () => true });
  const rpc = async (method, params) =>
    method === "eth_call" && params[0].data.startsWith("0xa9059cbb")
      ? { error: { code: -32005, message: "rate limit exceeded" } }
      : base(method, params);
  const r = await sim.sellCheckX("robinhood", TOKEN, { rpc });
  assert.equal(r.ok, false, "the contract said nothing — inconclusive");
});

test("ONE reverting buyer is not proof — inconclusive, not a verdict", async () => {
  // A single wallet can be in a cooldown or individually blocked.
  const r = await sim.sellCheckX("robinhood", TOKEN, { rpc: chain({ buys: [[POOL, wallet(1)]], sell: () => "revert" }) });
  assert.equal(r.ok, false);
  assert.match(r.why, /only 1 buyer/);
});

test("no buyers found is inconclusive — never read as safe", async () => {
  const r = await sim.sellCheckX("robinhood", TOKEN, { rpc: chain({ buys: [], sell: () => true }), maxWindows: 2 });
  assert.equal(r.ok, false);
  assert.match(r.why, /no recent buyer found/);
});

test("buyers who already sold out say nothing either way", async () => {
  const r = await sim.sellCheckX("robinhood", TOKEN, { rpc: chain({ buys: buysFromPool, sell: () => "revert", balance: () => 0n }) });
  assert.equal(r.ok, false);
  assert.match(r.why, /no recent buyer still holds it/);
});

test("wallet-to-wallet transfers are not buys, and a contract recipient is not a seller", async () => {
  // NEWEST last, so these two are the first the walk meets — a sim that took
  // them would try them before any real buyer.
  const buys = [
    ...buysFromPool,
    [POOL, ROUTER], // pool → contract
    [wallet(7), wallet(8)], // wallet → wallet
  ];
  const seen = [];
  await sim.sellCheckX("robinhood", TOKEN, { rpc: chain({ buys, sell: (from) => (seen.push(from), "revert") }) });
  assert.equal(seen.length, sim.BUYERS, "three real buyers were tried");
  assert.ok(!seen.includes(wallet(8)) && !seen.includes(ROUTER.toLowerCase()), JSON.stringify(seen));
});

test("with the pool KNOWN, only that pool's buys count — a router hop is not a sell venue", async () => {
  const buys = [[ROUTER, wallet(9)], ...buysFromPool, [ROUTER, wallet(8)]];
  const venues = [];
  await sim.sellCheckX("robinhood", TOKEN, { pool: POOL, rpc: chain({ buys, sell: (from, to) => (venues.push(to), "revert") }) });
  assert.ok(venues.length > 0 && venues.every((v) => v === POOL), JSON.stringify(venues));
});

test("a node that refuses the log range is asked again with a smaller one", async () => {
  const calls = [];
  const r = await sim.sellCheckX("robinhood", TOKEN, { rpc: chain({ buys: buysFromPool, sell: () => true, logsError: 1000, calls }) });
  assert.equal(r.sells, true);
  assert.ok(calls.filter((c) => c === "eth_getLogs").length > 1, "it retried");
});

test("a dead RPC is inconclusive, and a non-EVM address is not ours to judge", async () => {
  const dead = async () => {
    throw new Error("fetch failed (ECONNREFUSED)");
  };
  const r = await sim.sellCheckX("robinhood", TOKEN, { rpc: dead });
  assert.equal(r.ok, false);
  const tron = await sim.sellCheckX("tron", "TXYZabc", {});
  assert.deepEqual([tron.ok, tron.unsupported], [true, true]);
});

test("isRevert reads the node's words; returnedFalse reads only a 32-byte zero", () => {
  assert.ok(sim.isRevert({ code: 3, message: "x" }));
  assert.ok(sim.isRevert({ code: -32000, message: "execution reverted" }));
  assert.ok(!sim.isRevert({ code: -32005, message: "rate limited" }), "a rate limit is the node, not the contract");
  assert.ok(sim.returnedFalse("0x" + "0".repeat(64)));
  assert.ok(!sim.returnedFalse("0x"), "USDT-style tokens return nothing on success");
  assert.ok(!sim.returnedFalse("0x" + "0".repeat(63) + "1"));
});

test("jsonRpc: a JSON-RPC error is RETURNED (same answer everywhere); HTTP failure THROWS (walk on)", async (t) => {
  const real = global.fetch;
  t.after(() => (global.fetch = real));
  global.fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } }), { status: 200 });
  const out = await sim.jsonRpc("http://node", "eth_call", []);
  assert.equal(out.error.code, 3);
  global.fetch = async () => new Response("busy", { status: 503 });
  await assert.rejects(() => sim.jsonRpc("http://node", "eth_call", []), /HTTP 503/);
});

test("the switch: blank is ON, an explicit 0 turns it off", () => {
  const prev = process.env.FREE_LISTING_SELL_SIM;
  try {
    delete process.env.FREE_LISTING_SELL_SIM;
    assert.equal(sim.enabled(), true);
    process.env.FREE_LISTING_SELL_SIM = "";
    assert.equal(sim.enabled(), true);
    process.env.FREE_LISTING_SELL_SIM = "0";
    assert.equal(sim.enabled(), false);
  } finally {
    if (prev === undefined) delete process.env.FREE_LISTING_SELL_SIM;
    else process.env.FREE_LISTING_SELL_SIM = prev;
  }
});

test("the door hands the POOL to the safety check, on every path", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/services/autoLister.js"), "utf8");
  assert.match(src, /listingSafety\.checkX\(chain, address, \{ pool: info\.poolAddress \}\)/, "createFromInfo");
  assert.match(src, /listingSafety\.checkX\(c, a, \{ pool: info && info\.poolAddress \}\)/, "the scan's seam");
  assert.equal((src.match(/safetyX\(c\.chain, c\.address, info\)/g) || []).length, 2, "scan and test scan");
  const audit = require("node:fs").readFileSync(require.resolve("../src/services/listingAudit.js"), "utf8");
  assert.match(audit, /deps\.safetyX\(row\.chain, row\.address, info\)/, "the audit re-checks listed tokens the same way");
});
