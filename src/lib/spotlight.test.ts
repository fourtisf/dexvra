// The home spotlight ("minimal 9 atau 10") and the header's market line. Each
// test fails on a plausible shortcut: slicing the board's first ten rows,
// padding to ten with rows nobody could rank, ordering the paid inventory by
// whatever the poll returned, and printing "0 txns" over a board nobody priced.
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPOTLIGHT_SIZE, featuredSlots, hasCardPrice, marketTotals, spotlight, spotlightTier } from "./home.ts";
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
  listed?: number;
  price?: number;
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
    priceUsd: p.price ?? 1,
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
    listedMinutesAgo: p.listed ?? 60,
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
  assert.deepStrictEqual(out.slice(0, 4), ["DIA", "GLD", "BRZ", "XP"], "Diamond first, Xpress after every ranked tier");
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

test("a package somebody BOUGHT leads a slot the bot booked for itself", () => {
  // Xpress and Free used to tie at the back, so the order between a paid Xpress
  // slot and a bot-booked free one fell to the token key — i.e. to chance.
  const list = [tok({ sym: "AAA", tier: "FREE", slot: 1, chg: 300 }), tok({ sym: "ZZZ", tier: "XPRESS", slot: 9, chg: -40 })];
  assert.deepStrictEqual(syms(featuredSlots(list)), ["ZZZ", "AAA"]);
  assert.deepStrictEqual(syms(featuredSlots([...list].reverse())), ["ZZZ", "AAA"]);
});

test("each card names the package it bought, where it used to say Featured", () => {
  // "feature ini diganti … diamond gold platinum … yang express ya tulis express"
  const old = 30 * 24 * 60; // a month — far past the board's 48h tag
  assert.strictEqual(spotlightTier(tok({ sym: "D", tier: "DIAMOND", slot: 1, listed: old })), "DIAMOND", "a booked slot names its package for as long as it holds the slot");
  assert.strictEqual(spotlightTier(tok({ sym: "P", tier: "PLATINUM", slot: 2, listed: old })), "PLATINUM");
  assert.strictEqual(spotlightTier(tok({ sym: "X", tier: "XPRESS", slot: 3, listed: old })), "XPRESS", "…Xpress included");
  assert.strictEqual(spotlightTier(tok({ sym: "F", tier: "FREE", slot: 4 })), "XPRESS", "the bot's FREE listing reads as Xpress");
});

test("every card names its package, at any age — no 48h window, no blank FREE", () => {
  // "yang free listing juga harus ada … misal FREE ya itu Xpress atau Gold
  // Bronze Platinum, ya tulis aja sesuai dengan packagenya"
  assert.strictEqual(spotlightTier(tok({ sym: "G", tier: "GOLD", listed: 10 })), "GOLD");
  assert.strictEqual(spotlightTier(tok({ sym: "G", tier: "GOLD", listed: 3 * 24 * 60 })), "GOLD", "three days old still names Gold");
  assert.strictEqual(spotlightTier(tok({ sym: "B", tier: "BRONZE", listed: 90 * 24 * 60 })), "BRONZE");
  assert.strictEqual(spotlightTier(tok({ sym: "F", tier: "FREE", listed: 10 })), "XPRESS");
  assert.strictEqual(spotlightTier(tok({ sym: "F", tier: "FREE", listed: 30 * 24 * 60 })), "XPRESS");
});

test("publicTier is display only: FREE shows as Xpress, the paid order still knows it is free", async () => {
  const { publicTier } = await import("./packages.ts");
  for (const k of ["DIAMOND", "GOLD", "PLATINUM", "SILVER", "BRONZE", "XPRESS"]) assert.strictEqual(publicTier(k), k);
  assert.strictEqual(publicTier("FREE"), "XPRESS");
  // A bot-booked FREE slot still sits after a slot somebody bought as Xpress.
  const list = [tok({ sym: "AAA", tier: "FREE", slot: 1 }), tok({ sym: "ZZZ", tier: "XPRESS", slot: 9 })];
  assert.deepStrictEqual(syms(featuredSlots(list)), ["ZZZ", "AAA"]);
});

