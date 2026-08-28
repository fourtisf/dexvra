// "FREE TRENDING TIDAK BEGITU BEKERJA — tidak sesuai dengan minimum yang sudah
// di set" (2026-08-28), with the panel showing `Solana 3/5–8 · BSC 1/5–8 ·
// Ethereum 1 · Base 1 · Robinhood 1 · Tron 3/5–8` and the pinned board
// matching it exactly. Every chain under the floor, and the board carrying
// big established coins — the market filler's own work.
//
// The cause was one `catch {}` in `byGain`. A market read that FAILED — a
// shared-429 from GeckoTerminal, a timeout, a `fetchMarket` that answers null
// because neither reader could be reached — left `_change`, `_mcap` and
// `_vol24` null, which is byte-identical to an indexer ANSWERING that the token
// has no data. Three rules then act on it: `hasReading` refuses the row,
// `rowRefusal` reads the null cap as failing the free-trending floors, and the
// log accuses the operator's own listings of being too small. So the board
// publishes only as many rows as the read happened to answer for, and the one
// line explaining it names the wrong cause.
//
// GT's free tier is ~30 req/min PER IP and this box shares it with the website,
// so losing most of a cycle's reads is ordinary here — which is why this is the
// difference between a board that fills and one stuck at 1.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-trunpriced-"));

const test = require("node:test");
const assert = require("node:assert");

const autoTrend = require("../src/services/autoTrend");
const watch = require("../src/services/trendingWatch");
const market = require("../src/marketdata");

const M = 1_000_000;

/** Stand in for the market reader for one test. */
function stubMarket(t, fn) {
  const real = market.fetchMarket;
  market.fetchMarket = fn;
  t.after(() => (market.fetchMarket = real));
}

const row = (i, over = {}) => ({ chain: "solana", address: `So1${i}`, sym: `T${i}`, status: "approved", ...over });

// ── byGain must record WHY a row has no numbers ─────────────────────────────

test("⚠️ a market read that THREW is marked unread — not as a token with no data", async (t) => {
  stubMarket(t, async () => {
    throw new Error("GeckoTerminal 429 (rate limited)");
  });
  const rows = [row(1), row(2)];
  await autoTrend.byGain(rows, () => 0.5);
  for (const r of rows) {
    assert.strictEqual(r._unread, true, "a failed read looked exactly like an empty token");
    assert.strictEqual(r._change, null);
  }
});

test("⚠️ a fetchMarket that answers NULL is unread too — both readers came up empty", async (t) => {
  stubMarket(t, async () => null);
  const rows = [row(1)];
  await autoTrend.byGain(rows, () => 0.5);
  assert.strictEqual(rows[0]._unread, true);
});

test("a token the indexer ANSWERED about, with no 24h reading, is NOT unread", async (t) => {
  // This is the real "quiet pool" case, and it must keep behaving exactly as it
  // did: refused from the board, and counted honestly.
  stubMarket(t, async () => ({ priceUsd: 0.01, mcap: 5 * M, vol24h: 90_000, change24h: null }));
  const rows = [row(1)];
  await autoTrend.byGain(rows, () => 0.5);
  assert.strictEqual(rows[0]._unread, false);
  assert.strictEqual(rows[0]._change, null);
  assert.strictEqual(rows[0]._mcap, 5 * M, "the cap it DID publish must survive");
});

// ── …and an unread row is not accused of failing a floor ────────────────────

test("⚠️ an unread row is NOT counted as 'below the free-trending floors'", async (t) => {
  stubMarket(t, async () => {
    throw new Error("GeckoTerminal 429 (rate limited)");
  });
  const rows = [row(1), row(2), row(3)];
  const ranked = await autoTrend.byGain(rows, () => 0.5);
  const cfg = { ...autoTrend.DEFAULTS, minMcapUsd: 100_000, minVol24hUsd: 10_000 };
  // A null cap cannot satisfy a floor, so these rows are still refused — that
  // half is right and unchanged. What must not happen is telling the operator
  // their tokens are too small, about tokens nobody could read.
  assert.strictEqual(
    autoTrend.countFloorRefusals(ranked, cfg),
    0,
    "the log would accuse the operator's own listings over an upstream that refused us",
  );
});

test("…while a row that really IS below the floors is still counted", async (t) => {
  stubMarket(t, async () => ({ priceUsd: 0.01, mcap: 40_000, vol24h: 5, change24h: 3 }));
  const rows = [row(1)];
  const ranked = await autoTrend.byGain(rows, () => 0.5);
  const cfg = { ...autoTrend.DEFAULTS, minMcapUsd: 100_000, minVol24hUsd: 10_000 };
  assert.strictEqual(autoTrend.countFloorRefusals(ranked, cfg), 1, "the floors must still do their job");
});

// ── the watch names the upstream, not the operator's settings ───────────────

test("⚠️ the watch reports an unpriceable chain as an UPSTREAM problem", () => {
  const why = watch.diagnose({
    featured: 1,
    floor: 5,
    eligible: 12,
    unread: 12,
    floorRefused: 12, // the floors "refused" them too — but only because of the null cap
    floorsText: "min cap $100K, min vol $10K",
  });
  assert.strictEqual(why.code, "unpriced", `got "${why.code}" — the operator is sent to change a setting`);
  assert.match(why.text, /could not be PRICED/);
  assert.match(why.text, /GECKOTERMINAL_API_KEY/);
});

test("…and a chain whose spares really are too small still says so", () => {
  const why = watch.diagnose({
    featured: 1,
    floor: 5,
    eligible: 12,
    unread: 0,
    floorRefused: 12,
    floorsText: "min cap $100K, min vol $10K",
  });
  assert.strictEqual(why.code, "below_floors");
  assert.match(why.text, /min cap \$100K/);
});

test("a PARTIAL read is not blamed on the upstream — some rows answered", () => {
  // The exemption is deliberately narrow: only where the read failed for every
  // spare is the upstream the answer. Two unread out of twelve is a quota blip,
  // and the chain's real problem is whatever refused the other ten.
  const why = watch.diagnose({
    featured: 1,
    floor: 5,
    eligible: 12,
    unread: 2,
    floorRefused: 10,
    floorsText: "min cap $100K, min vol $10K",
  });
  assert.strictEqual(why.code, "below_floors");
});
