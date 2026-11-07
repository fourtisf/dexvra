#!/usr/bin/env node
// "Would the free listing take this token — and if not, why?" — measured from
// THIS box, through the bot's own gates (never a second copy of them).
//
// Written for $NASDUCK (Robinhood), a honeypot that was free-listed and then
// pump-announced. The gates that would refuse it now — the pool's REAL depth,
// a one-way market, and on a chain GoPlus does not cover, an on-chain sell
// simulation — all depend on DexScreener and the chain's RPC answering THIS
// server, which nothing outside the server can settle. So this asks them:
//
//   1. the market record the scan would read (cap, reported and REAL
//      liquidity, the pool's other side, 24h buys and sells);
//   2. listingQuality's verdict on it (copies, logo, the LP checks);
//   3. listingSafety's verdict (GoPlus / RugCheck, or the on-chain sell
//      simulation where neither covers the chain).
//
// Read-only. Arguments: the chain key, then the contract address. With none,
// it prints a complete line for a token that is listed right now.
require("../src/config/loadEnv").loadEnv();

const discovery = require("../src/discovery");
const { qualityRefusal, realLiquidity, minLiqShare } = require("../src/services/listingQuality");
const listingSafety = require("../src/services/listingSafety");
const { CHAINS } = require("../src/config/chains");

const money = (n) => (n == null || !Number.isFinite(Number(n)) ? "—" : `$${Math.round(Number(n)).toLocaleString("en-US")}`);

async function example() {
  try {
    const rows = await require("../src/api/dexvra").getListings();
    const r = (rows || []).find((x) => x && x.status === "approved" && x.chain && x.address);
    if (r) return `node scripts/token-verdict.js ${r.chain} ${r.address}`;
  } catch {
    /* the site could not be read — fall through to prose */
  }
  return null;
}

async function main() {
  const [chain, address] = process.argv.slice(2);
  if (!chain || !address) {
    const line = await example();
    console.log("Give the chain key and the contract address, in that order.");
    if (line) console.log(`For example, a token listed right now:\n  ${line}`);
    console.log(`Chains: ${Object.keys(CHAINS).join(", ")}`);
    process.exit(2);
  }
  if (!CHAINS[chain]) {
    console.log(`"${chain}" is not a chain this bot knows. Chains: ${Object.keys(CHAINS).join(", ")}`);
    process.exit(2);
  }

  // Safety on, whatever the env says: this question is the whole point.
  if (!listingSafety.enabled()) console.log("⚠ FREE_LISTING_SAFETY is off in .env — the scan is NOT asking the contract check. Asked here anyway.");
  process.env.FREE_LISTING_SAFETY = "1";

  console.log(`\n${chain} ${address}\n`);
  const ans = await discovery.fetchTokenInfoX(chain, address);
  const info = ans.info;
  if (!ans.ok) console.log(`✗ market read: ${ans.why}`);
  if (!info) {
    console.log("✗ no market record — the scan would refuse it as 'no market data'");
  } else {
    const real = realLiquidity(info);
    console.log(`  ${info.symbol || "?"} — ${info.name || "?"}`);
    console.log(`  cap ${money(info.mcap)} · liquidity reported ${money(info.liq)} · REAL ${money(real)}`);
    console.log(`  pool's other side ${info.liqQuoteUsd == null ? "not published" : money(info.liqQuoteUsd) + (info.quoteSymbol ? ` (${info.quoteSymbol})` : "")}`);
    if (info.mcap && real != null) {
      console.log(`  real liquidity is ${((real / info.mcap) * 100).toFixed(3)}% of the cap; the floor at this cap is ${(minLiqShare(info.mcap) * 100).toFixed(2)}%`);
    }
    console.log(`  24h ${info.txns24 ? `${info.txns24.buys} buys / ${info.txns24.sells} sells` : "buys/sells not published"} · volume ${money(info.vol24)}`);
    const q = qualityRefusal(chain, address, info);
    console.log(q ? `✗ quality: ${q}` : "✓ quality: no copy, logo present, the pool backs the cap, people sell");
  }
  const safe = await listingSafety.checkX(chain, address, { pool: info && info.poolAddress });
  if (!safe.ok) console.log(`? safety: could not decide — ${safe.why} (the scan does NOT list it, and asks again next scan)`);
  else if (safe.refusal) console.log(`✗ safety: ${safe.refusal}`);
  else console.log(`✓ safety: passed${safe.why ? ` (${safe.why})` : ""}`);
  console.log("");
}

main().catch((e) => {
  console.error(`token:verdict failed: ${e.message}`);
  process.exit(1);
});
