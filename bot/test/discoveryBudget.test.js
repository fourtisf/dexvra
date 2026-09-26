// ⚠️ ONE SOURCE THAT HANGS MAY NOT COST THE ANSWERS THAT ARRIVED.
//
// Reported with $HAPPYCAT (Pons, Robinhood, paired USDG): the listing form
// asked "What is your project called?" about a token whose contract publishes
// its name, ticker and logo. discovery.fetchTokenInfoX merged its sources with
// Promise.all — i.e. it waited for the SLOWEST — and the form wrapped the whole
// call in an 8s ceiling. The Pons pad's HTTP host (a guess, up to four path
// spellings) outran that ceiling, and the chain's answer went with it.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-discbudget-"));

const test = require("node:test");
const assert = require("node:assert");

const stub = (request, exports) => {
  const resolved = require.resolve(request);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const NEVER = () => new Promise(() => {});
const state = { pad: NEVER, ds: async () => ({ info: null, ok: true, why: null }) };

stub("../src/dexscreener", {
  fetchTokenInfoX: (...a) => state.ds(...a),
  fetchTokenInfo: async () => null,
  DEX_SLUG: {},
});
stub("../src/poolstrade", { OUR_CHAIN: "robinhood", fetchTokenInfo: async () => null, fetchDiscoveryX: async () => ({ items: [], ok: true, why: null }) });
stub("../src/launchpads", {
  covers: () => true,
  padsFor: () => [{ key: "pons" }],
  fetchTokenInfo: (...a) => state.pad(...a),
  fetchDescription: async () => null,
});

const TOKEN = "0x113ff96E9392a6501f65B3BD4AACB89D3D0945cC";
const LAUNCH = {
  address: TOKEN, symbol: "HAPPYCAT", name: "HAPPYCAT", logo: "ipfs://bafyhappycat",
  phase: "NotGraduated", graduated: false, progressPct: 17,
  ponsUrl: `https://www.ponsfamily.com/launchpad/${TOKEN}`, socials: null,
};

const discovery = require("../src/discovery");
const pons = require("../src/ponsChain");

function withSite(fn) {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ launch: LAUNCH }) });
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = previous; });
}

/** Fail with a sentence rather than hang the run. */
function race(p, ms, why) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(why)), ms); })]).finally(() => clearTimeout(t));
}

test("⚠️ a pad that never answers cannot cost the chain's answer — the name reaches the form", async () => {
  pons._reset();
  state.pad = NEVER;
  const out = await withSite(() =>
    race(discovery.fetchTokenInfoX("robinhood", TOKEN, { budgetMs: 150 }), 1500, "the merge waited on the hanging pad — this is the reported bug"),
  );
  assert.ok(out.info, "no record at all");
  assert.strictEqual(out.info.symbol, "HAPPYCAT");
  assert.ok(String(out.info.logoUrl).startsWith("https://"), out.info.logoUrl);
});

test("a DexScreener that never answers is reported as a miss, never as an answer", async () => {
  pons._reset();
  state.pad = async () => null;
  state.ds = NEVER;
  try {
    const out = await withSite(() => race(discovery.fetchTokenInfoX("robinhood", TOKEN, { budgetMs: 150 }), 1500, "hung on DexScreener"));
    assert.strictEqual(out.ok, false, "a timed-out indexer read as having answered");
    assert.match(out.why, /did not answer/);
    assert.strictEqual(out.info.symbol, "HAPPYCAT", "the chain still filled the record");
  } finally {
    state.ds = async () => ({ info: null, ok: true, why: null });
  }
});

test("with no budget every source is waited for, exactly as before (background callers)", async () => {
  pons._reset();
  let release;
  state.pad = () => new Promise((r) => { release = r; });
  let settled = false;
  const p = withSite(() => discovery.fetchTokenInfoX("robinhood", TOKEN)).then((v) => { settled = true; return v; });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(settled, false, "an unbudgeted caller stopped waiting for a source");
  release({ name: "Pad Name", symbol: "PADSYM" });
  const out = await race(p, 1500, "never settled after the pad answered");
  assert.ok(out.info);
});
