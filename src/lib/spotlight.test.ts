// The home spotlight ("minimal 9 atau 10") and the header's market line. Each
// test fails on a plausible shortcut: slicing the board's first ten rows,
// padding to ten with rows nobody could rank, ordering the paid inventory by
// whatever the poll returned, and printing "0 txns" over a board nobody priced.
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPOTLIGHT_SIZE, featuredSlots, marketTotals, spotlight } from "./home.ts";
import type { BoardToken, ListingTier, PeriodKey } from "./types.ts";

const PERIODS: PeriodKey[] = ["5m", "1h", "6h", "24h"];

function tok(p: {
  sym: string;
  chg?: number;
  vol?: number;
  tier?: ListingTier;
  slot?: number | null;
  source?: "live" | "seed";
  tx?: number;
}): BoardToken {
  const per = <T,>(v: T) => Object.fromEntries(PERIODS.map((k) => [k, v])) as Record<PeriodKey, T>;
  const tx = p.tx ?? 2;
  return {
    key: `solana:${p.sym}`,
    chain: "solana",
    address: p.sym,
    symbol: `$${p.sym}`,
    name: p.sym,
    logoUrl: null,
    emoji: "🪙",
    gradient: ["#000", "#111", "#222"],
    priceUsd: 1,
    mcap: 1_000_000,
    liq: 50_000,
    chg: per(p.chg ?? 1),
    vol: per(p.vol ?? 50_000),
    txns: per({ buys: Math.ceil(tx / 2), sells: Math.floor(tx / 2) }),
    holders: 100,
    taxPct: 0,
    ageMinutes: 60,
    trend: [1, 2, 3],
    verified: false,
    source: p.source ?? "live",
    tier: p.tier ?? "BRONZE",
    trendingRank: p.slot ?? null,
    listedMinutesAgo: 60,
    score: 50,
    poolAddress: null,
    links: { website: null, twitter: null, telegram: null },
    overview: null,
  };
}

const syms = (l: BoardToken[]) => l.map((t) => t.symbol.slice(1));

test("the spotlight carries ten — not the three the podium did", () => {
  assert.strictEqual(SPOTLIGHT_SIZE, 10);
  const many = Array.from({ length: 30 }, (_, i) => tok({ sym: `T${i}`, chg: i }));
  assert.strictEqual(spotlight(many).length, 10);
});

test("booked Trending slots lead, in package order, before any top-up", () => {
  const list = [
    tok({ sym: "MOON", chg: 900 }), // the biggest mover, but nobody booked it
    tok({ sym: "XP", tier: "XPRESS", slot: 1, chg: -20 }),
    tok({ sym: "BRZ", tier: "BRONZE", slot: 1 }),
    tok({ sym: "DIA", tier: "DIAMOND", slot: 1, chg: -5 }),
    tok({ sym: "GLD", tier: "GOLD", slot: 1 }),
  ];
  const out = syms(spotlight(list));
  assert.deepStrictEqual(out.slice(0, 4), ["DIA", "GLD", "BRZ", "XP"], "Diamond first, the unranked packages after every ranked tier");
  assert.strictEqual(out[4], "MOON", "…and the ranking only fills what is left");
});

test("the top-up never chooses a row the board could not rank", () => {
  const list = [
    tok({ sym: "UP", chg: 40 }),
    tok({ sym: "DUST", chg: 400, vol: 0.05 }), // a percentage with no trading behind it
    tok({ sym: "ABSURD", chg: 5_000_000 }), // unreadable, not a record gain
  ];
  assert.deepStrictEqual(syms(spotlight(list)), ["UP"], "a short market renders a short spotlight — it is never padded");
});

test("a booked slot is shown whatever its percentage — somebody paid for that card", () => {
  const out = syms(spotlight([tok({ sym: "PAID", tier: "SILVER", slot: 2, chg: 5_000_000 })]));
  assert.deepStrictEqual(out, ["PAID"]);
});

test("ties in the paid order break on identity, never on the poll's order", () => {
  const a = [tok({ sym: "BBB", tier: "GOLD", slot: 1 }), tok({ sym: "AAA", tier: "GOLD", slot: 1 })];
  assert.deepStrictEqual(syms(featuredSlots(a)), syms(featuredSlots([...a].reverse())));
});

test("ten booked slots fill the spotlight on their own", () => {
  const booked = Array.from({ length: 12 }, (_, i) => tok({ sym: `B${i}`, tier: "GOLD", slot: i + 1 }));
  const out = spotlight([tok({ sym: "MOON", chg: 900 }), ...booked]);
  assert.strictEqual(out.length, 10);
  assert.ok(!syms(out).includes("MOON"), "no top-up while the paid inventory alone fills it");
});

test("the /trending rail and the spotlight read ONE paid-slot comparator", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const page = strip(readFileSync(join(process.cwd(), "src/app/(site)/trending/page.tsx"), "utf8"));
  assert.match(page, /featuredSlots\(/, "the rail goes through the shared order");
  assert.ok(!/tierRank\(/.test(page), "…and keeps no private copy of it");
});

test("the market line's txns total is null when nothing in it was measured", () => {
  assert.strictEqual(marketTotals([tok({ sym: "A", source: "seed", tx: 0 })]).txns24h, null, "a captured zero is not a reading");
  assert.strictEqual(marketTotals([tok({ sym: "A", tx: 0 })]).txns24h, 0, "…a live zero is");
  assert.deepStrictEqual(marketTotals([tok({ sym: "A", tx: 4 }), tok({ sym: "B", tx: 6 })]), { txns24h: 10, listed: 2 });
});
