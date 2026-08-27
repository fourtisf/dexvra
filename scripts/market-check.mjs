#!/usr/bin/env node
// market:check — why does a chain's board row have no price?
//
//   npm run market:check                     # every chain, worst one probed
//   npm run market:check -- robinhood        # probe ONE chain against GT
//   BASE_URL=http://127.0.0.1:3005 npm run market:check
//
// Three different failures render identically as "$0 / — on every row of a
// chain", and they need three different fixes:
//
//   1. GeckoTerminal has no data for these tokens  → nothing to configure; the
//      tokens have no indexed pool (fresh launchpad tokens live here)
//   2. GeckoTerminal is refusing/limiting this box → quota; GECKOTERMINAL_API_KEY
//   3. GT answers fine and the SITE still shows 0  → the site's pipeline; read
//      pm2 logs dexvra | grep -F '[market]'  (and '[gt]')
//
// So this drives BOTH halves and says which one broke: the RUNNING SERVER's
// own /api/tokens (what the board actually serves), and then GeckoTerminal
// DIRECTLY with the exact request shape src/lib/providers/geckoterminal.ts
// sends. Whether GT answers is a property of this box's egress today — the
// rule raid:check, launchpads:check, fonts:check and chart:check all state —
// so it has to be measured here, not reasoned about in a sandbox.
//
// Plain Node 18, no src/** imports — production runs 18.19, where importing
// TS from a script simply throws (the logos:check rule).

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3005").replace(/\/+$/, "");
const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const TARGET = (args[0] || "").toLowerCase();

// ⚠️ A PORT of src/config/chains.ts geckoNetwork — a check script cannot import
// TS on the production Node. chains.test.ts guards that these two stay equal,
// because a check reading a different network id than the site proves nothing.
const GECKO_NETWORK = {
  solana: "solana", bsc: "bsc", ethereum: "eth", base: "base",
  robinhood: "robinhood", tron: "tron", ton: "ton", sui: "sui-network", plasma: "plasma",
  polygon: "polygon_pos", arbitrum: "arbitrum", optimism: "optimism", avalanche: "avax",
  berachain: "berachain", sonic: "sonic", hyperevm: "hyperevm", abstract: "abstract",
  apechain: "apechain", blast: "blast", sei: "sei-evm", aptos: "aptos", unichain: "unichain",
};

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;

async function fetchTokens() {
  // `pm2 restart dexvra && npm run market:check` is the order an operator
  // actually types, and Next takes a few seconds to bind — a check that fails
  // on its own happy path teaches the reader to ignore it.
  const deadline = Date.now() + 30000;
  let lastErr;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/tokens`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`${BASE}/api/tokens answered ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (Date.now() > deadline) break;
      process.stdout.write("  … waiting for the server to come up\r");
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
  console.error(R(`\ncould not read ${BASE}/api/tokens — ${lastErr?.message || lastErr}`));
  console.error("Is the web app running? BASE_URL= points this check somewhere else.");
  process.exit(2);
}

function priced(t) {
  return t.source === "live" || Number(t.priceUsd) > 0;
}

const payload = await fetchTokens();
console.log(`\nmarket:check — board build ${payload.build || "?"} · live=${payload.live}\n`);

const byChain = new Map();
for (const t of payload.tokens || []) {
  const c = byChain.get(t.chain) || { rows: 0, live: 0, blank: [] };
  c.rows++;
  if (priced(t)) c.live++;
  else c.blank.push(t);
  byChain.set(t.chain, c);
}
if (!byChain.size) { console.error(R("the board served zero tokens — nothing to check")); process.exit(2); }

let worst = null;
for (const [chain, c] of [...byChain.entries()].sort()) {
  const all = c.live === c.rows;
  const none = c.live === 0;
  const mark = all ? G("✓") : none ? R("✗") : Y("~");
  console.log(`${mark} ${chain.padEnd(10)} ${c.live}/${c.rows} priced${none ? "  ← every row is blank" : ""}`);
  if (none && (!worst || c.rows > worst.c.rows)) worst = { chain, c };
}

const probe = TARGET ? { chain: TARGET, c: byChain.get(TARGET) } : worst;
if (TARGET && !probe.c) { console.error(R(`\nno listings on chain '${TARGET}'`)); process.exit(2); }
if (!probe) { console.log(G("\nEvery chain has at least one priced row — nothing to probe.")); process.exit(0); }

const { chain, c } = probe;
const net = GECKO_NETWORK[chain];
console.log(`\n── probing GeckoTerminal directly for ${chain} ──────────────────`);
if (!net) {
  console.log(R(`no geckoNetwork for '${chain}' — no indexer covers it; rows can only carry captured figures`));
  process.exit(1);
}
const rows = (c.blank.length ? c.blank : (payload.tokens || []).filter((t) => t.chain === chain)).slice(0, 10);
const addrs = rows.map((t) => t.address);
// The site's own request, byte for byte (geckoterminal.ts fetchChunk).
const url = `https://api.geckoterminal.com/api/v2/networks/${net}/tokens/multi/${addrs.join(",")}?include=top_pools`;
let gt;
try {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (r.status === 404) {
    console.log(R(`GT answered 404 — network id '${net}' or every address is unknown to it`));
    console.log(`  ${url}`);
    process.exit(1);
  }
  if (r.status === 429) {
    console.log(R("GT answered 429 — this box is over the shared ~30 req/min per-IP ceiling"));
    console.log("  The bot suite shares this IP. GECKOTERMINAL_API_KEY in the repo-root .env is");
    console.log("  the only thing that raises the ceiling rather than dividing it.");
    process.exit(1);
  }
  if (!r.ok) { console.log(R(`GT answered ${r.status}`)); console.log(`  ${url}`); process.exit(1); }
  gt = await r.json();
} catch (e) {
  console.log(R(`could not reach api.geckoterminal.com — ${e?.message || e}`));
  console.log(`  ${url}`);
  process.exit(1);
}

const known = new Map((gt.data || []).map((d) => [String(d.attributes?.address || "").toLowerCase(), d.attributes || {}]));
let have = 0;
for (const t of rows) {
  const a = known.get(String(t.address).toLowerCase());
  const px = a && Number(a.price_usd);
  if (px > 0) { have++; console.log(`  ${G("✓")} ${t.symbol.padEnd(10)} GT prices it at $${a.price_usd}`); }
  else if (a) console.log(`  ${Y("~")} ${t.symbol.padEnd(10)} GT knows the token but publishes no price (pool too new/quiet)`);
  else console.log(`  ${R("✗")} ${t.symbol.padEnd(10)} GT has no record — no indexed pool for ${t.address}`);
}

console.log("");
if (have > 0) {
  console.log(R(`GT prices ${have}/${rows.length} of these RIGHT NOW and the board still shows nothing —`));
  console.log("the fault is on the site's side of the pipe. Read, in this order:");
  console.log("  pm2 logs dexvra --lines 100 --nostream | grep -F '[market]'   ← which provider failed, per chain");
  console.log("  pm2 logs dexvra --lines 100 --nostream | grep -F '[gt]'       ← tier and budget this box runs");
  process.exit(1);
} else {
  console.log(Y(`GT has no priced record for any of these ${rows.length} — the board is honest about them.`));
  console.log("These tokens have no indexed pool yet (a launchpad token lives here until its pool");
  console.log("is created and GT picks it up). Their curve-side data can come only from the");
  console.log("launchpad itself: cd bot && npm run poolstrade:check, or the Pons on-chain path.");
  process.exit(1);
}
