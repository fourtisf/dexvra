#!/usr/bin/env node
// Payment-config + stranded-funds report.
//
//   node scripts/treasury.js          config only (no network)
//   node scripts/treasury.js --live   also query live balances
//
// Answers the two questions that matter after a payment goes missing:
//   1. Which treasury addresses are actually configured? An unset one makes the
//      sweep a no-op — the funds simply stay in the temp wallet and a single
//      warn line says so.
//   2. Which temp wallets still hold money, and for which order?
//
// Prints addresses and balances only. Private keys are never read here.
const { TREASURY, RPC, WALLETS_DIR, WALLET_ENC_KEY } = require("../src/config/constants");
const { familyOf } = require("../src/config/chains");

const LIVE = process.argv.includes("--live");
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// Family → the chains that pay into it, so an unset treasury names what breaks.
const CHAINS_BY_FAMILY = {};
for (const chain of Object.keys(RPC)) {
  const fam = familyOf(chain);
  if (!fam) continue;
  (CHAINS_BY_FAMILY[fam] = CHAINS_BY_FAMILY[fam] || []).push(chain);
}

const SHAPE = {
  evm: [/^0x[0-9a-fA-F]{40}$/, "0x + 40 hex"],
  solana: [/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "base58, 32–44 chars"],
  tron: [/^T[1-9A-HJ-NP-Za-km-z]{33}$/, "T + 33 base58"],
  ton: [/^[UEk0-9A-Za-z_-]{48}$/, "48-char address"],
};

function reportConfig() {
  console.log("\n── Treasury (sweep destinations) ─────────────────────────────");
  let missing = 0;
  for (const [fam, addr] of Object.entries(TREASURY)) {
    const pays = (CHAINS_BY_FAMILY[fam] || []).join(", ") || fam;
    const envVar = `TREASURY_${fam === "solana" ? "SOL" : fam.toUpperCase()}`;
    if (!addr) {
      missing++;
      console.log(`${bad("✗")} ${fam.padEnd(7)} ${bad("NOT SET")} ${dim(`(${envVar}) — sweeps SKIPPED for: ${pays}`)}`);
      continue;
    }
    const [re, shape] = SHAPE[fam] || [null, ""];
    const shapeOk = !re || re.test(addr);
    console.log(
      `${shapeOk ? ok("✓") : bad("!")} ${fam.padEnd(7)} ${addr} ${dim(`(${envVar}) → ${pays}`)}` +
        (shapeOk ? "" : bad(`\n    ↑ does not look like ${shape} — check it before taking payments`)),
    );
  }

  console.log("\n── RPC endpoints ─────────────────────────────────────────────");
  for (const [chain, url] of Object.entries(RPC)) {
    const custom = !/publicnode|api\.mainnet-beta|api\.trongrid|toncenter|rpc\.mainnet\.chain/.test(url);
    console.log(`  ${chain.padEnd(10)} ${url} ${custom ? ok("(custom)") : dim("(public default — rate-limited)")}`);
  }

  console.log("\n── Key storage ───────────────────────────────────────────────");
  console.log(`  dir        ${WALLETS_DIR}`);
  console.log(`  at rest    ${WALLET_ENC_KEY ? ok("encrypted (WALLET_ENC_KEY set)") : bad("PLAINTEXT — set WALLET_ENC_KEY")}`);
  return missing;
}

async function reportFunds() {
  const orders = require("../src/payments/orders");
  const wallets = require("../src/payments/wallets");
  const all = orders.allOrders().filter((o) => o.address && !o.adminFree);
  if (!all.length) {
    console.log("\n── Temp wallets ──────────────────────────────────────────────\n  (no orders yet)");
    return;
  }
  console.log(`\n── Temp wallets (${all.length} order(s)${LIVE ? ", live balances" : ", --live for balances"}) ──`);
  let held = 0;
  for (const o of all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 40)) {
    let balTxt = dim("(not checked)");
    if (LIVE) {
      try {
        const bal = BigInt(await wallets.getBalance(o.chain, o.address));
        if (bal > 0n) held++;
        balTxt = bal > 0n ? bad(`HOLDS ${bal}`) : ok("empty");
      } catch (e) {
        balTxt = bad(`error: ${e.message.slice(0, 60)}`);
      }
    }
    const swept = o.sweptAt ? ok("swept") : o.status === "pending" ? dim("pending") : bad("UNSWEPT");
    console.log(`  ${String(o.chain).padEnd(9)} ${o.address}`);
    console.log(`    ${dim(o.id)}  status=${o.status}  ${swept}  ${balTxt}${o.sweptTx ? dim("  tx=" + o.sweptTx) : ""}`);
  }
  if (LIVE && held) {
    console.log(
      bad(`\n  ${held} wallet(s) still hold funds.`) +
        " sweepRetry re-tries every 6h and 90s after boot;\n  a treasury marked NOT SET above is the usual reason nothing moves.",
    );
  }
}

(async () => {
  const missing = reportConfig();
  await reportFunds();
  console.log("");
  if (missing) console.log(bad(`${missing} treasury address(es) unset — those chains cannot sweep.\n`));
  process.exit(0);
})();
