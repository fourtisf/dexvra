// The DexScreener gap-filler — the second source chains.ts documented and
// nobody built, while every bot-listed launch rendered a fabricated ▲0.0%
// until GT indexed its first pool.
import test from "node:test";
import assert from "node:assert";
import { DS_MULTI_MAX, fetchDsMarket } from "./dexscreener.ts";

const realFetch = globalThis.fetch;
const addr = (i: number) => `Mint${i}aBcDeFgHiJkLmNpQrStUvWxYz${i}`;

function pair(base: string, over: Record<string, unknown> = {}) {
  return {
    chainId: "solana", pairAddress: `pool_${base}`,
    baseToken: { address: base, name: "T", symbol: "T" },
    priceUsd: "0.5", marketCap: 1_000_000, liquidity: { usd: 40_000 },
    priceChange: { m5: 1, h1: 2, h6: 3, h24: 4 },
    volume: { m5: 10, h1: 20, h6: 30, h24: 40 },
    txns: { h24: { buys: 5, sells: 3 } },
    pairCreatedAt: Date.now() - 3_600_000,
    ...over,
  };
}

function mockDs(answer: (chunk: string[]) => unknown, failStatuses: (number | null)[] = []) {
  const urls: string[] = [];
  let call = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const status = failStatuses[call++] ?? null;
    if (status != null) return new Response("nope", { status });
    const chunk = decodeURIComponent(url.split("/").pop()!.split("?")[0]).split(",");
    return Response.json(answer(chunk));
  }) as typeof fetch;
  return urls;
}

test("every address is asked for, chunked, verbatim, on the chain-scoped path", async () => {
  try {
    const addresses = Array.from({ length: 45 }, (_, i) => addr(i));
    const urls = mockDs((chunk) => chunk.map((a) => pair(a)));
    const map = await fetchDsMarket("solana", addresses);
    assert.strictEqual(urls.length, Math.ceil(45 / DS_MULTI_MAX));
    // chain in the PATH is what makes the wrong-chain-pair problem impossible
    for (const u of urls) assert.match(u, /\/tokens\/v1\/solana\//);
    assert.ok(urls[0].includes(addr(1)), "casing survives — base58 is case-significant");
    assert.strictEqual(map.size, 45);
    assert.strictEqual(map.get(addr(3).toLowerCase())?.chg["1h"], 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a token with several pairs is judged by its DEEPEST", async () => {
  try {
    const a = addr(1);
    mockDs(() => [
      pair(a, { liquidity: { usd: 500 }, priceChange: { h24: 4000 } }), // dust pool, absurd pct
      pair(a, { liquidity: { usd: 90_000 }, priceChange: { h24: 7 } }),
    ]);
    const m = await fetchDsMarket("solana", [a]);
    assert.strictEqual(m.get(a.toLowerCase())?.chg["24h"], 7, "the deep pool's reading wins");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a pair where the asked token is the QUOTE side never counts", async () => {
  try {
    mockDs(() => [pair("SomeOtherBase111111111111111111111111111111")]);
    const m = await fetchDsMarket("solana", [addr(1)]);
    assert.strictEqual(m.size, 0, "identity is the base token's address, nothing else");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the DS pool address never reaches poolAddress — it feeds a GT chart embed", async () => {
  try {
    mockDs((chunk) => chunk.map((a) => pair(a)));
    const m = await fetchDsMarket("solana", [addr(1)]);
    assert.strictEqual(m.get(addr(1).toLowerCase())?.poolAddress, null,
      "a pool GT never indexed renders as a 404 inside the token page");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a chain DexScreener does not carry answers empty without a request", async () => {
  try {
    const urls = mockDs(() => []);
    assert.strictEqual((await fetchDsMarket("robinhood", [addr(1)])).size, 0);
    assert.strictEqual(urls.length, 0, "chains.ts says dexscreener: null there");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("total failure throws; partial failure keeps what answered", async () => {
  try {
    mockDs(() => [], [429, 429]);
    await assert.rejects(() => fetchDsMarket("solana", Array.from({ length: 40 }, (_, i) => addr(i))), /DexScreener 429/);
    mockDs((chunk) => chunk.map((a) => pair(a)), [429, null]);
    const m = await fetchDsMarket("solana", Array.from({ length: 40 }, (_, i) => addr(i)));
    assert.strictEqual(m.size, 10, "the second chunk landed");
  } finally {
    globalThis.fetch = realFetch;
  }
});
