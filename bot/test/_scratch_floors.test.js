const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-scratch-"));

const test = require("node:test");
const assert = require("node:assert");
const market = require("../src/marketdata");
const api = require("../src/api/dexvra");
const autoTrend = require("../src/services/autoTrend");

const listing = (address, chain = "solana") => ({ status:"approved", chain, address, sym:address, trendingRank:null });

async function promoteWith(rows, reading) {
  const rm = market.fetchMarket, rl = api.getListings, rb = api.bookTrending;
  market.fetchMarket = async (_c, a) => reading(a);
  api.getListings = async () => rows;
  const booked = [];
  api.bookTrending = async (_c, a) => booked.push(a);
  try { await autoTrend.runOnce({ rng: () => 0.5 }); }
  finally { market.fetchMarket = rm; api.getListings = rl; api.bookTrending = rb; }
  return booked;
}
async function withFloors(extra = {}) {
  await autoTrend.reset();
  return autoTrend.set({ enabled:true, chains:["solana"], perChainMin:3, perChainMax:3,
    minGainPct:0, announce:false, fillFromMarket:false,
    minMcapUsd:100_000, minVol24hUsd:10_000, ...extra });
}

// X: brand-new pool -> big cap+vol, NO 24h reading.  Y: small cap, real reading.
const X = { priceUsd: 0.01, mcap: 3_000_000, vol24h: 800_000, change24h: null };
const Y = { priceUsd: 0.02, mcap: 60_000,    vol24h: 12_000,  change24h: 8 };

test("FLOORS ON -> a blank-percentage row is promoted", async () => {
  await withFloors();
  const booked = await promoteWith([listing("X"), listing("Y")], (a) => ({ X, Y }[a]));
  console.log("floors ON  booked:", booked);
});

test("FLOORS OFF -> the readable row wins, the blank one is refused", async () => {
  await withFloors({ minMcapUsd: 0, minVol24hUsd: 0 });
  const booked = await promoteWith([listing("X"), listing("Y")], (a) => ({ X, Y }[a]));
  console.log("floors OFF booked:", booked);
});

test("byGain tail: rows past PROBE_CAP come back undefined and are refused", async () => {
  const rm = market.fetchMarket;
  const good = { priceUsd: 1, mcap: 9_000_000, vol24h: 4_000_000, change24h: 12 };
  market.fetchMarket = async () => good;
  try {
    const rows = Array.from({ length: 27 }, (_, i) => listing("T" + i));
    const ranked = await autoTrend.byGain(rows, () => 0.5);
    const cfg = { minMcapUsd: 100_000, minVol24hUsd: 10_000 };
    const refused = ranked.filter((r) => autoTrend.floorRefusal({ mcap: r._mcap, vol24: r._vol24 }, cfg));
    console.log("27 identical healthy tokens ->", refused.length, "refused;",
      "first refusal:", refused.length && autoTrend.floorRefusal({ mcap: refused[0]._mcap, vol24: refused[0]._vol24 }, cfg).why);
  } finally { market.fetchMarket = rm; }
});
