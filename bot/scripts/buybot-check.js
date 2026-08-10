#!/usr/bin/env node
// GeckoTerminal trades-feed connectivity + schema check for the group buy bot.
//
// WHY THIS SCRIPT EXISTS
// The buy bot posts REAL per-transaction alerts read from
// /networks/{net}/pools/{pool}/trades. If that feed is unreachable from your
// server — a blocked egress, a rate limit, a rotated response shape — the bot
// does not go silent and does not crash: it DEGRADES to volume-diff estimates,
// which look almost the same in the group. So "are my alerts real?" is a
// question you cannot answer by watching the chat, and this script answers it
// by asking the live API exactly what the bot asks.
//
//     cd bot && npm run buybot:check
//     cd bot && npm run buybot:check -- solana <token-address>
//
// It makes at most two read-only requests. It reads nothing local, writes
// nothing and signs nothing.
//
// Reading the output:
//   ✅ verified alerts     you are done — alerts will carry tx + buyer links.
//   ⚠️  feed answered, 0    the pool is genuinely quiet, or the token address
//                          does not match either side of the pool's trades
//                          (check you passed the TOKEN address, not the pool).
//   ❌ feed unavailable     the bot will fall back to estimates. The status
//                          printed tells you whether it is egress (no response),
//                          a rate limit (429) or a bad pool (404).
require("dotenv").config();

const gt = require("../src/group/gtPairs");
const trades = require("../src/group/gtTrades");
const { chainOf, txUrl, accountUrl, shortAddress } = require("../src/config/chains");

// A liquid, permanently-live pool so the default run proves the PATH works even
// if the operator has no group configured yet.
const DEFAULT_CHAIN = "solana";
const DEFAULT_TOKEN = "So11111111111111111111111111111111111111112"; // wrapped SOL

const money = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));

async function main() {
  const [chainArg, tokenArg] = process.argv.slice(2);
  const chain = chainArg || DEFAULT_CHAIN;
  const token = tokenArg || (chainArg ? null : DEFAULT_TOKEN);

  console.log("Dexvra buy-bot feed check");
  console.log("─".repeat(64));

  if (!token) {
    console.log("Usage: npm run buybot:check -- <chain> <token-address>");
    console.log(`Chains: ${Object.keys(require("../src/config/chains").CHAINS).join(", ")}`);
    process.exit(2);
  }

  const net = gt.networkOf(chain);
  console.log(`chain        : ${chain}${chainOf(chain) ? ` (${chainOf(chain).label})` : " — UNKNOWN CHAIN"}`);
  console.log(`gecko network: ${net || "— none mapped, the real feed can never run for this chain"}`);
  console.log(`token        : ${token}`);
  console.log("─".repeat(64));

  if (!net) {
    console.log("\n❌ This chain has no geckoNetwork in src/config/chains.js, so the buy bot can only");
    console.log("   ever estimate for it. Add the GT network slug to that chain's entry.");
    process.exit(1);
  }

  // 1. Resolve the pool the way the bot does.
  console.log("① resolving the token's deepest pool…");
  const pool = await gt.fetchPool(chain, token);
  if (!pool || !pool.poolAddress) {
    console.log("\n❌ No pool found. Either the token has no liquidity on this chain, or GeckoTerminal");
    console.log("   is unreachable from this server. Nothing else can work until this does.");
    process.exit(1);
  }
  console.log(`   pool     : ${pool.poolAddress}  (via ${pool.source})`);
  console.log(`   price    : ${pool.priceUsd == null ? "—" : "$" + pool.priceUsd}`);
  console.log(`   mcap/liq : ${money(pool.mcap)} / ${money(pool.liquidity)}`);

  // 2. Ask for real trades — the thing that decides real-vs-estimated.
  console.log("\n② reading the per-transaction trades feed…");
  const buys = await trades.fetchPoolBuys(net, pool.poolAddress, token, { minUsd: 0 });

  if (buys === null) {
    console.log("\n❌ FEED UNAVAILABLE — the buy bot will post ESTIMATES, not verified transactions.");
    console.log(`   GeckoTerminal cooldown armed: ${gt.inCooldown() ? "yes (429/5xx seen)" : "no"}`);
    console.log("\n   What to check, in order:");
    console.log("   • egress from this server to api.geckoterminal.com (curl it)");
    console.log("   • whether you are sharing an IP with something else hitting GT's ~30 req/min");
    console.log("   • BUYBOT_POOL_MIN_MS — raise it if you track many pools");
    process.exit(1);
  }

  if (!buys.length) {
    console.log("\n⚠️  The feed ANSWERED but returned no buys of this token in the last 24h.");
    console.log("   That is a healthy result for a quiet pool. If you expected trades, check that");
    console.log("   you passed the TOKEN address (not the pool address) and the right chain.");
    process.exit(0);
  }

  const shown = buys.slice(-5);
  console.log(`\n✅ VERIFIED ALERTS — ${buys.length} buy(s) in the feed. Newest ${shown.length}:\n`);
  for (const b of shown) {
    const when = b.blockTimeMs ? new Date(b.blockTimeMs).toISOString().slice(11, 19) + "Z" : "—";
    console.log(`   ${when}  ${money(b.usd).padStart(12)}  block ${b.blockNumber}  ${b.legs > 1 ? `(${b.legs} legs merged) ` : ""}`);
    console.log(`      tx    ${txUrl(chain, b.txHash) || b.txHash}`);
    console.log(`      buyer ${b.buyer ? accountUrl(chain, b.buyer) || shortAddress(b.buyer) : "—"}`);
  }
  console.log("\n   Every field above appears on the alert card. If the tx link opens the right");
  console.log("   transaction in a block explorer, the buy bot is fully live on this chain.");
}

main().catch((e) => {
  console.error(`\n❌ check failed: ${e && e.message}`);
  process.exit(1);
});
