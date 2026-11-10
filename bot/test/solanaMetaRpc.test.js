// The on-chain metadata read's RPC walk — driven against stub nodes.
//
// $KVR's review card came back blank on a box whose operator had said their
// Helius plan was hitting its limit, and the buy bot polls Solana pools through
// that same `RPC_SOLANA_URLS` all day. `RPC_SOLANA_URLS` wins outright, so one
// 429 there left the metadata read with nowhere to go. A token's public
// metadata carries no operator address, so this ONE read may fall back to the
// shipped public endpoints after the operator's own (the trade bot's
// SOL_READ_FALLBACKS decision) — and it must say which host refused FIRST.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-solmetarpc-"));
process.env.SOLANA_META = "";

const test = require("node:test");
const assert = require("node:assert");

const rpc = require("../src/config/rpc");
const sm = require("../src/solanaMeta");

const KEYED = "https://mainnet.helius-rpc.com/?api-key=SECRETKEY123";
const ACCOUNTS = { context: { slot: 1 }, value: [null, null, null] };

const hits = [];
let answer = () => null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  url = String(url);
  hits.push(new URL(url).host);
  const r = answer(url, init);
  if (r) return r;
  return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: ACCOUNTS }), body: null };
};
const status = (n) => ({ ok: false, status: n, json: async () => ({}), body: null });
test.after(() => { globalThis.fetch = realFetch; });

function setup(env) {
  hits.length = 0;
  rpc._reset();
  sm._reset();
  delete process.env.RPC_SOLANA;
  delete process.env.SOLANA_META_PUBLIC_RPC;
  process.env.RPC_SOLANA_URLS = KEYED;
  Object.assign(process.env, env || {});
}
const read = () => sm._test.readAccounts(["a", "b", "c"], { timeoutMs: 800, budgetMs: 3000 });

test("⚠️ the operator's endpoint refusing (429) falls back to the public ones — the configured one still LEADS", async () => {
  setup();
  answer = (url) => (url.includes("helius") ? status(429) : null);
  const accts = await read();
  assert.ok(Array.isArray(accts));
  assert.strictEqual(hits[0], "mainnet.helius-rpc.com", "a public node was asked ahead of the operator's own");
  assert.ok(hits.length >= 2, `nothing was asked after the refusal: ${hits}`);
});

test("SOLANA_META_PUBLIC_RPC=0 keeps the read on the configured list — and the reason names the HOST, never the key", async () => {
  setup({ SOLANA_META_PUBLIC_RPC: "0" });
  answer = () => status(429);
  await assert.rejects(read(), (e) => {
    assert.match(e.message, /mainnet\.helius-rpc\.com HTTP 429/);
    assert.doesNotMatch(e.message, /SECRETKEY123/, "a paid endpoint's key reached a reason");
    return true;
  });
  assert.deepStrictEqual(hits, ["mainnet.helius-rpc.com"]);
});

test("⚠️ every endpoint failing reports the FIRST refusal too, not only the last public node's", async () => {
  setup();
  answer = (url) => (url.includes("helius") ? status(429) : status(403));
  await assert.rejects(read(), (e) => {
    assert.match(e.message, /^mainnet\.helius-rpc\.com HTTP 429/, `the operator's own refusal was buried: ${e.message}`);
    assert.match(e.message, /publicnode/, "the fallbacks are named too");
    return true;
  });
});

test("a REQUEST error is final — one ask, and it is in the reason", async () => {
  setup();
  answer = () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param: WrongSize" } }), body: null });
  await assert.rejects(read(), /Invalid param/);
  assert.strictEqual(hits.length, 1);
});

test("a public endpoint the operator already configured is not asked twice", async () => {
  setup({ RPC_SOLANA_URLS: "https://solana-rpc.publicnode.com" });
  answer = () => status(429);
  await assert.rejects(read());
  assert.strictEqual(hits.filter((h) => h === "solana-rpc.publicnode.com").length, 1, `${hits}`);
});

test("rpcRead's extraUrls never lead, and nothing else in the bot passes them", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "config", "rpc.js"), "utf8");
  assert.match(src, /\[\.\.\.rankedUrls\(chain, started\), \.\.\.extra\]/, "the extra urls must come AFTER the configured list");
  // Payments and sweeps must never fall back to a node the operator did not
  // pick — the one caller is the metadata read.
  const callers = [];
  const walk = (d) => {
    for (const e of fss.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".js") && /extraUrls\s*:/.test(fss.readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, ""))) callers.push(path.relative(path.join(__dirname, ".."), p));
    }
  };
  walk(path.join(__dirname, "..", "src"));
  assert.deepStrictEqual(callers, ["src/solanaMeta.js"]);
});
