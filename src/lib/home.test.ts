// The homepage's selection rules. Every test here is a claim the page makes to
// somebody about to spend money, so each one fails on a plausible shortcut:
// sorting by change and slicing, `mcap ?? 0`, a silent `.slice(0, 10)`, and a
// count sort with no tie-break.
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOME_BOARD_ROWS,
  HOME_CHAIN_LIMIT,
  capped,
  chainCounts,
  freshness,
  inChain,
  movers,
  resolveChain,
  splitChains,
  topCoins,
} from "./home.ts";
import type { BoardToken, PeriodKey } from "./types.ts";

const PERIODS: PeriodKey[] = ["5m", "1h", "6h", "24h"];

function tok(p: {
  sym: string;
  chain?: string;
  chg?: number;
  mcap?: number | null;
  vol?: number;
  score?: number;
  listedMinutesAgo?: number;
}): BoardToken {
  const chg = p.chg ?? 0;
  const per = <T,>(v: T) => Object.fromEntries(PERIODS.map((k) => [k, v])) as Record<PeriodKey, T>;
  return {
    key: `${p.chain ?? "solana"}:${p.sym}`,
    chain: p.chain ?? "solana",
    address: p.sym,
    symbol: `$${p.sym}`,
    name: p.sym,
    logoUrl: null,
    emoji: "🪙",
    gradient: ["#000", "#111", "#222"],
    priceUsd: 1,
    mcap: p.mcap === undefined ? 1_000_000 : p.mcap,
    liq: 50_000,
    chg: per(chg),
    vol: per(p.vol ?? 1000),
    txns: per({ buys: 1, sells: 1 }),
    holders: 100,
    taxPct: 0,
    ageMinutes: 60,
    trend: [1, 2, 3],
    verified: false,
    source: "live",
    tier: "BRONZE",
    trendingRank: null,
    listedMinutesAgo: p.listedMinutesAgo ?? 60,
    score: p.score ?? 50,
    poolAddress: null,
    links: { website: null, twitter: null, telegram: null },
    overview: null,
  };
}

// ── the chain row ───────────────────────────────────────────────────────────

test("the chain row offers only chains that HAVE listings, most-populated first", () => {
  const counts = chainCounts([
    tok({ sym: "A", chain: "base" }),
    tok({ sym: "B", chain: "solana" }),
    tok({ sym: "C", chain: "solana" }),
    tok({ sym: "D", chain: "solana" }),
    tok({ sym: "E", chain: "base" }),
    tok({ sym: "F", chain: "tron" }),
  ]);
  assert.deepStrictEqual(counts, [
    { id: "solana", count: 3 },
    { id: "base", count: 2 },
    { id: "tron", count: 1 },
  ]);
  // 23 chains are registered; a filter for a chain with nothing on it is a
  // control that can only ever empty the board.
  assert.ok(!counts.some((c) => c.id === "aptos"));
});

test("equal counts break on the REGISTRY order, so the row cannot reshuffle between polls", () => {
  // /api/tokens is re-polled every 30s. With no tie-break, equal-count chains
  // sit in whatever order that poll happened to return and the pill moves out
  // from under the cursor — indistinguishable from a misclick.
  const a = chainCounts([tok({ sym: "A", chain: "tron" }), tok({ sym: "B", chain: "solana" })]);
  const b = chainCounts([tok({ sym: "B", chain: "solana" }), tok({ sym: "A", chain: "tron" })]);
  assert.deepStrictEqual(a, b, "same tokens, either arrival order, same row");
  assert.strictEqual(a[0].id, "solana", "registry order: Solana is first in CHAINS");
});

test("the row shows a handful and keeps the rest behind +N more", () => {
  const many = chainCounts(
    ["solana", "bsc", "ethereum", "base", "robinhood", "tron", "ton", "sui"].map((c, i) =>
      tok({ sym: `T${i}`, chain: c }),
    ),
  );
  const { shown, hidden } = splitChains(many);
  assert.strictEqual(shown.length, HOME_CHAIN_LIMIT);
  assert.strictEqual(hidden.length, many.length - HOME_CHAIN_LIMIT);
  assert.ok(HOME_CHAIN_LIMIT < 8, "the point is fewer pills than the page used to open with");
});

test("a chain that vanishes from a later poll falls back to All chains", () => {
  const counts = chainCounts([tok({ sym: "A", chain: "solana" })]);
  assert.strictEqual(resolveChain("solana", counts), "solana");
  // Delisted mid-session: without this the picker unmounts and the board is
  // stuck at zero rows with no control left on screen to reset it.
  assert.strictEqual(resolveChain("tron", counts), "all");
  assert.strictEqual(resolveChain("all", counts), "all");
});

