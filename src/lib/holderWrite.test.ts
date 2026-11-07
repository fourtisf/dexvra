import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyHolderCount } from "./holderWrite.ts";

// The OTHER chain's row comes FIRST: with it second, a write that ignored the
// chain would still land on the right row by order alone (a mutation run said so).
const rows = () => [
  { chain: "ethereum", address: "0x0a574aae41da077713ba32aa05ca151c8759e2f6", holders: 9, sym: "$OTHER" },
  { chain: "robinhood", address: "0x0A574aAE41da077713Ba32aa05Ca151C8759e2f6", holders: 0, sym: "$SFX" },
];

test("a measured count is stored on the row — address case-insensitive, chain exact", () => {
  const out = applyHolderCount(rows(), "robinhood", "0x0a574aae41da077713ba32aa05ca151c8759e2f6", 1570);
  assert.equal(out.wrote, true);
  assert.equal(out.rows[1].holders, 1570);
  assert.equal(out.rows[0].holders, 9, "the same address on another chain is another token");
});

test("⚠️ a zero, a negative or a NaN is never written — that is the 'HOLDERS 0' this exists to end", () => {
  for (const bad of [0, -1, NaN, Infinity]) assert.equal(applyHolderCount(rows(), "robinhood", "0x0a574aae41da077713ba32aa05ca151c8759e2f6", bad).wrote, false, String(bad));
});

test("a sub-1% tick does not rewrite the whole store; a real move does", () => {
  const base = [{ chain: "robinhood", address: "0xabc", holders: 1000 }];
  assert.equal(applyHolderCount(base, "robinhood", "0xabc", 1005).wrote, false);
  const r = applyHolderCount(base, "robinhood", "0xabc", 1020);
  assert.equal(r.wrote, true);
  assert.equal(r.rows[0].holders, 1020);
  assert.equal(applyHolderCount(base, "robinhood", "0xdef", 5000).wrote, false, "no such row");
});

test("the route stores ONLY a measured count, never awaited, never failing the answer", () => {
  const src = readFileSync(new URL("../app/api/holders/route.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  const miss = src.indexOf("throw new NoCount");
  const store = src.indexOf("void setHolderCount(");
  assert.ok(miss > 0 && store > miss, "stored after the miss has thrown — a miss never reaches the store");
  assert.match(src, /void setHolderCount\([^;]*\.catch\(/);
});
