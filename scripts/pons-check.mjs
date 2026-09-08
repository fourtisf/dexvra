// Why does a Pons launch come back with no ticker and no price?
//
// The feed has three layers and they fail independently, but the JSON renders
// all three failures identically as `null`:
//
//   1. the factory's TokenLaunched logs   → token / curve / deployer
//   2. eth_call on the curve and the token → reserves, decimals, symbol, logo
//   3. GeckoTerminal's ETH reference price → every USD figure
//
// A layer-2 failure and a layer-3 failure need completely different fixes (an
// RPC that caps batches, versus a shared GeckoTerminal quota), so this asks
// each one separately and says which it is.
//
// Node 18 on the server, so: plain .mjs, no src/**/*.ts imports — the rule
// logos:check and market:check already follow.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── env ───────────────────────────────────────────────────────────────────
// A standalone script gets none of Next's env loading, and reporting a value
// as unset when we simply never read its file is a diagnostic about nothing —
// so the files actually read are named in the output.
const envFiles = [];
for (const name of [".env", ".env.local"]) {
  const path = join(ROOT, name);
  if (!existsSync(path)) continue;
  envFiles.push(name);
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

// ⚠️ A PORT of src/config/pons.ts, because production runs Node 18 and a check
// script cannot import a .ts module. test-pons.mjs asserts it stays equal —
// a drifted default makes this report a healthy box as broken.
const RPC = (process.env.PONS_RPC_URL || "https://rpc.mainnet.chain.robinhood.com").trim();
const FACTORY = (process.env.PONS_FACTORY || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e").trim().toLowerCase();
const CHAIN_ID = 4663;
const SITE = (process.env.SITE_ORIGIN || "http://127.0.0.1:3005").replace(/\/+$/, "");
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Selectors, each verified against its signature. The four well-known ones
// (decimals/totalSupply/symbol/getReserves) are the cross-check that the
// derivation is right.
const SEL = {
  getLaunchedToken: "0x3cf28b5a", // getLaunchedToken(address)
  getReserves: "0x0902f1ac",      // getReserves()
  realQuoteReserve: "0x4f1f58fd", // realQuoteReserve()
  sellableTokens: "0x808bcddc",   // sellableTokens()
  graduated: "0xe7c2b772",        // graduated()
  decimals: "0x313ce567",         // decimals()
  totalSupply: "0x18160ddd",      // totalSupply()
  symbol: "0x95d89b41",           // symbol()
  name: "0x06fdde03",             // name()
  logo: "0xfb7f21eb",             // logo()
};

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m", b: "\x1b[1m" };
const head = (s) => console.log(`\n${C.b}${s}${C.x}`);
const ok = (s) => console.log(`  ${C.g}✓${C.x} ${s}`);
const bad = (s) => console.log(`  ${C.r}✗${C.x} ${s}`);
const warn = (s) => console.log(`  ${C.y}⚠${C.x} ${s}`);
const note = (s) => console.log(`    ${C.d}${s}${C.x}`);

let broken = 0;

async function rpc(body, timeoutMs = 12000) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const one = (method, params) => rpc({ jsonrpc: "2.0", id: 1, method, params }).then((j) => {
  if (j.error) throw new Error(j.error.message || `rpc error ${j.error.code ?? ""}`);
  return j.result;
});

const ethCall = (to, data) => one("eth_call", [{ to, data }, "latest"]);

const addrArg = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const wordAt = (hex, i) => hex.replace(/^0x/, "").slice(i * 64, i * 64 + 64);
const asAddr = (w) => `0x${w.slice(24)}`;
const asNum = (w) => (w ? BigInt(`0x${w}`) : 0n);
function asString(hex) {
  const body = hex.replace(/^0x/, "");
  const off = Number(BigInt(`0x${body.slice(0, 64)}`)) * 2;
  const len = Number(BigInt(`0x${body.slice(off, off + 64)}`));
  if (!Number.isFinite(len) || len <= 0) return "";
  return Buffer.from(body.slice(off + 64, off + 64 + len * 2), "hex").toString("utf8");
}

const why = (err) => String(err?.message || err).slice(0, 140);

// ── 1. Is the chain reachable at all? ─────────────────────────────────────
head("1 · Robinhood Chain RPC");
console.log(`  ${C.d}${RPC}${C.x}`);
console.log(`  ${C.d}env read from: ${envFiles.length ? envFiles.join(", ") : "no .env file in the repo root"}${C.x}`);
let head_ = null;
try {
  const [blk, cid] = await Promise.all([one("eth_blockNumber", []), one("eth_chainId", [])]);
  head_ = Number(BigInt(blk));
  const id = Number(BigInt(cid));
  ok(`answers — head ${head_}, chain id ${id}`);
  if (id !== CHAIN_ID) { bad(`expected chain id ${CHAIN_ID} — this RPC is a different chain`); broken++; }
} catch (e) {
  bad(`unreachable — ${why(e)}`);
  note("everything below depends on this; PONS_RPC_URL in the repo-root .env pins another endpoint");
  process.exit(1);
}

// ── 2. Does it honour BATCHED calls? ──────────────────────────────────────
// The feed asks 9 eth_calls per token in one batch. A node that caps or
// refuses batches is the difference between a full row and a row of nulls.
head("2 · Batched eth_call");
let batchOk = false;
try {
  const j = await rpc([
    { jsonrpc: "2.0", id: 0, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
  ]);
  if (Array.isArray(j) && j.length === 2) { batchOk = true; ok("2-call batch honoured"); }
  else { warn(`answered a batch with ${Array.isArray(j) ? `${j.length} item(s)` : "a non-array"} — the app falls back to one call at a time`); }
} catch (e) {
  warn(`batches refused (${why(e)}) — the app falls back to one call at a time`);
}
if (batchOk) {
  // The size that matters is the one the feed actually sends.
  try {
    const big = Array.from({ length: 27 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_chainId", params: [] }));
    const j = await rpc(big);
    if (Array.isArray(j) && j.length === 27) ok("27-call batch honoured (the size one 3-token refresh sends)");
    else { bad(`27-call batch came back with ${Array.isArray(j) ? `${j.length} item(s)` : "a non-array"} — THIS is why metadata is null`); broken++; }
  } catch (e) {
    bad(`27-call batch refused — ${why(e)}`);
    note("lower PONS_LOG_CHUNKS_PER_REFRESH / the batch size, or pin a paid RPC");
    broken++;
  }
}

// ── 3. Which tokens ───────────────────────────────────────────────────────
// No placeholder command anywhere: with no argument this asks the running
// server for the launches it is actually serving, which are real addresses.
head("3 · Launches to inspect");
let tokens = process.argv.slice(2).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
if (tokens.length) {
  ok(`${tokens.length} address(es) given on the command line`);
} else {
  try {
    const r = await fetch(`${SITE}/api/pons/launches?limit=3`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    tokens = (j.items || []).map((i) => i.address).filter(Boolean);
    if (tokens.length) ok(`${tokens.length} from the running server's own feed`);
    else { warn("the server's feed is empty — nothing to inspect"); note(`pass a token address as an argument to inspect one directly`); }
  } catch (e) {
    warn(`could not read ${SITE}/api/pons/launches — ${why(e)}`);
    note("pass a Pons token address as an argument to inspect one directly");
  }
}

// ── 4/5. The two eth_call layers, per token, one call at a time ───────────
// Sequentially and individually, so a single failing call is named rather
// than nulling its whole group the way the app's grouping does.
let metaFailures = 0;
for (const token of tokens) {
  head(`4 · ${token}`);
  let curve = null;
  try {
    const raw = await ethCall(FACTORY, SEL.getLaunchedToken + addrArg(token));
    const exists = asNum(wordAt(raw, 14)) !== 0n;
    curve = asAddr(wordAt(raw, 1));
    const pair = asAddr(wordAt(raw, 4));
    const tax = Number(asNum(wordAt(raw, 8)));
    if (!exists) { bad("the factory has no launch record for this token"); continue; }
    ok(`launch record — curve ${curve}`);
    note(`pairToken ${pair}${pair === "0x0000000000000000000000000000000000000000" ? " (native ETH)" : " — an ERC-20 quote, so USD figures are skipped by design"}`);
    note(`creator tax ${(tax / 100).toFixed(2)}%`);
  } catch (e) { bad(`getLaunchedToken failed — ${why(e)}`); broken++; continue; }

  const reads = [
    ["curve.getReserves()", curve, SEL.getReserves, (h) => `quote ${asNum(wordAt(h, 0))} · token ${asNum(wordAt(h, 1))}`],
    ["curve.realQuoteReserve()", curve, SEL.realQuoteReserve, (h) => String(asNum(wordAt(h, 0)))],
    ["curve.sellableTokens()", curve, SEL.sellableTokens, (h) => String(asNum(wordAt(h, 0)))],
    ["curve.graduated()", curve, SEL.graduated, (h) => (asNum(wordAt(h, 0)) ? "true" : "false")],
    ["token.decimals()", token, SEL.decimals, (h) => String(asNum(wordAt(h, 0)))],
    ["token.totalSupply()", token, SEL.totalSupply, (h) => String(asNum(wordAt(h, 0)))],
    ["token.symbol()", token, SEL.symbol, asString],
    ["token.name()", token, SEL.name, asString],
    ["token.logo()", token, SEL.logo, (h) => asString(h) || "(empty)"],
  ];
  for (const [label, to, sel, render] of reads) {
    try {
      const raw = await ethCall(to, sel);
      if (!raw || raw === "0x") { bad(`${label} → empty (the contract has no such function, or reverted)`); metaFailures++; continue; }
      let shown;
      try { shown = render(raw); } catch { shown = `undecodable (${raw.slice(0, 26)}…)`; }
      ok(`${label} → ${shown}`);
    } catch (e) { bad(`${label} → ${why(e)}`); metaFailures++; }
  }
}

// ── 6. The USD reference price ────────────────────────────────────────────
// Layer 3, and it fails on its own: every USD figure on the feed is the curve
// price multiplied by this, so one refused request nulls all of them while
// the chain reads are perfect.
head("6 · GeckoTerminal ETH reference price");
try {
  const r = await fetch(`https://api.geckoterminal.com/api/v2/simple/networks/eth/token_price/${WETH}`, {
    headers: { accept: "application/json;version=20230302" },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) {
    bad(`HTTP ${r.status}${r.status === 429 ? " — rate limited" : ""}`);
    note("every USD figure on the feed is null while this is refused; the chain reads are unaffected");
    note("GECKOTERMINAL_API_KEY in the repo-root .env is the only thing that raises the ceiling rather than dividing it");
    broken++;
  } else {
    const j = await r.json();
    const prices = j?.data?.attributes?.token_prices || {};
    const px = Number(prices[WETH] ?? prices[WETH.toLowerCase()]);
    if (px > 0) ok(`ETH = $${px.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
    else { bad("answered, but with no usable price"); broken++; }
  }
} catch (e) { bad(`unreachable — ${why(e)}`); broken++; }

// ── Verdict ───────────────────────────────────────────────────────────────
head("Verdict");
try {
  const r = await fetch(`${SITE}/api/tokens`, { signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (j.build) console.log(`  ${C.d}serving build ${j.build}${C.x}`);
} catch {}

if (metaFailures) {
  bad(`${metaFailures} contract read(s) failed — that is why symbol, name and price are null`);
  broken++;
} else if (tokens.length) {
  ok("every contract read answered — the chain layer is healthy");
  note("if the feed still shows nulls, the reads are being lost in the BATCH: compare section 2");
}
console.log(
  broken
    ? `\n${C.r}Something is broken — the sections above say which layer.${C.x}`
    : `\n${C.g}Every layer answered.${C.x}`,
);
process.exit(broken ? 1 : 0);
