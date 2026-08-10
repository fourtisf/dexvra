// The three links under every buy alert, and what happens on a token that is
// not on dexvra.io — which is most of them, because the buy bot is free.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-cta-"));

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");
const { chartUrl, CHAIN_IDS } = require("../src/config/chains");
const listedCache = require("../src/group/listedCache");
const api = require("../src/api/dexvra");

const g = (over = {}) => ({
  chatId: "-100", chain: "solana", address: "So1Token", pairAddress: "PooLAddr",
  sym: "RUSS", name: "The Nietzschean Dog", ...over,
});
const pool = { priceUsd: 0.00004823, mcap: 15511897, liquidity: 183475, change24h: 18.42 };
const buy = { txHash: "5xTx", buyer: "AFqu1Maaaaaaaaaaaaaaaaaaaaaaajail", usd: 804.72, tokenAmount: 51874.15 };

/** label → url for every link in a rendered card. */
function links(payload) {
  const out = {};
  for (const e of payload.entities || []) {
    if (e.type === "text_link") out[payload.text.substr(e.offset, e.length)] = e.url;
  }
  return out;
}

test("Trade on Dexvra opens the TRADE BOT already scanning this CA", () => {
  // ?start=ca_<chain>_<address> — the payload tradebot/telegram.js reads to skip
  // straight to the scan instead of asking for an address.
  const l = links(mon.renderRealAlert(g(), buy, pool, null, true));
  assert.match(l["⚡ Trade on Dexvra"], /^https:\/\/t\.me\/[^/?]+\?start=ca_solana_So1Token$/);
});

test("Chart is DexScreener, on the POOL — the pair, not a token search", () => {
  const l = links(mon.renderRealAlert(g(), buy, pool, null, true));
  assert.strictEqual(l["📈 Chart"], "https://dexscreener.com/solana/PooLAddr");
});

test("a group whose pool hasn't resolved yet still gets a chart", () => {
  const l = links(mon.renderRealAlert(g({ pairAddress: null }), buy, pool, null, true));
  assert.strictEqual(l["📈 Chart"], "https://dexscreener.com/solana/So1Token", "DexScreener resolves a token too");
});

test("the one chain DexScreener does not index never gets a dexscreener link", () => {
  // Robinhood Chain is on GeckoTerminal and not on DexScreener, so the slug is
  // deliberately absent and the button falls back rather than 404ing.
  assert.strictEqual(chartUrl("robinhood", "0xPool"), null);
  const l = links(mon.renderRealAlert(g({ chain: "robinhood", address: "0xCA" }), buy, pool, null, true));
  assert.ok(!/dexscreener/.test(l["📈 Chart"]), "no dead dexscreener link");
  assert.match(l["📈 Chart"], /dexvra\.io\/token\/robinhood\/0xCA/);
});

test("every chain the bot supports either has a chart or is a known exception", () => {
  const missing = CHAIN_IDS.filter((c) => !chartUrl(c, "X"));
  assert.deepStrictEqual(missing, ["robinhood"], "a new chain needs a DEXSCREENER_SLUG entry");
});

test("the third link is Dexvra, on the token's own page", () => {
  const l = links(mon.renderRealAlert(g(), buy, pool, null, true));
  assert.strictEqual(l["💎 Dexvra"], "https://dexvra.io/token/solana/So1Token");
});

// ── A token that is not listed ───────────────────────────────────────────────

test("an unlisted token drops the Dexvra link instead of pointing at a 404", () => {
  const p = mon.renderRealAlert(g(), buy, pool, null, false);
  const l = links(p);
  assert.ok(!l["💎 Dexvra"], "the link is gone");
  assert.ok(!/💎/.test(p.text), "and so is its separator — no dangling ·");
  assert.match(p.text, /isn't listed on Dexvra yet/);
});

test("…and the header stops linking to that 404 too", () => {
  // The token NAME headlines the card through {coinUrl}. On an unlisted token
  // that was a dexvra.io 404 on every single buy.
  const listedL = links(mon.renderRealAlert(g(), buy, pool, null, true));
  assert.match(listedL["The Nietzschean Dog"], /dexvra\.io/, "listed: the product page");
  const unlistedL = links(mon.renderRealAlert(g(), buy, pool, null, false));
  assert.match(unlistedL["The Nietzschean Dog"], /dexscreener/, "unlisted: somewhere real");
});

test("the note carries the ticker and a way to fix it", () => {
  const p = mon.renderRealAlert(g(), buy, pool, null, false);
  assert.match(p.text, /\$RUSS/);
  assert.match(links(p)["list it in minutes"], /^https:\/\/t\.me\//);
});

test("UNKNOWN is not 'not listed' — an API outage must not deny a paid listing", () => {
  // isListed returns null when it could not tell. Telling a paying customer's
  // group their token isn't listed because an internal fetch timed out is worse
  // than briefly linking a page that does exist.
  for (const unknown of [null, undefined]) {
    const p = mon.renderRealAlert(g(), buy, pool, null, unknown);
    assert.ok(!/isn't listed/.test(p.text), `${unknown} shows no note`);
    assert.ok(links(p)["💎 Dexvra"], `${unknown} keeps the link`);
  }
});

test("the whale and estimate cards carry the same links and the same note", () => {
  const whale = mon.renderWhaleAlert(g(), buy, pool, { held: 1e6, holdsUsd: 5e4, position: "+1%" }, false);
  assert.match(whale.text, /isn't listed on Dexvra yet/);
  assert.strictEqual(links(whale)["📈 Chart"], "https://dexscreener.com/solana/PooLAddr");
  const est = mon.renderEstimateAlert(g(), { usd: 3120, count: 4 }, pool, false);
  assert.match(est.text, /isn't listed on Dexvra yet/);
  assert.strictEqual(links(est)["📈 Chart"], "https://dexscreener.com/solana/PooLAddr");
});

// ── The cache in front of the listing check ──────────────────────────────────

test("the listing check is cached — the alert path must not fetch every listing per buy", async () => {
  const real = api.findListing;
  let calls = 0;
  try {
    listedCache.forget();
    api.findListing = async () => {
      calls++;
      return { id: "x" };
    };
    assert.strictEqual(await listedCache.isListed("solana", "So1"), true);
    assert.strictEqual(await listedCache.isListed("solana", "so1"), true, "case-insensitive");
    assert.strictEqual(await listedCache.isListed("solana", "So1"), true);
    assert.strictEqual(calls, 1, "one fetch served three alerts");
  } finally {
    api.findListing = real;
    listedCache.forget();
  }
});

test("a MISS is re-checked, so the note disappears once they actually list", async () => {
  const real = api.findListing;
  try {
    listedCache.forget();
    api.findListing = async () => null;
    assert.strictEqual(await listedCache.isListed("solana", "So2"), false);
    // Age the miss past its TTL, then let the listing appear.
    listedCache._cache.set("solana:so2", { listed: false, at: Date.now() - listedCache.MISS_TTL_MS - 1 });
    api.findListing = async () => ({ id: "now-listed" });
    assert.strictEqual(await listedCache.isListed("solana", "So2"), true, "without waiting for a restart");
  } finally {
    api.findListing = real;
    listedCache.forget();
  }
});

test("an unreachable API answers null, never false", async () => {
  const real = api.findListing;
  try {
    listedCache.forget();
    api.findListing = async () => {
      throw new Error("ECONNREFUSED");
    };
    assert.strictEqual(await listedCache.isListed("solana", "So3"), null);
    assert.ok(!listedCache._cache.has("solana:so3"), "and nothing is cached from a failure");
  } finally {
    api.findListing = real;
    listedCache.forget();
  }
});