test("the tag draws through publicTier and nothing hides it any more", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const tag = strip(readFileSync(join(process.cwd(), "src/components/TierTag.tsx"), "utf8"));
  assert.match(tag, /publicTier\(tier\)/, "the chip names the public package");
  assert.ok(!/return null/.test(tag), "no tier and no age makes the chip disappear");
  const pkgs = strip(readFileSync(join(process.cwd(), "src/lib/packages.ts"), "utf8"));
  assert.ok(!/TIER_TAG_MAX_MIN/.test(pkgs), "the 48h window is gone, not just unused");
  for (const f of [
    "src/components/TokenBoard.tsx",
    "src/components/TopCoins.tsx",
    "src/app/(site)/new-listings/page.tsx",
    "src/app/(site)/trending/page.tsx",
    "src/app/(site)/token/[chain]/[address]/page.tsx",
  ]) {
    const src = strip(readFileSync(join(process.cwd(), f), "utf8"));
    assert.match(src, /<TierTag /, `${f} still draws the tag`);
    assert.ok(!/ageMinutes=/.test(src), `${f} passes no age to hide it`);
  }
});

test("the spotlight draws the package through the board's own TierTag, and no Featured pill", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const src = strip(readFileSync(join(process.cwd(), "src/components/Spotlight.tsx"), "utf8"));
  assert.match(src, /spotlightTier\(t\)/, "the rule has one owner, in lib/home");
  assert.match(src, /<TierTag tier=\{pkg\}/, "one chip design for a package, here and on the board");
  assert.ok(!/>\s*Featured\s*</.test(src) && !/spot-feat/.test(src), "the bare Featured pill is gone");
});

test("a booked slot nobody has priced gets no card — it would read — · MC — · Vol —", () => {
  // "mengapa jovi masih ada di trending spotlight — no logo no vol no token":
  // $JOVI held a Diamond slot and led as card #4 with a dash in every figure.
  const list = [
    tok({ sym: "JOVI", tier: "DIAMOND", slot: 1, source: "seed", price: 0, chg: 0, tx: 0 }),
    tok({ sym: "GLD", tier: "GOLD", slot: 1 }),
    tok({ sym: "UP", chg: 40 }),
  ];
  assert.deepStrictEqual(syms(spotlight(list)), ["GLD", "UP"]);
  assert.deepStrictEqual(syms(featuredSlots(list)), ["GLD"], "the /trending rail reads the same rule");
});

test("a captured-at-listing price still counts, so the demo board keeps its spotlight", () => {
  assert.strictEqual(hasCardPrice(tok({ sym: "D", source: "seed", price: 0.0042 })), true);
  assert.strictEqual(hasCardPrice(tok({ sym: "Z", source: "seed", price: 0 })), false, "a captured zero is not a price");
  assert.strictEqual(hasCardPrice(tok({ sym: "L", source: "live", price: 0 })), false, "no market prices at zero");
  assert.strictEqual(hasCardPrice(tok({ sym: "N", price: Number.NaN })), false);
});

test("the top-up keeps the same rule — no card whose price is a dash", () => {
  const list = [tok({ sym: "NOPX", chg: 80, price: 0, source: "seed" }), tok({ sym: "UP", chg: 20 })];
  assert.deepStrictEqual(syms(spotlight(list)), ["UP"]);
});

test("the /trending rail prints readings, never the raw fields", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const page = strip(readFileSync(join(process.cwd(), "src/app/(site)/trending/page.tsx"), "utf8"));
  assert.ok(!/fmtPrice\(t\.priceUsd\)/.test(page), "the price goes through figureReading");
  assert.ok(!/t\.chg\[/.test(page), "the change goes through changeReading");
  assert.match(page, /figureReading\(t, t\.priceUsd\)/);
  assert.match(page, /changeReading\(t, "24h"\)/);
});
