#!/usr/bin/env node
// holders:check — which source gives the token page its Holders number, FROM THIS BOX.
//
//   npm run holders:check                      # the biggest listings, one per line
//   npm run holders:check -- robinhood 0x0a574aae41da077713ba32aa05ca151c8759e2f6
//
// "HOLDERS —" is one rendering of five different facts: the chain's explorer
// is unreachable from this box, it answers but has not indexed the token,
// DexScreener is refusing this server, GeckoTerminal had no free slot, or the
// chain has no source at all. They need different fixes, and the first round
// of this feature could only be diagnosed with a curl. This drives the RUNNING
// server's own /api/holders — the exact request the page makes — and prints
// the count and which host gave it, or every source's reason.
//
// ⚠️ With no argument it asks the SITE for real listings, never prints a
// command with a blank in it (CLAUDE.md's first rule). And the route remembers
// a miss for 90s, so a run straight after another reads that memo back.
//
// Plain Node 18, no src/** imports — production runs 18.19 (the logos:check rule).

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3005").replace(/\/+$/, "");
const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;

async function getJson(path) {
  const deadline = Date.now() + 30000; // Next takes a few seconds to bind after a restart
  let last;
  for (;;) {
    try {
      const r = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`${BASE}${path.split("?")[0]} answered ${r.status}`);
      return await r.json();
    } catch (e) {
      last = e;
      if (Date.now() > deadline) break;
      process.stdout.write("  … waiting for the server to come up\r");
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
  console.error(R(`\ncould not reach the web app — ${last?.message || last}`));
  console.error("Is it running? BASE_URL= points this check somewhere else.");
  process.exit(2);
}

let targets;
let build = "?";
if (args.length >= 2) {
  targets = [{ chain: args[0].toLowerCase(), address: args[1], symbol: "" }];
} else {
  const payload = await getJson("/api/tokens");
  build = payload.build || "?";
  const tokens = (payload.tokens || []).filter((t) => t.chain && t.address);
  if (!tokens.length) { console.error(R("the board served zero tokens — nothing to check")); process.exit(2); }
  // One per chain first (a chain whose explorer is down is the finding), then
  // the biggest by cap, eight in all — every one is a real request upstream.
  const byCap = [...tokens].sort((a, b) => (Number(b.mcap) || 0) - (Number(a.mcap) || 0));
  const seen = new Set();
  targets = [];
  for (const t of byCap) if (!seen.has(t.chain)) { seen.add(t.chain); targets.push(t); }
  for (const t of byCap) if (targets.length < 8 && !targets.includes(t)) targets.push(t);
  targets = targets.slice(0, 8);
}

console.log(`\nholders:check — ${BASE} · board build ${build}\n`);
let got = 0;
for (const t of targets) {
  const j = await getJson(`/api/holders?${new URLSearchParams({ chain: t.chain, address: t.address })}`);
  if (build === "?" && j.build) build = j.build;
  const name = `${t.symbol ? `$${String(t.symbol).replace(/^\$/, "")} ` : ""}${t.chain}/${t.address}`;
  if (j.count != null) {
    got++;
    console.log(`${G("✓")} ${name}\n    ${Number(j.count).toLocaleString("en-US")} holders · ${j.source} via ${j.via || "?"}`);
  } else {
    console.log(`${R("✗")} ${name}\n    no count — ${j.why || "no reason given"}`);
  }
}
console.log("");
if (got === targets.length) console.log(G("Every token asked has a measured holder count."));
else if (got) console.log(Y(`${got}/${targets.length} counted. The reasons above name the host that could not answer — a host that is unreachable from this box is its egress, "not indexed yet" is the token.`));
else {
  console.log(R("No token got a count — every source is failing from this box."));
  console.log("A different explorer host is one line in the repo-root .env: BLOCKSCOUT_ followed by the chain name in capitals (BLOCKSCOUT_ROBINHOOD), a comma list of https hosts.");
  process.exit(1);
}