test("the filter governs the whole market area from one control", () => {
  const list = [tok({ sym: "A", chain: "solana" }), tok({ sym: "B", chain: "base" })];
  assert.strictEqual(list.filter(inChain("all")).length, 2);
  assert.deepStrictEqual(list.filter(inChain("base")).map((t) => t.symbol), ["$B"]);
});

// ── movers ──────────────────────────────────────────────────────────────────

test("a Top Loser is DOWN — on a green day the card is empty, not the least-green token", () => {
  const green = [tok({ sym: "A", chg: 12 }), tok({ sym: "B", chg: 4 }), tok({ sym: "C", chg: 90 })];
  assert.deepStrictEqual(movers(green, "losers", "24h"), [], "nothing is down; say nothing");
  // The shortcut this replaces: sort ascending and slice — which would put $B
  // in a losers card while printing "+4.0%".
  const naive = [...green].sort((a, b) => a.chg["24h"] - b.chg["24h"]).slice(0, 3);
  assert.strictEqual(naive.length, 3, "…which is exactly what the naive form returns");
});

test("a Top Gainer is UP — a red day empties the gainers card rather than fake one", () => {
  const red = [tok({ sym: "A", chg: -3 }), tok({ sym: "B", chg: -40 })];
  assert.deepStrictEqual(movers(red, "gainers", "24h"), []);
  assert.deepStrictEqual(movers(red, "losers", "24h").map((t) => t.symbol), ["$B", "$A"]);
});

test("a flat token is in neither list", () => {
  const flat = [tok({ sym: "FLAT", chg: 0 })];
  assert.deepStrictEqual(movers(flat, "gainers", "24h"), []);
  assert.deepStrictEqual(movers(flat, "losers", "24h"), []);
});

test("movers read the SELECTED timeframe, not always 24h", () => {
  const t = tok({ sym: "A" });
  t.chg = { "5m": -2, "1h": 5, "6h": -1, "24h": 9 };
  assert.deepStrictEqual(movers([t], "gainers", "1h").map((x) => x.symbol), ["$A"]);
  assert.deepStrictEqual(movers([t], "gainers", "6h"), [], "down on 6h → not a gainer there");
  assert.deepStrictEqual(movers([t], "losers", "6h").map((x) => x.symbol), ["$A"]);
});

test("New Listings ranks by when it was LISTED here, not by pair age", () => {
  const old = tok({ sym: "OLD", listedMinutesAgo: 5 });
  old.ageMinutes = 20_000; // an established pair that listed five minutes ago
  const fresh = tok({ sym: "NEW", listedMinutesAgo: 400 });
  fresh.ageMinutes = 30;
  assert.deepStrictEqual(
    movers([fresh, old], "fresh", "24h").map((t) => t.symbol),
    ["$OLD", "$NEW"],
    "the product is paid listings — 'new' means new on Dexvra",
  );
});

test("a mover card holds enough rows to be worth scrolling", () => {
  const many = Array.from({ length: 40 }, (_, i) => tok({ sym: `T${i}`, chg: i + 1 }));
  const rows = movers(many, "gainers", "24h");
  assert.strictEqual(rows.length, 10);
  assert.strictEqual(rows[0].symbol, "$T39", "biggest first");
});

// ── Top Coins ───────────────────────────────────────────────────────────────

test("a market-cap ranking LEAVES OUT a token whose cap could not be read", () => {
  const list = [
    tok({ sym: "BIG", mcap: 9_000_000 }),
    tok({ sym: "UNKNOWN", mcap: null }),
    tok({ sym: "SMALL", mcap: 10_000 }),
  ];
  const { rows, unpriced } = topCoins(list, "mcap");
  assert.deepStrictEqual(rows.map((t) => t.symbol), ["$BIG", "$SMALL"]);
  assert.strictEqual(unpriced, 1, "and it is COUNTED — a row that vanishes silently is worse");
  // `mcap ?? 0` would have put $UNKNOWN last, reading as the smallest project
  // on the board rather than as one we could not price.
  assert.ok(!rows.some((t) => t.symbol === "$UNKNOWN"));
});

test("volume and score rankings keep an unpriced token — those figures are always real", () => {
  const list = [tok({ sym: "A", mcap: null, vol: 5000, score: 90 }), tok({ sym: "B", vol: 10, score: 10 })];
  assert.deepStrictEqual(topCoins(list, "vol").rows.map((t) => t.symbol), ["$A", "$B"]);
  assert.deepStrictEqual(topCoins(list, "score").rows.map((t) => t.symbol), ["$A", "$B"]);
  assert.strictEqual(topCoins(list, "vol").unpriced, 0, "nothing was dropped, so nothing is reported");
});

