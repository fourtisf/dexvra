// The GT+DS merge, driven with injected fetchers — every branch here decides
// whether a chain has a market at all.
import test from "node:test";
import assert from "node:assert";
import { fetchIndexedMarket } from "./indexedMarket.ts";
import type { LiveMarket } from "./geckoterminal.ts";

const mk = (chg24: number): LiveMarket => ({
  priceUsd: 1, mcap: 1, liq: 1,
  chg: { "5m": 0, "1h": 0, "6h": 0, "24h": chg24 } as LiveMarket["chg"],
  vol: { "5m": 0, "1h": 0, "6h": 0, "24h": 0 } as LiveMarket["vol"],
  txns: { "5m": { buys: 0, sells: 0 }, "1h": { buys: 0, sells: 0 }, "6h": { buys: 0, sells: 0 }, "24h": { buys: 0, sells: 0 } },
  ageMinutes: 1, logoUrl: null, poolAddress: null,
});
const A = "AddrOne", B = "AddrTwo", C = "AddrThree";

test("DS is asked about exactly the LEFTOVERS — a gap-filler, never a second opinion", async () => {
  let dsAsked: string[] = [];
  const out = await fetchIndexedMarket("solana", [A, B, C], {
    gt: async () => new Map([[A.toLowerCase(), mk(10)]]),
    ds: async (_c, addrs) => {
      dsAsked = addrs;
      return new Map([[B.toLowerCase(), mk(20)]]);
    },
  });
  assert.deepStrictEqual(dsAsked, [B, C], "the GT-priced token is never re-asked");
  assert.strictEqual(out.get(A.toLowerCase())?.chg["24h"], 10);
  assert.strictEqual(out.get(B.toLowerCase())?.chg["24h"], 20);
  assert.strictEqual(out.has(C.toLowerCase()), false, "unpriced stays unpriced — the renderer draws its dash");
});

test("GT pricing everything means DS is never called at all", async () => {
  let dsCalls = 0;
  await fetchIndexedMarket("solana", [A], {
    gt: async () => new Map([[A.toLowerCase(), mk(1)]]),
    ds: async () => { dsCalls++; return new Map(); },
  });
  assert.strictEqual(dsCalls, 0, "no leftover, no request");
});

test("DS failing never costs what GT already answered", async () => {
  const out = await fetchIndexedMarket("solana", [A, B], {
    gt: async () => new Map([[A.toLowerCase(), mk(5)]]),
    ds: async () => { throw new Error("DexScreener 429"); },
  });
  assert.strictEqual(out.size, 1, "GT's answer stands");
});

test("GT down → DS prices the whole chain; a fallback that needs the primary is decoration", async () => {
  let dsAsked: string[] = [];
  const out = await fetchIndexedMarket("solana", [A, B], {
    gt: async () => { throw new Error("GeckoTerminal 429"); },
    ds: async (_c, addrs) => { dsAsked = addrs; return new Map([[A.toLowerCase(), mk(3)]]); },
  });
  assert.deepStrictEqual(dsAsked, [A, B], "everything goes to the second source");
  assert.strictEqual(out.get(A.toLowerCase())?.chg["24h"], 3);
});

test("both down → the chain throws, so the caller's captured-figures fallback stands", async () => {
  await assert.rejects(
    () => fetchIndexedMarket("solana", [A], {
      gt: async () => { throw new Error("GeckoTerminal 429"); },
      ds: async () => { throw new Error("DexScreener 500"); },
    }),
    /GeckoTerminal 429/,
    "the PRIMARY's error is the one reported",
  );
});

test("GT down and DS answering EMPTY still throws — down and empty are different facts", async () => {
  await assert.rejects(
    () => fetchIndexedMarket("solana", [A], {
      gt: async () => { throw new Error("GeckoTerminal 429"); },
      ds: async () => new Map(),
    }),
    /GeckoTerminal 429/,
  );
});
