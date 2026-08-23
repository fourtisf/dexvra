// The cache is bounded, and the bound is the point: half its keys come from a
// query string (/api/token-preview, /api/pool, /api/ohlcv all key on an address
// a stranger typed), and nothing ever removed an entry.
import test from "node:test";
import assert from "node:assert/strict";
import { CACHE_MAX_ENTRIES, cache, cached } from "./cache.ts";

test("a flood of one-off keys cannot grow the process without limit", () => {
  for (let i = 0; i < CACHE_MAX_ENTRIES + 500; i++) cache.set(`junk:${i}`, i, 60_000);
  assert.ok((cache.size ?? 0) <= CACHE_MAX_ENTRIES, `held ${cache.size}`);
});

test("⚠️ the key the app lives on survives the flood, because it is rewritten", () => {
  // A Map keeps a key's ORIGINAL insertion position on overwrite, so a naive
  // implementation evicts the busiest key first — exactly backwards.
  cache.set("listings:market", "board", 60_000);
  for (let i = 0; i < 200; i++) {
    cache.set(`flood:${i}`, i, 60_000);
    cache.set("listings:market", "board", 60_000); // the refresh cycle
  }
  assert.equal(cache.get("listings:market"), "board");
});

test("an expired entry is still the stale copy served when a provider is down", async () => {
  // Evicting by EXPIRY rather than by write order would delete exactly the
  // value that keeps a provider outage from emptying the board.
  cache.set("prov:x", "last good", 1);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cache.get("prov:x"), undefined, "not fresh");
  const out = await cached("prov:x", 60_000, async () => {
    throw new Error("provider down");
  });
  assert.equal(out, "last good");
});
