// The token page's not-yet-listed state, and the route that feeds it.
//
// This is not an edge case: every buy-bot alert links to /token/<chain>/<ca>,
// the buy bot is free and runs on ANY contract, so for most arrivals this IS
// the token page. It used to be "Only paid listings appear here" and a Back
// button — a dead end on the one link that is supposed to sell a listing.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const PAGE = read("src/app/(site)/token/[chain]/[address]/page.tsx");
const COMPONENT = read("src/components/UnlistedToken.tsx");
const ROUTE = read("src/app/api/token-preview/route.ts");
const CSS = read("src/app/globals.css");

test("the token page routes an unknown contract to the unlisted view, not a dead end", () => {
  assert.match(PAGE, /if \(!t\) return <UnlistedToken chain=\{chain\} address=\{address\} \/>;/);
  assert.ok(!/Only paid listings appear here/.test(PAGE), "the dead end is gone");
});

test("the unlisted view answers the three questions a visitor arrives with", () => {
  // What is this · is it real · how do I get it listed.
  assert.match(COMPONENT, /Token Not Yet Listed/, "it says what state this is");
  assert.match(COMPONENT, /Contract address/i, "the CA, copyable");
  assert.match(COMPONENT, /Network/i, "the chain");
  assert.match(COMPONENT, /BOT_URL/, "and a way to list it");
  assert.match(COMPONENT, /Browse listed tokens/, "plus somewhere else to go");
});

test("it shows the live price and market cap it can get for an UNLISTED token", () => {
  // Fourtis shows $0.0115 / MC $11.04M on a token it has never listed, and it
  // is the reason the page reads as a product rather than a 404: the visitor
  // came from a buy alert and wants the number.
  assert.match(COMPONENT, /\/api\/token-preview\?chain=/);
  assert.match(COMPONENT, /fmtPrice\(tok\.priceUsd\)/);
  assert.match(COMPONENT, /fmtCap\(tok\.mcap\)/);
});

test("the chart does not depend on a listing either", () => {
  assert.match(COMPONENT, /geckoterminal\.com\/\$\{c\.geckoNetwork\}\/pools\/\$\{tok\.poolAddress\}/);
  assert.match(COMPONENT, /tok\?\.poolAddress && c\?\.geckoNetwork &&/, "and never renders an empty frame");
});

test("a contract the feed has never seen still renders the page", () => {
  // The skeleton is keyed off a `done` flag, not off the data. Keying it off
  // the data would spin forever on exactly the tokens this page exists for.
  assert.match(COMPONENT, /finally\(\(\) => live && setDone\(true\)\)/);
  assert.match(ROUTE, /if \(res\.status === 404\) return null;/, "404 is an answer, not an error");
});

test("the preview route bounds the address it puts into an upstream URL", () => {
  // It is interpolated into a GeckoTerminal path, so it is checked rather than
  // trusted — the same guard /api/pool uses.
  assert.match(ROUTE, /address\.length > 90 \|\| \/\[\^A-Za-z0-9:_-\]\/\.test\(address\)/);
  assert.match(ROUTE, /CHAINS\[chain\]\?\.geckoNetwork/, "and only serves chains the app supports");
});

test("a feed outage degrades to the useful half, never to an error screen", () => {
  const handler = ROUTE.slice(ROUTE.indexOf("export async function GET"));
  assert.match(handler, /catch \{[\s\S]*?NextResponse\.json\(\{ token: null, chain: null \}\)/, "still 200 with a null token");
});

test("the preview is cached — a shared alert must not hammer the upstream", () => {
  assert.match(ROUTE, /cached\(`preview:\$\{network\}:\$\{address\}`, TTL/);
});

test("the view is styled, and readable on a phone", () => {
  assert.match(CSS, /\.unlisted\{/);
  assert.match(CSS, /@media \(max-width:640px\)\{[\s\S]*?\.unlisted-h/, "the heading and chart scale down");
});

// ── Search · pasting a contract nobody has listed ────────────────────────────

const TOPBAR = read("src/components/Topbar.tsx");

test("a pasted CA that matches nothing locally is looked up, not refused", () => {
  // "No token matches 0xc111…" was both wrong — the token exists — and a dead
  // end, on the box people paste a CA into precisely because they saw it in a
  // buy alert.
  assert.match(TOPBAR, /\/api\/token-preview\?address=/);
  assert.match(TOPBAR, /Not Yet Listed/, "and it says which state the token is in");
});

test("the lookup only fires on a WHOLE address with no local match", () => {
  // It reaches the network. Firing it per keystroke of a ticker search that is
  // about to match locally is a request per character for nothing.
  assert.match(TOPBAR, /if \(!isCa \|\| matches\.length > 0\)/);
  assert.match(TOPBAR, /setTimeout\(\(\) => \{[\s\S]{0,400}?token-preview/, "debounced");
});

test("the row leads somewhere — the token page, on the chain that was found", () => {
  assert.match(TOPBAR, /router\.push\(to\)/);
  assert.match(TOPBAR, /`\/token\/\$\{probe\.chain\}\/\$\{encodeURIComponent\(homeQuery\.trim\(\)\)\}`/);
});

test("one address shape spans eight EVM chains, so they are probed in parallel", () => {
  // Sequentially this is eight round trips before the box can say anything.
  assert.match(ROUTE, /await Promise\.all\(\s*candidateChains\(address\)\.map/);
  assert.match(ROUTE, /hits\.sort\(\(a, b\) => \(b\.token\.mcap \?\? 0\) - \(a\.token\.mcap \?\? 0\)\)/, "ties break on market cap, not on a race");
});

test("sui is shape-tested before the plain EVM address", () => {
  const shapes = ROUTE.slice(ROUTE.indexOf("const SHAPES"), ROUTE.indexOf("const candidateChains"));
  assert.ok(shapes.indexOf('["sui"]') < shapes.indexOf('"ethereum"'), "both start 0x");
});

test("a chain with no GeckoTerminal network is never probed", () => {
  assert.match(ROUTE, /\.filter\(\(c\) => CHAINS\[c\]\?\.geckoNetwork\)/);
});

test("the not-yet-listed badge reads as an invitation, not a failure", () => {
  assert.match(CSS, /\.sdd-unlisted\{/);
  assert.ok(!/\.sdd-unlisted\{[^}]*#F76A85/.test(CSS), "not the error red used elsewhere");
});
