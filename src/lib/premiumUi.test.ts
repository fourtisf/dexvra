// The premium pass, as it finally shipped: DEXVRA ATELIER (the figures in
// Inter, one 40px header) under DEXVRA DATA (flat, dense, DexScreener as the
// reference — "still looks bad" retired the hero, the bento and the podium),
// under DEXVRA TERMINAL (mockup A: the rail, the market line, the terminal
// table, the ten-card spotlight). These pin the rules that are easy to lose
// silently; the look itself is judged from screenshots.
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const CSS = read("src/app/globals.css");

test("a logo that failed before hydration falls back to the monogram", () => {
  // React attaches onError at hydration; a server-rendered <img> that 404s
  // first keeps the broken-image glyph for good. Both discs read it on mount.
  for (const f of ["src/components/Coin.tsx", "src/components/Ticker.tsx"]) {
    const src = strip(read(f));
    assert.match(src, /\.complete && \w+\.naturalWidth === 0/, `${f} reads a pre-hydration failure`);
    assert.match(src, /coin-mono/, `${f} falls back to the monogram, not to nothing`);
  }
});

test("the previews are gone — nothing ships as a skin switcher, and no retired shape is left", () => {
  assert.ok(!/data-skin/.test(CSS), "no scoped preview skins left in the stylesheet");
  const page = strip(read("src/app/(site)/page.tsx"));
  for (const dead of ["DexvraHero", "SpaceHero", "TrendingPodium", "bento"])
    assert.ok(!page.includes(dead), `${dead} was rejected and is not on the page`);
});

test("on phones the sticky identity cells paint exactly the board's colour", () => {
  // The token column sits in a visible box whenever the sticky cells and the
  // board disagree — so the LAST layer must set both from the same token.
  const at = CSS.indexOf("DEXVRA DATA");
  assert.ok(at > 0, "the data layer exists (vacuity guard)");
  const layer = CSS.slice(at);
  const phone = layer.slice(layer.indexOf("@media (max-width:600px){"));
  assert.match(phone, /\.board,\.tc-board\{background:var\(--x-panel\)\}/, "the board is the panel token");
  assert.match(phone, /\.board \.row>\.tok,\.tc-row>\.tc-tok\)\{background:var\(--x-panel\)/, "the token cell is the same token");
  assert.match(phone, /\.board \.row>\.rank,\.tc-row>\.tc-rank\)\{background:var\(--x-panel\)/, "…and the rank cell");
  assert.match(phone, /\.row\.head,\.tc-row\.tc-head\{background:var\(--x-head\)\}/, "the head row is the head token");
  assert.match(phone, /\.board \.row\.head>:nth-child\(2\),\.tc-row\.tc-head>:nth-child\(2\)\)\{background:var\(--x-head\)/, "…and so are its sticky cells");
});

test("every face the font URL loads is one the stylesheet draws with", () => {
  // A family in the URL that no rule uses is a download for no glyph — which
  // is exactly what Instrument Serif was, and then Archivo.
  const layout = read("src/app/layout.tsx");
  const url = /const FONT_CSS =\s*"([^"]+)"/.exec(layout)?.[1] ?? "";
  const families = [...url.matchAll(/family=([^:&]+)/g)].map((m) => decodeURIComponent(m[1]).replace(/\+/g, " "));
  assert.ok(families.length >= 2, "the URL was parsed (vacuity guard)");
  for (const f of families) assert.match(CSS, new RegExp(`'${f}'`), `${f} is loaded and must be drawn with`);
  assert.ok(!families.includes("Archivo") && !families.includes("Instrument Serif"), "retired faces are not downloaded");
});

test("the primary action draws its bolt — no OS emoji in the header", () => {
  const topbar = strip(read("src/components/Topbar.tsx"));
  assert.ok(!topbar.includes("⚡"), "no emoji bolt");
  assert.match(topbar, /className="cta-ic"/);
});

const TERM = CSS.slice(CSS.indexOf("DEXVRA TERMINAL"));