test("ties sort by ticker, so the ranking does not reorder itself between polls", () => {
  const list = [tok({ sym: "ZZZ", mcap: 100 }), tok({ sym: "AAA", mcap: 100 })];
  assert.deepStrictEqual(topCoins(list, "mcap").rows.map((t) => t.symbol), ["$AAA", "$ZZZ"]);
});

test("Top Coins ranks by the SELECTED period's volume", () => {
  const a = tok({ sym: "A" });
  const b = tok({ sym: "B" });
  a.vol = { "5m": 900, "1h": 1, "6h": 1, "24h": 1 };
  b.vol = { "5m": 1, "1h": 1, "6h": 1, "24h": 900 };
  assert.strictEqual(topCoins([a, b], "vol", "5m").rows[0].symbol, "$A");
  assert.strictEqual(topCoins([a, b], "vol", "24h").rows[0].symbol, "$B");
});

// ── caps ────────────────────────────────────────────────────────────────────

test("a cut list carries what was cut, so the page can say 'showing 10 of 43'", () => {
  const list = Array.from({ length: 43 }, (_, i) => i);
  const c = capped(list, HOME_BOARD_ROWS);
  assert.strictEqual(c.rows.length, HOME_BOARD_ROWS);
  assert.strictEqual(c.total, 43);
  assert.strictEqual(c.hidden, 33);
});

test("a short list is not a cut one", () => {
  const c = capped([1, 2, 3], HOME_BOARD_ROWS);
  assert.strictEqual(c.hidden, 0, "no 'View all' pressure on a page that is showing everything");
  assert.strictEqual(c.total, 3);
});

test("limit 0 means no cap at all — the full board pages stay full", () => {
  const c = capped([1, 2, 3], 0);
  assert.deepStrictEqual(c.rows, [1, 2, 3]);
  assert.strictEqual(c.hidden, 0);
});

// ── the live stamp ──────────────────────────────────────────────────────────

test("the live stamp never renders a negative age on a client whose clock is behind", () => {
  const now = 1_000_000;
  assert.strictEqual(freshness(now + 30_000, now), "0s ago");
  assert.strictEqual(freshness(now - 12_000, now), "12s ago");
  assert.strictEqual(freshness(now - 200_000, now), "3m ago");
  assert.strictEqual(freshness(undefined, now), "…", "no payload yet is not 'updated 0s ago'");
});

// ── the page wires all of it ────────────────────────────────────────────────

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

test("the homepage renders the movers, the trending board and Top Coins", () => {
  const page = read("src/app/(site)/page.tsx");
  for (const c of ["MarketMovers", "StdBoard", "TopCoinsBoard", "ChainFilter"])
    assert.match(page, new RegExp(`<${c}`), `${c} is on the page`);
});

test("the market area reads Trending, then the movers, then Top Coins", () => {
  // The ORDER is the operator's call, not an implementation detail: Trending
  // is the paid inventory and leads, the movers read under it, Top Coins
  // closes. Pinned because a reorder is a one-line edit nothing else would
  // notice, and one chain filter above all three governs whichever comes
  // first.
  const page = read("src/app/(site)/page.tsx");
  const at = (c: string) => page.indexOf(`<${c}`);
  assert.ok(at("ChainFilter") < at("StdBoard"), "the one chain filter sits above the market area");
  assert.ok(at("StdBoard") < at("MarketMovers"), "Trending leads");
  assert.ok(at("MarketMovers") < at("TopCoinsBoard"), "Top Coins is last");
});

test("no component builds its own chain list — chains.ts stays the one owner", () => {
  // "Adding a chain = adding one entry here. Nothing else in the app may
  // hardcode a chain id." The home filter derives its row from the DATA, which
  // is why a new chain needs no second edit.
  for (const f of [
    "src/components/MarketMovers.tsx",
    "src/components/TopCoins.tsx",
    "src/components/ChainFilter.tsx",
    "src/app/(site)/page.tsx",
  ]) {
    const src = read(f);
    assert.ok(
      !/"(solana|bsc|ethereum|robinhood)"/.test(src.replace(/chain === "all"/g, "")),
      `${f} names no chain id`,
    );
  }
});

