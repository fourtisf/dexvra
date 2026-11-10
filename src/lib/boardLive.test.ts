import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keepCurrent, listingKey } from "./boardLive.ts";
import { handDeleteRefusal } from "./handDelete.ts";

// "kalo token sudah dihapus berarti token bener2 dihapus": a deleted listing
// leaves the board on the next request, not when the next market cycle happens
// to succeed — and the operator's by-hand delete names the token it removes.

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const tok = (chain: string, address: string) => ({ chain, address, symbol: "$X" });

test("a token whose listing was deleted is dropped from a cached board", () => {
  const board = [tok("solana", "AAA"), tok("bsc", "0xBEEF"), tok("base", "0xCAFE")];
  const rows = [{ chain: "solana", address: "AAA" }, { chain: "base", address: "0xcafe" }];
  assert.deepEqual(keepCurrent(board, rows).map((t) => t.address), ["AAA", "0xCAFE"]);
});

test("the store's own identity rule: address case-insensitive, chain exact", () => {
  assert.equal(listingKey({ chain: "bsc", address: "0xAbC" }), listingKey({ chain: "bsc", address: "0xabc" }));
  // the same address on another chain is another listing
  assert.deepEqual(keepCurrent([tok("base", "0xabc")], [{ chain: "bsc", address: "0xabc" }]), []);
});

test("a store that could not be READ drops nothing — 'could not ask' is not 'nothing listed'", () => {
  const board = [tok("solana", "AAA"), tok("bsc", "0xBEEF")];
  assert.equal(keepCurrent(board, null), board);
});

test("getTokensPayload filters the cached board against the store, and a failed read yields null", () => {
  const src = strip(readFileSync(new URL("./providers/index.ts", import.meta.url), "utf8"));
  const body = src.slice(src.indexOf("export async function getTokensPayload("), src.indexOf("export async function getFearGreed("));
  assert.match(body, /if \(board\.ok\) \{\s*tokens = keepCurrent\(board\.value, await currentRows\(\)\);/, "the live board is filtered");
  const cur = src.slice(src.indexOf("async function currentRows("), src.indexOf("function expireTrending("));
  assert.match(cur, /catch \{\s*return null;/, "a read failure drops nothing");
  assert.match(cur, /rows\.length \? rows : SEED_ROWS/, "the same set loadRows builds the board from");
});

test("by-hand delete: the address must be RESTATED, and must be the stored one", () => {
  const row = { address: "0xAbCdEf" };
  assert.equal(handDeleteRefusal(row, "0xabcdef"), null, "case-insensitive, like the store");
  assert.equal(handDeleteRefusal(row, " 0xAbCdEf "), null);
  assert.match(String(handDeleteRefusal(row, "")), /restate/);
  assert.match(String(handDeleteRefusal(row, undefined)), /restate/);
  assert.match(String(handDeleteRefusal(row, "0x123")), /not this listing's address/);
  assert.equal(handDeleteRefusal(null, "0xabcdef"), "not found");
});

test("the by-hand route is authenticated, decides through the one rule, and only it may skip the bulk guard", () => {
  const route = strip(readFileSync(new URL("../app/api/internal/listings/[id]/remove/route.ts", import.meta.url), "utf8"));
  assert.match(route, /internalAuthorized\(req\)/);
  assert.match(route, /handDeleteRefusal\(row, body && body\.address\)/);
  assert.match(route, /deleteListing\(params\.id\)/);
  // the BULK route beside it still refuses anything somebody paid for
  const bulk = strip(readFileSync(new URL("../app/api/internal/listings/[id]/route.ts", import.meta.url), "utf8"));
  assert.match(bulk, /somebody paid for that/);
  assert.match(bulk, /not "bot"/);
});