test("the one search input can be pinned into the rail — nothing above it makes a containing block", () => {
  // position:fixed is placed against the VIEWPORT only while no ancestor has a
  // transform, filter or backdrop-filter. The header had a blur, which would
  // have pinned the search to the header's own box instead.
  assert.ok(TERM.length > 100, "the terminal layer exists (vacuity guard)");
  assert.match(TERM, /\.topbar\{backdrop-filter:none;-webkit-backdrop-filter:none/, "the header's blur is off at every width");
  assert.match(TERM, /\.topbar \.search-wrap\{position:fixed/, "…and the search is pinned at desktop widths");
  // ⚠️ and the rail paints BELOW the header: the header is a stacking context
  // (z-index 60), so its pinned child can rise no higher than the header does.
  // With the rail at 61 the input sat in the DOM, focusable and invisible.
  const z = Number(/\.rail\{position:fixed[^}]*z-index:(\d+)/.exec(TERM)?.[1]);
  assert.ok(Number.isFinite(z) && z < 60, `rail z-index ${z} must sit under the header's 60`);
  assert.match(strip(read("src/components/Rail.tsx")), /className="rail-search-slot"/, "the rail keeps an empty slot, never a second input");
  assert.ok(!/<input/.test(strip(read("src/components/Rail.tsx"))), "one search input on the site, not two");
});

test("every terminal template declares the row's fifteen cells", () => {
  const cells = 15; // # · token · price · listed · txns · volume · buys/sells · 5m 1h 6h 24h · liq · mcap · dxs · star
  const templates = [...TERM.matchAll(/\.board\.term \.row\{grid-template-columns:([^;]+);/g)].map((m) => m[1].trim().split(/\s+(?![^(]*\))/).length);
  assert.ok(templates.length >= 2, "desktop and phone templates (vacuity guard)");
  for (const n of templates) assert.strictEqual(n, cells, `a template declares ${n} tracks for ${cells} cells`);
  const board = strip(read("src/components/TokenBoard.tsx"));
  const head = board.slice(board.indexOf("function TermHead"), board.indexOf("function NpRow"));
  // from INSIDE the wrapper's tag, so the wrapper and the `col` helper's own
  // template are not counted: what is left is one entry per rendered cell —
  // the plain cells, the `col(…)` calls, and the four moves of one map
  const jsx = head.slice(head.indexOf('className="row head"'));
  const plain = (jsx.match(/<div(?![^>]*key=\{p\})/g) ?? []).length;
  const counted = plain + (jsx.match(/\{col\(/g) ?? []).length + 4;
  assert.strictEqual(counted, cells, "the head renders exactly as many cells as the templates declare");
});

test("every chain draws its own official mark, as an image", () => {
  // The marks used to be hand-drawn guesses (a quill, a bear face, a letter on
  // a disc) — "logonya benerin logo chainnya". Every chain in the registry has
  // the brand's own file, and the component draws THAT file.
  const chains = strip(read("src/config/chains.ts"));
  const ids = [...chains.slice(chains.indexOf("CHAINS")).matchAll(/^\s{2}([a-z0-9]+): \{$/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 20, `the registry scan found the chains (${ids.length})`);
  const logo = strip(read("src/components/ChainLogo.tsx"));
  for (const id of ids) {
    const svg = readFileSync(join(process.cwd(), "public/chains", `${id}.svg`), "utf8");
    assert.match(svg, /^<svg[^>]*viewBox="0 0 24 24"/, `${id} ships a 24-unit mark`);
    assert.ok(!/<script|<image|href=|on[a-z]+=/i.test(svg), `${id}'s file carries nothing but paths`);
    assert.match(logo, new RegExp(`"${id}"`), `${id} is in the component's list of marks`);
  }
  // ⚠️ inline marks share ONE id space per page and the first copy wins — a
  // hidden first copy painted every Solana mark blank. An <img> has its own.
  assert.ok(!/<svg|<path|linearGradient|url\(#/.test(logo), "no mark is drawn inline");
  assert.match(logo, /<img src=\{src\}/, "the mark is an image of the chain's own file");
  assert.ok(!/ChainLogoDefs/.test(strip(read("src/app/layout.tsx"))), "no shared paint server is left at the root");
  assert.match(strip(read("src/components/Rail.tsx")), /<Logo[^>]*gid="dxvRailMark"/, "the rail's brand mark has its own gradient id");
});

test("the tidy pass: one table design, centred form pages, drawn icons on actions", () => {
  const board = strip(read("src/components/TokenBoard.tsx"));
  assert.match(board, /variant = "terminal"/, "every board draws the terminal table unless a page opts out");
  const head = board.slice(board.indexOf("function TermHead"), board.indexOf("function NpRow"));
  assert.match(head, /sortable \?/, "a board whose page owns the order gets a plain head, not a lit column it does not follow");
  for (const f of ["alerts", "scanner", "account", "signals", "install"])
    assert.match(read(`src/app/(site)/${f}/page.tsx`), /<section className="view narrow">/, `${f} is a centred column`);
  assert.match(TERM, /\.view\.narrow\{[^}]*margin:0 auto/, "…centred in the space beside the rail");
  // emoji on a primary action is the OS's glyph of the day; the medals' rule
  for (const [f, label] of [["alerts", "Create alert"], ["scanner", "Scan token"], ["account", "List my token"]]) {
    const src = strip(read(`src/app/(site)/${f}/page.tsx`));
    const at = src.indexOf(label);
    assert.ok(at > -1, `${label} is on ${f}`);
    assert.ok(!/\p{Extended_Pictographic}/u.test(src.slice(Math.max(0, at - 160), at + label.length)), `${label} carries no emoji`);
  }
});
