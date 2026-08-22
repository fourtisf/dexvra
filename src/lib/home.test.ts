// The homepage's selection rules. Every test here is a claim the page makes to
// somebody about to spend money, so each one fails on a plausible shortcut:
// sorting by change and slicing, `mcap ?? 0`, a silent `.slice(0, 10)`, and a
// count sort with no tie-break.
import test from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOME_BOARD_ROWS,
  HOME_CHAIN_LIMIT,
  HOME_TRENDING_MAX,
  changeReading,
  expander,
  capped,
  chainCounts,
  freshness,
  inChain,
  movers,
  resolveChain,
  splitChains,
  topCoins,
} from "./home.ts";
import { CHAIN_IDS } from "../config/chains.ts";
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

test("the row shows a handful, and +N more reveals EVERY registered chain", () => {
  // The first cut hid chains with no listings entirely, which read as "Dexvra
  // only supports five chains" — the opposite of what the registry says. The
  // empties ride behind +N more at count 0, in registry order, so the row
  // still opens compact but the full chain list is one tap away (the Fourtis
  // shape the operator asked for).
  const many = chainCounts(
    ["solana", "bsc", "ethereum", "base", "robinhood", "tron", "ton", "sui"].map((c, i) =>
      tok({ sym: `T${i}`, chain: c }),
    ),
  );
  const { shown, hidden } = splitChains(many);
  assert.strictEqual(shown.length, HOME_CHAIN_LIMIT);
  assert.ok(shown.every((c) => c.count > 0), "what opens is the populated chains");
  assert.strictEqual(
    hidden.length,
    many.length - HOME_CHAIN_LIMIT + (CHAIN_IDS.length - many.length),
    "hidden = remaining populated + every registered empty chain",
  );
  const empties = hidden.filter((c) => c.count === 0);
  assert.strictEqual(empties.length, CHAIN_IDS.length - many.length);
  assert.ok(empties.every((c) => CHAIN_IDS.includes(c.id)), "empties come from the registry");
  const order = empties.map((c) => c.id);
  assert.deepStrictEqual(order, CHAIN_IDS.filter((id) => !many.some((m) => m.id === id)),
    "…in registry order, so the reveal is stable");
  assert.ok(HOME_CHAIN_LIMIT < 8, "the point is fewer pills than the page used to open with");
});

