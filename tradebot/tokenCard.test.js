// The scan card next to Maestro's: ours printed bare fragments — "LP burned"
// alone on a line, "Liq 0.02 ETH" with nothing to compare it against — and when
// a data source returned nothing it silently dropped whole lines, so a token on
// a chain with no indexer rendered three lines and read like a broken bot rather
// than a thin token.
//
// These tests run the card's REAL text-building block against fixtures, so the
// layout is checked, not just the presence of a string somewhere in the file.
const fs = require("node:fs");
const path = require("node:path");

const test = require("node:test");
const assert = require("node:assert");

const SRC = fs.readFileSync(path.join(__dirname, "telegram.js"), "utf8");

/** The card's header + market block, lifted verbatim and run against a fixture.
 *  Slicing the source keeps this honest: it cannot pass against a copy of the
 *  code that has drifted from what the bot sends. */
function render(f) {
  const start = SRC.indexOf("  // ── Header: name · symbol");
  const end = SRC.indexOf("  const valueEth = bal * px;");
  assert.ok(start > -1 && end > start, "the card's market block moved — update the markers here");
  const block = SRC.slice(start, end)
    .split("\n")
    .filter((l) => !/^\s*(const sel =|const selIds =|const selN =|const usdOf =)/.test(l))
    .join("\n");
  const L = [];
  const gap = () => { if (L.length && L[L.length - 1] !== '') L.push(''); };
  const SEP = "━━━━━━━━━━━━━━━━";
  const { info, ch, api, sec, name, sym, nat, px, priceUsd, ca } = f;
  const esc = (x) => String(x);
  const fmt = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(2) + "M"; if (n >= 1e3) return (n / 1e3).toFixed(2) + "K"; return n.toFixed(n < 1 ? 4 : 2); };
  const nativeUsd = () => f.rate;
  const usd = (a) => "$" + fmt(Number(a) * f.rate);
  const taxStr = (v) => (v == null ? "?" : `${Number(v).toFixed(0)}%`);
  const fmtAge = (ms) => { const s = Math.floor((Date.now() - ms) / 1000); if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h"; return Math.floor(s / 86400) + "d"; };
  const safety = { verdict: () => ({ level: "ok" }) };
  const chainKey = ch.key;
  void chainKey; void safety; void esc; void fmt; void nativeUsd; void usd; void taxStr; void fmtAge; void SEP;
  void info; void ch; void api; void sec; void name; void sym; void nat; void px; void priceUsd; void ca;
  eval(block);
  return L.join("\n");
}
const plain = (s) => s.replace(/<\/?(b|i|code|a)[^>]*>/g, "");

const ROBINHOOD = {
  rate: 1820, nat: "ETH", ca: "0x1E3a870326C9c1ed08558e75d2C8c2b884EdE280",
  name: "Portfi.fun", sym: "PORTFI", px: 0.00000000142, priceUsd: 0.00000259,
  ch: { key: "robinhood", name: "Robinhood Chain", emoji: "🪶", curve: true, native: "ETH" },
  api: null, sec: null,
  info: { dex: true, dexVenue: "v3", graduated: true, mcapEth: 1.42, liquidityNative: 0.02, market: null, gas: { gwei: 0.045, feeNative: 0.0000135 } },
};
const FULL = {
  rate: 1820, nat: "ETH", ca: "0x4200000000000000000000000000000000000042",
  name: "Higher", sym: "HIGHER", px: 0.0000412, priceUsd: 0.075,
  ch: { key: "base", name: "Base", emoji: "🔵", curve: false, native: "ETH" },
  api: null,
  sec: { holders: 4128, lpLockedPct: 100, buyTaxPct: 0, sellTaxPct: 0, honeypot: false, openSource: true },
  info: {
    dex: true, dexVenue: "v3", mcapEth: 4120, liquidityNative: 210.4,
    market: { volH24Usd: 1284000, chgH1: 3.4, chgH24: -12.8, buysH24: 1840, sellsH24: 1620, liqUsd: 383000, createdAt: Date.now() - 86400000 * 91 },
    gas: { gwei: 0.021, feeNative: 0.0000063 },
  },
};

test("every value on the card says what it is", () => {
  // The old card's second line was literally "Liq 0.02 ETH ($36.39)" followed by
  // a line reading only "LP burned". A reader had to already know the format.
  const out = plain(render(FULL));
  for (const label of ["Price", "Mcap", "Liquidity", "Change", "Vol 24h", "holders", "Tax", "Gas", "Updated"]) {
    assert.ok(out.includes(label), `no "${label}" label:\n${out}`);
  }
  // No line may be a bare value with no word in front of it.
  for (const line of out.split("\n").slice(3)) {
    if (!line || line.startsWith("━")) continue;
    assert.match(line, /[A-Za-z]{3,}/, `a line with no label: ${line}`);
  }
});

