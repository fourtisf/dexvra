import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { holdersTitle, holdersCell } from "./holderCell.ts";

test("⚠️ a stored 0 nobody measured renders '—', never 'HOLDERS 0'", () => {
  assert.equal(holdersCell(null, 0), "—");
  assert.equal(holdersCell({ count: null }, 0), "—");
  assert.equal(holdersCell(null, null), "—");
});

test("a measured count wins, and a count is GROUPED rather than abbreviated", () => {
  assert.equal(holdersCell({ count: 1570 }, 0), "1,570");
  assert.equal(holdersCell({ count: 1570 }, 99), "1,570", "the measurement outranks the row");
  assert.equal(holdersCell({ count: 0 }, 99), "0", "a zero an explorer ANSWERED is a reading");
  assert.equal(holdersCell({ count: 1350000 }, null), "1.35M");
});

test("a count the row carries (admin-typed, the demo seed) is used when nothing was measured", () => {
  assert.equal(holdersCell(null, 812000), "812,000");
  assert.equal(holdersCell({ count: null }, 42), "42");
});

const code = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("⚠️ the board row reads a stored 0 as UNKNOWN — for the page AND for the score", () => {
  const src = code("./listings.ts");
  assert.match(src, /const holders = r\.holders > 0 \? r\.holders : null;/);
  assert.match(src, /dexvraScore\(\{[^}]*\bholders\s*\}\)/, "the score takes the null (neutral 0.5), not the fabricated 0");
  assert.match(src, /^\s*holders,$/m, "and so does the token");
  assert.ok(!/holders: r\.holders/.test(src), "no path hands the raw stored field on");
});

test("the token page asks /api/holders and renders through holdersCell", () => {
  const page = code("../app/(site)/token/[chain]/[address]/page.tsx");
  assert.match(page, /\/api\/holders\?/);
  // The PROPERTY, not a spelling: the Holders row renders through the one
  // owner, carries the reason as its tooltip, and the tooltip reaches the DOM.
  assert.match(page, /\["Holders",\s*holdersCell\(holders, t\.holders\)[^\]]*holdersTitle\(holders\)\]/);
  assert.match(page, /title=\{title\}/, "the tooltip is rendered, not merely computed");
  // A miss is asked ONCE more, and only after the route's miss memo lapses —
  // any sooner and the retry just reads the memo back.
  assert.match(page, /if \(j\.count == null && again\) retry = setTimeout\(\(\) => void ask\(false\), HOLDERS_RETRY_MS\)/);
  const retryMs = Number(page.match(/const HOLDERS_RETRY_MS = ([\d_]+)/)![1].replace(/_/g, ""));
  const missMs = Number(code("../app/api/holders/route.ts").match(/const MISS_MS = ([\d_]+)/)![1].replace(/_/g, ""));
  assert.ok(retryMs > missMs, `the retry (${retryMs}ms) outlasts the miss memo (${missMs}ms)`);
  assert.ok(!/fmtNum\(t\.holders\)/.test(page), "the raw field is never formatted directly again");
});

test("the route validates the chain BEFORE building a cache key, and never caches a miss where the count lives", () => {
  const route = code("../app/api/holders/route.ts");
  const guard = route.indexOf("!cfg || !safeAddress(address)");
  const key = route.indexOf("const key = `holders:");
  assert.ok(guard > 0 && key > guard, "validated first");
  assert.match(route, /throw new NoCount/, "a miss THROWS out of the loader, so cached() never stores it");
  assert.match(route, /holders-miss:/, "…and is remembered briefly under its own key");
});

test("⚠️ the tooltip says WHY there is no count — a bare '—' cannot be diagnosed", () => {
  assert.equal(holdersTitle(null), undefined, "not asked yet → no claim");
  assert.equal(holdersTitle({ count: null, why: "robinhoodchain.blockscout.com 404; dexscreener: io.dexscreener.com 403" }),
    "No holder count: robinhoodchain.blockscout.com 404; dexscreener: io.dexscreener.com 403");
  assert.equal(holdersTitle({ count: 1570, source: "blockscout", via: "explorer.mainnet.chain.robinhood.com", why: null }),
    "Measured by explorer.mainnet.chain.robinhood.com");
});