test("any REGISTERED chain is a legal selection — empty included", () => {
  const counts = chainCounts([tok({ sym: "A", chain: "solana" })]);
  assert.strictEqual(resolveChain("solana", counts), "solana");
  // An empty chain's pill is always on the row now, so selecting it is not a
  // dead end — the board shows the honest "nothing listed here yet".
  assert.strictEqual(resolveChain("tron", counts), "tron");
  // Only an id the registry has never heard of falls back — that pill cannot
  // exist, so keeping the filter would strand the board with no control.
  assert.strictEqual(resolveChain("dogechain", counts), "all");
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

test("every tc template declares exactly as many columns as the row has cells — none hidden", () => {
  // The header is a flat list of cells and shares the grid with every row, so
  // counting it counts the row. The slice starts INSIDE the wrapper's tag, so
  // every `<div` it then finds is a cell.
  const head = TOPCOINS.slice(TOPCOINS.indexOf('className="tc-row tc-head"'));
  const block = head.slice(0, head.indexOf("</div>\n\n"));
  const total = (block.match(/<div/g) ?? []).length;
  assert.strictEqual(total, 7, "Coin, Price, 1h, period, Market Cap, DXS, and #");

  const { cols, hides } = tcColumns();
  // Phones used to HIDE columns down a breakpoint ladder; the operator asked
  // for the reference's pattern instead ("top coin dan trending harus bisa di
  // scroll ke kanan"), so the ladder is GONE: every template carries the full
  // set and the board scrolls sideways. A reintroduced hide would silently
  // desync the phone template's column count again — that is what this pins.
  assert.strictEqual(hides.length, 0, "no tc column hides anywhere — phones scroll instead");
  assert.ok(cols.length >= 2, "the base rule plus the phone template");
  for (const [i, c] of cols.entries())
    assert.strictEqual(c, total, `template ${i}: ${c} columns for ${total} cells`);

  // …and the strategy that replaced hiding is pinned with it: a sideways
  // scroller whose identity column is STICKY, on both tables. Without the
  // sticky cell, a swiped table is columns of numbers belonging to nobody.
  assert.match(CSS, /\.tc-board\{[^}]*overflow-x:auto/, "Top Coins scrolls");
  assert.match(CSS, /\.board\{overflow-x:auto/, "the trending board scrolls");
  assert.match(CSS, /\.tc-row>\.tc-tok[^{]*\{position:sticky/, "Top Coins identity is sticky");
  assert.match(CSS, /\.board \.row>\.tok[^{]*\{position:sticky/, "board identity is sticky");
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

// ── the trending expander ───────────────────────────────────────────────────

test("the board opens on ten and grows to fifteen in place", () => {
  const e = expander(40, HOME_BOARD_ROWS, HOME_TRENDING_MAX);
  assert.strictEqual(e.collapsed, 10);
  assert.strictEqual(e.expanded, 15);
  assert.strictEqual(e.canExpand, true);
});

test("the button names the number it can actually deliver", () => {
  // "Show all 40" that stops at 15 is the silent cap wearing a label. The
  // promise is the number of rows the tap will really put on screen.
  assert.strictEqual(expander(40, 10, 15).reveal, 15);
  assert.strictEqual(expander(12, 10, 15).reveal, 12, "a short board promises what it has");
});

test("rows past the expander keep their way through to the full board", () => {
  assert.strictEqual(expander(40, 10, 15).beyond, 25, "…so the View all link stays");
  assert.strictEqual(expander(14, 10, 15).beyond, 0, "nothing left over — no link needed");
});

test("a board with nothing to expand offers no expander", () => {
  assert.strictEqual(expander(10, 10, 15).canExpand, false, "exactly full");
  assert.strictEqual(expander(4, 10, 15).canExpand, false, "short");
  assert.strictEqual(expander(0, 10, 15).canExpand, false, "empty");
});

test("expandTo of 0 means no expander — the full board pages stay full", () => {
  const e = expander(40, 40, 0);
  assert.strictEqual(e.canExpand, false);
  assert.strictEqual(e.expanded, 40, "and it caps nothing");
});

test("the homepage board is wired to the expander, not only to the link", () => {
  const page = read("src/app/(site)/page.tsx");
  assert.match(page, /expandTo=\{HOME_TRENDING_MAX\}/);
  assert.match(page, /expandNoun="trending"/);
  assert.match(page, /limit=\{HOME_BOARD_ROWS\}/);
});

test('"all" is a claim, and it is only made when it is true', () => {
  // 40 listings behind a bar reading "Show all 15" is the silent cap with a
  // label on it — the reader taps, gets fifteen, and has no reason to think
  // twenty-five more exist.
  assert.strictEqual(expander(14, 10, 15).showsAll, true, "everything fits → 'Show all 14'");
  assert.strictEqual(expander(40, 10, 15).showsAll, false, "…but 40 does not → 'Show 15'");
  assert.strictEqual(expander(15, 10, 15).showsAll, true, "exactly at the ceiling");
});

test("the board reports what the expander CANNOT reach, collapsed or open", () => {
  // Gated on the open state, a 40-listing board sat behind a bar offering
  // fifteen and said nothing about the other twenty-five until you tapped.
  const big = expander(40, 10, 15);
  assert.ok(big.beyond > 0, "so the 'Showing N of M · View all' line renders in BOTH states");
  const small = expander(14, 10, 15);
  assert.strictEqual(small.beyond, 0, "and never renders when nothing is left over");
});

// ── the premium pass ────────────────────────────────────────────────────────

test("loading is never rendered as an empty market", () => {
  // Before the first /api/tokens answer, the empty states are FALSE claims —
  // "Nothing is up on this timeframe" about a market nobody has read yet.
  // Every surface takes `loading` and shows a skeleton branch BEFORE its empty
  // copy can render; the page threads `!data` into all three.
  const page = read("src/app/(site)/page.tsx");
  assert.match(page, /<MarketMovers[^>]*loading=\{!data\}/s);
  assert.match(page, /<TopCoinsBoard[^>]*loading=\{!data\}/s);
  assert.match(page, /loading=\{!data\}[\s\S]*?limit=\{HOME_BOARD_ROWS\}|limit=\{HOME_BOARD_ROWS\}[\s\S]*?loading=\{!data\}/);

  const movers = read("src/components/MarketMovers.tsx");
  assert.ok(movers.indexOf("<MvSkeleton") < movers.indexOf("mv-empty"),
    "the skeleton branch is checked before the empty claim");
  const tc = read("src/components/TopCoins.tsx");
  // matched as JSX (`>Nothing…`), not as a bare string — the prop docblock
  // QUOTES the empty copy above the render, and indexOf found the quote first.
  assert.ok(tc.indexOf("<SkeletonRows") < tc.indexOf(">Nothing listed on this chain yet"),
    "same in Top Coins");
  const board = read("src/components/TokenBoard.tsx");
  assert.match(board, /loading \? \(\s*<SkeletonRows/, "and the board itself");
});

test("skeleton rows are not .row — the e2e's board wait must mean REAL rows", () => {
  // The smoke script waits on `.board .row:not(.head)`. A skeleton wearing
  // .row would satisfy that wait and every count after it would race the
  // first payload.
  const board = read("src/components/TokenBoard.tsx");
  const sk = board.slice(board.indexOf("export function SkeletonRows"), board.indexOf("function StdRow"));
  assert.ok(!/className="row/.test(sk), "skeletons use .skr, never .row");
});

test("ranks are drawn, not the OS emoji-of-the-day", () => {
  // The Pulse cards already state the rule for section glyphs; the medals were
  // the one OS-supplied glyph left on the board — Apple gold next to Windows
  // gold is two different products.
  const board = read("src/components/TokenBoard.tsx");
  assert.ok(!board.includes("🥇"), "no emoji medals in the renderer");
  assert.match(board, /medal medal-\$\{n\}/, "the drawn roundel");
  for (const m of ["medal-1", "medal-2", "medal-3"])
    assert.match(CSS, new RegExp(`\\.${m}\\{background:radial-gradient`), `${m} is painted`);
});

test("every animation the pass added obeys prefers-reduced-motion", () => {
  // ⚠️ Not via the kill list: this pass's rules are appended AFTER that block,
  // so a same-specificity kill there LOSES the cascade — the shimmer kept
  // animating under reducedMotion:"reduce" until this was measured. The
  // animations are instead DECLARED only under no-preference, which no source
  // order can undo.
  const gates = [...CSS.matchAll(/@media \(prefers-reduced-motion:no-preference\)\{([\s\S]*?)\}\n/g)]
    .map((m) => m[1]).join("\n");
  assert.ok(gates.includes(".sk::after{animation:"), "the shimmer is gated");
  assert.ok(gates.includes(".live-pill{animation:"), "the breathing pill is gated");
  // and no base rule re-attaches them outside the gate
  const ungated = CSS.replace(/@media \(prefers-reduced-motion:no-preference\)\{[\s\S]*?\}\n/g, "");
  assert.ok(!/\.sk::after\{[^}]*animation:skshimmer/.test(ungated));
  assert.ok(!/\.live-pill\{[^}]*animation:pillbreathe/.test(ungated));
});

test("every class a page still renders has a style — .board-loading kept its callers", () => {
  // It was deleted once as "dead" alongside a genuinely dead keyframe, while
  // the token page, trades, signals and new-listings still rendered it — four
  // unstyled loading states, caught by grepping for callers, not by any test.
  const users = [
    "src/components/TokenTrades.tsx",
    "src/app/(site)/token/[chain]/[address]/page.tsx",
    "src/app/(site)/signals/page.tsx",
    "src/app/(site)/new-listings/page.tsx",
  ].filter((f) => read(f).includes("board-loading"));
  if (users.length > 0)
    assert.match(CSS, /\.board-loading\{/, `still styled — rendered by ${users.join(", ")}`);
});

// ── the Moontok arrangement ─────────────────────────────────────────────────
//
// "saya ingin buat seperti moontok", said with a screenshot. The page opens
// on the INSTRUMENTS: the intel cards across the top (Pulse · Fear & Greed ·
// Signals — the reference's Moon-Satellite row), the banner placements, then
// straight into the trending board. No rotating hero, no editorial deck, no
// side rail — both earlier shapes were shown to the operator and rejected.

test("the home opens on the intel cards, then banners, then the board", () => {
  const page = read("src/app/(site)/page.tsx");
  const at = (m: string) => page.indexOf(m);
  assert.ok(at("<PulseStrip") > -1, "the intel row leads");
  assert.ok(at("<PulseStrip") < at("<HomeBannerStrip"), "banners under the instruments");
  assert.ok(at("<HomeBannerStrip") < at("<ChainFilter"), "…then the market area");
  // the rejected shapes must not creep back
  for (const dead of ["PromoCarousel", "HomeHero", "home-rail", "home-grid"])
    assert.ok(!page.includes(dead), `${dead} is retired`);
  for (const f of ["src/components/PromoCarousel.tsx", "src/components/HomeHero.tsx"])
    assert.ok(!existsSync(join(process.cwd(), f)), `${f} is out of the tree — a dead hero is the next "which one is real?"`);
  // nothing on the opening screen moves on its own — the autoplay carousel
  // stays dead whatever the skin does
  assert.ok(!/setInterval/.test(page), "no rotation timer on the page");
});

test("the skin is the BRAND BLUE accent, and the serif identity is fully retired", () => {
  // Two rejections shaped this: the gold + serif direction ("ini malah lebih
  // jelek"), then Moontok's violet corrected to the brand's own color
  // ("warnanya brandnya ya dexvra biru"). The accent word class survives in
  // markup (PageHead renders it), so it must be the two-tone accent — same
  // face, no italic — or every masthead still wears a rejected identity.
  const serif = CSS.match(/\.hero-serif\{[^}]*\}/)?.[0] ?? "";
  assert.match(serif, /font-family:var\(--fd\)/, "the accent word uses the display face");
  assert.match(serif, /font-style:normal/, "…not the italic");
  assert.ok(!/--acc:#E3C27E/.test(CSS), "the champagne gold accent is gone");
  assert.ok(!/--acc:#A06BFF/.test(CSS), "…and Moontok's violet with it");
  assert.match(CSS, /--acc:#26C6F5/, "the Dexvra cyan-blue is the one accent");
  // the pending/attention AMBER is a status color that predates every skin —
  // the accent rename collided with its token once, and blue pending chips
  // inside amber borders is the mismatch this pin keeps dead
  assert.match(CSS, /--amber:#FFD166/, "amber keeps its own token");
  assert.match(CSS, /\.a-status\.pending\{color:var\(--amber\)\}/, "pending states stay amber");
});

test("every page opens on the masthead grammar — the emoji chip is retired site-wide", () => {
  // "maksud saya SEMUA tampilan dirubah": the inner pages kept opening with
  // the old identity's emoji chip while the home moved on. PageHead is the
  // one owner of the masthead, so the chip's death is pinned there — and in
  // CSS, so a page that renders .page-ic by hand still shows nothing.
  const ph = read("src/components/PageHead.tsx");
  assert.ok(!ph.includes("page-ic"), "PageHead no longer renders the chip");
  assert.match(ph, /hero-serif/, "the serif accent is the shared signature");
  assert.match(CSS, /\.page-ic\{display:none\}/, "a stale chip anywhere renders nothing");
});

// ── the change a renderer may print ─────────────────────────────────────────

test("a fallback row's zero is a dash, never a fabricated ▲0.0%", () => {
  // A bot-listed launch an hour old carries chg 0 because nothing was measured
  // — not because anything was measured flat. "▲ 0.0%" on that row is the bot
  // repo's forbidden fabricated zero, on the web surface; the operator
  // reported it from production within a day ("new listing masa 0% semua").
  const fresh = tok({ sym: "NEW", chg: 0 });
  fresh.source = "seed";
  assert.strictEqual(changeReading(fresh, "24h"), null, "no reading → dash");

  const liveFlat = tok({ sym: "FLAT", chg: 0 });
  liveFlat.source = "live";
  assert.strictEqual(changeReading(liveFlat, "24h"), 0, "a MEASURED flat still prints");

  const demo = tok({ sym: "DEMO", chg: 12.5 });
  demo.source = "seed";
  assert.strictEqual(changeReading(demo, "24h"), 12.5, "captured nonzero prints — the demo board is built from these");
});

test("all three surfaces render the reading through the one helper", () => {
  // Three private copies of "may I print this zero?" is how the trending
  // board's fabricated-percentage saga went three rounds.
  for (const f of [
    "src/components/MarketMovers.tsx",
    "src/components/TokenBoard.tsx",
    "src/components/TopCoins.tsx",
  ])
    assert.match(read(f), /changeReading\(/, `${f} uses changeReading`);
});
