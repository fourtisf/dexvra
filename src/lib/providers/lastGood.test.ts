// The last-known-good bridge. The bug it pins: a token the providers priced
// last cycle and miss THIS cycle collapsed to its captured-at-listing figures
// (chg24h 0, source "seed"), which changeReading rightly renders as a dash —
// so one failed GT chunk put "—" on a New Listings row about a token priced
// sixty seconds earlier ("persenan naik atau turun masa tidak ada").
import test from "node:test";
import assert from "node:assert";
import { LAST_GOOD_TTL_MS, fillFromLastGood, resetLastGood } from "./lastGood.ts";
import type { LiveMarket } from "./geckoterminal.ts";

const market = (price: number): LiveMarket => ({
  priceUsd: price,
  mcap: 1_000_000,
  liq: 50_000,
  chg: { "5m": 0.1, "1h": 1, "6h": 3, "24h": 12.5 },
  vol: { "5m": 10, "1h": 100, "6h": 500, "24h": 2000 },
  txns: {
    "5m": { buys: 1, sells: 1 }, "1h": { buys: 5, sells: 4 },
    "6h": { buys: 20, sells: 15 }, "24h": { buys: 80, sells: 60 },
  },
  ageMinutes: 60,
  logoUrl: null,
  poolAddress: null,
});

const ADDR = "MintAbCdEf123";
const KEY = ADDR.toLowerCase();

test("a miss inside the TTL is served the last real observation", () => {
  resetLastGood();
  const t0 = 1_000_000;
  fillFromLastGood("solana", new Map([[KEY, market(1.5)]]), [ADDR], t0);

  const later = new Map<string, LiveMarket>(); // this cycle: the providers missed it
  const filled = fillFromLastGood("solana", later, [ADDR], t0 + 60_000);
  assert.deepStrictEqual(filled, [KEY], "the fill is reported, not silent");
  assert.strictEqual(later.get(KEY)?.chg["24h"], 12.5, "the remembered reading stands in");
});

test("a fresh reading always wins — memory only fills what the cycle missed", () => {
  resetLastGood();
  const t0 = 1_000_000;
  fillFromLastGood("solana", new Map([[KEY, market(1.5)]]), [ADDR], t0);

  const fresh = new Map([[KEY, market(9.9)]]);
  const filled = fillFromLastGood("solana", fresh, [ADDR], t0 + 60_000);
  assert.deepStrictEqual(filled, [], "nothing was filled");
  assert.strictEqual(fresh.get(KEY)?.priceUsd, 9.9, "the live value was not overwritten");
});

test("past the TTL the dash returns — a frozen reading stops being a reading", () => {
  resetLastGood();
  const t0 = 1_000_000;
  fillFromLastGood("solana", new Map([[KEY, market(1.5)]]), [ADDR], t0);

  const later = new Map<string, LiveMarket>();
  const filled = fillFromLastGood("solana", later, [ADDR], t0 + LAST_GOOD_TTL_MS + 1);
  assert.deepStrictEqual(filled, []);
  assert.strictEqual(later.size, 0, "an expired memory serves nothing");
});

test("memory is scoped per CHAIN — a same-address deploy elsewhere may not answer", () => {
  // The bot repo paid for the cross-chain version of this: a same-address
  // token on another chain supplying the price (dexChainFilter, gotcha #15).
  resetLastGood();
  const t0 = 1_000_000;
  fillFromLastGood("ethereum", new Map([[KEY, market(1.5)]]), [ADDR], t0);

  const sol = new Map<string, LiveMarket>();
  assert.deepStrictEqual(fillFromLastGood("solana", sol, [ADDR], t0 + 1000), []);
  assert.strictEqual(sol.size, 0);
});

test("a fill refreshes nothing — only a REAL reading renews the clock", () => {
  // If serving from memory re-stamped the entry, a token the providers never
  // answer again would be served a frozen price forever: each cycle's fill
  // would count as a fresh observation. The remember pass runs over the map
  // BEFORE any fill, so a filled value must not extend its own life.
  resetLastGood();
  const t0 = 1_000_000;
  fillFromLastGood("solana", new Map([[KEY, market(1.5)]]), [ADDR], t0);

  // serve from memory every 30 minutes; past the TTL it must still expire
  const step = 30 * 60_000;
  for (let t = t0 + step; t <= t0 + LAST_GOOD_TTL_MS; t += step) {
    fillFromLastGood("solana", new Map<string, LiveMarket>(), [ADDR], t);
  }
  const after = new Map<string, LiveMarket>();
  const filled = fillFromLastGood("solana", after, [ADDR], t0 + LAST_GOOD_TTL_MS + 1);
  assert.deepStrictEqual(filled, [], "repeated fills did not keep the memory alive");
});