// ── the grid arithmetic ─────────────────────────────────────────────────────
//
// A CSS grid whose column count disagrees with its child count does not error
// — it silently reflows the last cells onto a second line, which reads as a
// broken table and only on the screen width nobody tested. The first cut of
// this stylesheet had exactly that: `.c-num:nth-of-type(2)` counts DIVS, the
// second div is the token cell, so the selector matched nothing and the
// ≤760px rule declared five columns for seven children.

const CSS = read("src/app/globals.css");
const TOPCOINS = read("src/components/TopCoins.tsx");

/** Columns declared by the LAST `.tc-row{grid-template-columns:…}` at or above
 *  a width — the cascade means later rules win. */
function tcColumns(): { cols: number[]; hides: string[][] } {
  const cols: number[] = [];
  const hides: string[][] = [];
  const rowRe = /\.tc-row\{([^}]*)\}/g;
  for (let m = rowRe.exec(CSS); m; m = rowRe.exec(CSS)) {
    // the base rule declares `display:grid` before its columns
    const g = /grid-template-columns:([^;}]*)/.exec(m[1]);
    if (g) cols.push(g[1].trim().split(/\s+/).length);
  }
  // every class the narrow rules switch off, in source order
  const hideRe = /\.(tc-[a-z0-9]+)\{display:none\}/g;
  for (let m = hideRe.exec(CSS); m; m = hideRe.exec(CSS)) hides.push([m[1]]);
  return { cols, hides };
}

test("every breakpoint declares exactly as many columns as the row still has cells", () => {
  // The header is a flat list of cells and shares the grid with every row, so
  // counting it counts the row. The slice starts INSIDE the wrapper's tag, so
  // every `<div` it then finds is a cell.
  const head = TOPCOINS.slice(TOPCOINS.indexOf('className="tc-row tc-head"'));
  const block = head.slice(0, head.indexOf("</div>\n\n"));
  const total = (block.match(/<div/g) ?? []).length;
  assert.strictEqual(total, 7, "Coin, Price, 1h, period, Market Cap, DXS, and #");

  const { cols, hides } = tcColumns();
  assert.ok(cols.length >= 4, "a base rule plus the narrow ones");
  // Hiding is CUMULATIVE down the breakpoints, so column n = total - (hidden so far).
  let hidden = 0;
  cols.forEach((c, i) => {
    if (i > 0) hidden += hides[i - 1]?.length ?? 0;
    assert.strictEqual(c, total - hidden, `breakpoint ${i}: ${c} columns for ${total - hidden} cells`);
  });
});

test("the classes the narrow rules hide are classes the row actually renders", () => {
  // A typo'd selector hides nothing and fails silently — which is precisely
  // how the seven-cells-in-five-columns bug got written.
  for (const [cls] of tcColumns().hides)
    assert.match(TOPCOINS, new RegExp(`\\b${cls}\\b`), `.${cls} is on a real cell`);
});

test("the mover list is a fixed-height SCROLLER, not a card that grows", () => {
  // Three cards that grow to ten rows each push the trending board — the paid
  // inventory — off the fold, which is the opposite of what the page sells.
  const list = CSS.match(/\.mv-list\{[^}]*\}/)?.[0] ?? "";
  assert.match(list, /height:\d+px/, "a fixed height");
  assert.match(list, /overflow-y:auto/, "…that scrolls");
});

test("each mover accent states its own tint, so the three cards cannot collapse", () => {
  // The rail and the badge are the ONLY thing telling the three cards apart
  // before a number is read. Two accents resolving to one value is a card set
  // that looks like one card repeated.
  const tints = [...CSS.matchAll(/\.acc-[a-z]+\{([^}]*)\}/g)].map((m) => m[1]);
  assert.strictEqual(tints.length, 3, "gainers, losers, fresh");
  assert.strictEqual(new Set(tints).size, 3, "and no two are the same");
  for (const t of tints) for (const v of ["--acc:", "--accs:", "--accbg:", "--accbd:"])
    assert.ok(t.includes(v), `${v} is set — an unset var renders the badge invisible`);
});

test("Show all passes limit 0, and 0 means every row — not none", () => {
  // `.slice(0, 0)` is the empty array. The first cut sliced unconditionally, so
  // tapping "Show all 14" emptied the table and rendered the "nothing here has
  // a readable market cap" state over a board of fourteen priced tokens.
  const list = Array.from({ length: 14 }, (_, i) => tok({ sym: `T${i}`, mcap: 1000 + i }));
  assert.strictEqual(topCoins(list, "mcap", "24h", 0).rows.length, 14);
  assert.strictEqual(topCoins(list, "mcap", "24h", 10).rows.length, 10);
  // and the same contract on the other capper, so the two cannot disagree
  assert.strictEqual(capped(list, 0).rows.length, 14);
});