test("liquidity is shown against the market cap — the number people actually need", () => {
  // $36 of liquidity under a $2.59K cap is the entire story of a token, and the
  // card used to leave the reader to do that division themselves.
  const out = plain(render(ROBINHOOD));
  assert.match(out, /Liquidity 0\.020 ETH \(\$36\.40\)\s+·\s+1\.4% of mcap/, out);
  // Decimals follow the magnitude: 0.020 and 210.4 must both read cleanly.
  assert.match(plain(render(FULL)), /Liquidity 210\.4 ETH/, "a big pool must not print six digits");
});

test("a chain with no indexer says so instead of rendering a stub", () => {
  // THE fix. Robinhood has no DexScreener and no GoPlus, so volume, change and
  // holders were simply absent — and an absent line is indistinguishable from a
  // broken bot.
  const out = plain(render(ROBINHOOD));
  assert.match(out, /No indexer covers Robinhood Chain yet — volume, price change and holder count unavailable/, out);
  assert.match(out, /read straight from the chain/, "…and it must say the prices ARE real");
  // The note appears only when something is genuinely missing.
  assert.ok(!plain(render(FULL)).includes("No indexer"), "a fully-covered token must not be apologised for");
});

test("the card carries a timestamp, because a scan is a moment in time", () => {
  // Maestro's own card prints "Updated | Jul 26 14:49:08" — and in the
  // side-by-side that timestamp was 14 minutes stale, which was the whole reason
  // its numbers disagreed with ours. Ours are fetched on render; saying so is
  // what makes a moving price trustworthy.
  const out = plain(render(FULL));
  assert.match(out, /Updated \d{2}:\d{2}:\d{2} UTC · tap 🔄 Refresh/, out);
});

test("what a trade costs is on the card", () => {
  // On a cheap L2 "about two cents" is often what decides whether a small buy is
  // worth making, and the card could not answer it at all.
  assert.match(plain(render(ROBINHOOD)), /Gas 0\.045 gwei · ≈\$0\.02 per trade/);
  // Sub-gwei prices must not round to "0.0 gwei".
  assert.ok(!/Gas 0\.0 gwei/.test(plain(render(FULL))), "sub-gwei needs more precision, not less");
  assert.match(plain(render(FULL)), /Gas 0\.021 gwei/);
});

test("age sits beside the name, where it changes how you read everything below", () => {
  assert.match(plain(render(FULL)).split("\n")[1], /^🔵 Base\b.*·\s+91d old$/, plain(render(FULL)).split("\n")[1]);
  // A token with no known creation time must not print "undefined old".
  assert.ok(!/old/.test(plain(render(ROBINHOOD)).split("\n")[1]), "no age, no age line");
});

test("direction is readable before the number is", () => {
  const out = plain(render(FULL));
  assert.match(out, /1h 🟢 \+3\.4%/, out);
  assert.match(out, /24h 🔴 -12\.8%/, out);
});

test("a launchpad token is not accused of hiding its tax", () => {
  // GoPlus does not cover Robinhood, so `sec` is null — but a curve token cannot
  // set a tax at all. Printing nothing implied the tax was unknown.
  const out = plain(render(ROBINHOOD));
  assert.match(out, /Fair launch · 0% tax/, out);
  assert.ok(!/holders and tax/.test(out), "tax is known here, so it must not be listed as missing");
});

test("the danger flags still come first and still shout", () => {
  const hp = JSON.parse(JSON.stringify(FULL));
  hp.sec = { ...FULL.sec, honeypot: true, openSource: false, buyTaxPct: 25, sellTaxPct: 99 };
  const out = plain(render(hp));
  assert.match(out, /🚨 HONEYPOT/);
  assert.match(out, /closed-source/);
  assert.match(out, /Tax 25% buy \/ 99% sell/);
});

test("the thin-pool warning survived the rewrite", () => {
  // It is the one line that stops someone buying into a pool the bot can't reach.
  const thin = JSON.parse(JSON.stringify(FULL));
  thin.info.liquidityNative = 0.5;       // the pool the bot can trade
  thin.info.market.liqUsd = 383000;      // what the indexer advertises
  assert.match(plain(render(thin)), /Thin tradeable pool/);
});

test("gas is read from the chain, and the swap cost is labelled an estimate", () => {
  const src = fs.readFileSync(path.join(__dirname, "tokeninfo.js"), "utf8");
  assert.match(src, /async function gasSnapshot\(chainKey\)/);
  assert.match(src, /const fd = await core\.providerFor\(chainKey\)\.getFeeData\(\);/, "the price is real, not a constant");
  assert.match(src, /const SWAP_GAS_UNITS = 300000n;/, "the units are representative — hence the ≈ on the card");
  assert.match(src, /if \(core\.chains\.isSvm\(chainKey\)\) return null;/, "Solana fees are not gwei");
  // Best-effort like every other leg: a slow RPC must not hold up the card.
  assert.match(src, /tasks\.push\(gasSnapshot\(chainKey\)\.then\(\(g\) => \{ info\.gas = g; \}\)\);/);
});
