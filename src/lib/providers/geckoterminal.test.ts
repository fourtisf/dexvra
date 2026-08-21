// The chunked GT fetch. The bug this pins: `addresses.slice(0, 30)` — written
// against a 14-token seed, shipped to a store of 173 listings, where it
// silently dropped tokens 31+ per chain. 53 of 83 Solana listings could never
// price and rendered +0.0% forever, with nothing anywhere saying why.
import test from "node:test";
import assert from "node:assert";
import { GT_MULTI_MAX, fetchListedMarket } from "./geckoterminal.ts";

const realFetch = globalThis.fetch;

// A base58-shaped, case-significant address per index — casing must survive.
const addr = (i: number) => `Mint${i}aBcDeFgHiJkLmNpQrStUvWxYz${i}`;

function gtToken(address: string) {
  return {
    id: `solana_${address}`,
    attributes: {
      address, name: "T", symbol: "T", image_url: null,
      price_usd: "1.5", market_cap_usd: "1000000", fdv_usd: null, total_reserve_in_usd: "50000",
    },
    relationships: { top_pools: { data: [] } },
  };
}

/** Mock GT: records every URL, answers each chunk with its own tokens. */
function mockGt(failStatuses: (number | null)[] = []) {
  const urls: string[] = [];
  let call = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const status = failStatuses[call++] ?? null;
    if (status != null) return new Response("rate limited", { status });
    const listed = decodeURIComponent(url.split("/multi/")[1].split("?")[0]).split(",");
    return Response.json({ data: listed.map(gtToken), included: [] });
  }) as typeof fetch;
  return urls;
}

const addrsIn = (url: string) => decodeURIComponent(url.split("/multi/")[1].split("?")[0]).split(",");

test("EVERY address is requested, in chunks the endpoint can answer", async () => {
  try {
    const addresses = Array.from({ length: 83 }, (_, i) => addr(i));
    const urls = mockGt();
    const map = await fetchListedMarket("solana", addresses);

    assert.strictEqual(urls.length, Math.ceil(83 / GT_MULTI_MAX), "83 → 3 requests");
    const sent = urls.flatMap(addrsIn);
    assert.strictEqual(sent.length, 83, "no token is silently dropped");
    for (const u of urls)
      assert.ok(addrsIn(u).length <= GT_MULTI_MAX, "no request exceeds the endpoint's cap");
    assert.strictEqual(map.size, 83, "and every one came back priced");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("addresses reach GT VERBATIM — base58 is case-significant", async () => {
  // The backend repo already paid for this one: lowercasing a base58 address
  // asks GT about an address that does not exist, silently, forever.
  try {
    const urls = mockGt();
    const map = await fetchListedMarket("solana", [addr(1)]);
    assert.ok(urls[0].includes(addr(1)), "the exact casing was sent");
    assert.ok(map.has(addr(1).toLowerCase()), "our keys are lowercased — they only have to be consistent");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("one failed chunk skips its tokens; it does not kill the chain", async () => {
  try {
    const addresses = Array.from({ length: 70 }, (_, i) => addr(i));
    mockGt([null, 429, null]); // chunk 2 of 3 is rate-limited
    const map = await fetchListedMarket("solana", addresses);
    assert.strictEqual(map.size, 40, "chunks 1 and 3 still landed");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("but a chain where NOTHING answered throws — down and empty are different facts", async () => {
  // Returning an empty map for a 429 would tell the caller "these 83 tokens
  // have no market", and the board would quietly keep captured figures with
  // `live` reading true.
  try {
    mockGt([429, 429, 429]);
    await assert.rejects(
      () => fetchListedMarket("solana", Array.from({ length: 70 }, (_, i) => addr(i))),
      /GeckoTerminal 429/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a chain GT does not index, or an empty list, answers empty without a request", async () => {
  try {
    const urls = mockGt();
    assert.strictEqual((await fetchListedMarket("nosuchchain", [addr(1)])).size, 0);
    assert.strictEqual((await fetchListedMarket("solana", [])).size, 0);
    assert.strictEqual(urls.length, 0, "no network call for either");
  } finally {
    globalThis.fetch = realFetch;
  }
});
