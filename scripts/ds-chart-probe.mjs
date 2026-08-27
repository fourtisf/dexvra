// ds:probe — FIND DEXSCREENER'S REAL CANDLE REQUEST, ON THE BOX THAT HAS TO MAKE IT.
//
// `providers/dsChart.ts` ships a GUESSED request shape, on purpose: DexScreener
// publishes no OHLCV endpoint, so every part of the request is a `.env` line
// rather than a deploy. `chart:check` then tells you whether the guess works —
// and when it does not, it tells you to go read the real shape out of your own
// browser's DevTools. That last step is the gap this script closes:
//
//     THE BOX IS NOT A BROWSER, BUT IT CAN READ THE BROWSER'S CODE.
//
// DexScreener's chart is a TradingView chart fed by its own datafeed, and the
// code that builds those URLs ships in the page's JS bundle. So rather than
// guess again, this walks the same path a human with DevTools would:
//
//   1. RESOLVE  our token's deepest pair through the DOCUMENTED api. host.
//   2. DISCOVER fetch dexscreener.com's own bundle and read the datafeed
//      host/path out of it. Whatever it finds is tried FIRST, ahead of every
//      built-in guess, because it came from the caller itself.
//   3. PROBE    ask each candidate for real, with dsChart's own headers, and
//      classify the answer: refused / wrong path / talking-but-refusing the
//      params / bars.
//   4. PRINT    the exact .env lines for whatever answered with bars.
//
// ⚠️ IT PROVES NOTHING FROM A SANDBOX. Whether a host answers is a property of
// THIS box's egress today — the rule `raid:check`, `launchpads:check`,
// `fonts:check` and `chart:check` all state. It was written on a box that
// cannot reach any dexscreener.com host at all, so every line below is about
// how to ASK, and only the box you run it on can say what comes back.
//
//   npm run ds:probe                          # the shipped sample
//   npm run ds:probe -- solana VJdpSDDLof…    # one token you are looking at
//   npm run ds:probe -- bsc 0x8b7a…7777
//
// Exits non-zero when nothing returned bars, because that is the state worth
// acting on. Node 18: global fetch, no dependencies, no TypeScript import —
// the same floor `chart:check` documents.
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", D = "\x1b[2m", X = "\x1b[0m";

const strip = (s) => String(s ?? "").trim().replace(/\/+$/, "");
const PAIRS_BASE = strip(process.env.DS_PAIRS_API) || "https://api.dexscreener.com";
const SITE_BASE = strip(process.env.DS_SITE) || "https://dexscreener.com";
const TIMEOUT_MS = Number(process.env.DS_PROBE_TIMEOUT_MS) || 15_000;

/** The build stamp of the checkout, for the reason every other check prints
 *  one: a report read as a statement about a fix that was never deployed. */
function stamp() {
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain --untracked-files=no", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return "unknown";
  }
}

/** dsChart.ts's own header set, copied deliberately rather than imported: this
 *  script must run on node 18 without type stripping, and a probe that asks
 *  with DIFFERENT headers than the provider would is measuring the wrong
 *  request. Keep the two in step. */
const CHART_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 DexvraChart/1.0",
  referer: "https://dexscreener.com/",
  origin: "https://dexscreener.com",
};

async function get(url, { headers = CHART_HEADERS, as = "text" } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    const body = as === "json" ? await res.json().catch(() => null) : await res.text();
    return { ok: res.ok, status: res.status, body, ms: Date.now() - t0 };
  } catch (err) {
    const code = err?.cause?.code || err?.cause?.errno || err?.name || "";
    return { ok: false, status: 0, body: null, ms: Date.now() - t0, why: `${code || "request failed"}: ${err?.message ?? err}` };
  }
}

// ── 1. RESOLVE ───────────────────────────────────────────────────────────────
/** Deepest BASE-side pair, the same rule dsChart.dsTopPair follows: a token is
 *  also the QUOTE side of somebody else's pair, and charting that draws the
 *  other asset's price under our ticker. */
async function topPair(chain, address) {
  const r = await get(`${PAIRS_BASE}/latest/dex/tokens/${address}`, { headers: { accept: "application/json" }, as: "json" });
  if (!r.ok) return { pair: null, why: `api.dexscreener.com ${r.status || "unreachable"}${r.why ? ` (${r.why})` : ""}` };
  const pairs = (r.body?.pairs ?? []).filter(
    (p) => p?.pairAddress && p?.chainId === chain && p?.baseToken?.address?.toLowerCase() === address.toLowerCase(),
  );
  if (!pairs.length) return { pair: null, why: `no ${chain} pair with this token on the base side` };
  const best = pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
  return {
    pair: { pairAddress: best.pairAddress, dexId: best.dexId ?? "", chainId: best.chainId, liquidityUsd: best.liquidity?.usd ?? 0 },
    why: null,
  };
}

// ── 2. DISCOVER ──────────────────────────────────────────────────────────────
/** Path templates read out of DexScreener's own bundle.
 *
 *  The bundle builds these URLs by CONCATENATION, so a literal in the source
 *  is a fragment ("/dex/chart/amm/", "/bars/") rather than a whole path. What
 *  this can honestly recover is therefore the HOST and the fragments — printed
 *  in full so a human can assemble the rest, and turned into candidates where
 *  a fragment is complete enough to try. Anything it finds is tried first. */
export function scanBundle(src) {
  const found = { hosts: new Set(), fragments: new Set(), templates: new Set() };
  for (const m of src.matchAll(/https?:\/\/([a-z0-9.-]*dexscreener\.com)/gi)) found.hosts.add(m[1].toLowerCase());
  // Any quoted literal that looks like part of a datafeed route.
  for (const m of src.matchAll(/["'`](\/(?:dex|u|chart)\/[A-Za-z0-9/_.$%{}-]*)["'`]/g)) {
    const p = m[1];
    if (/chart|bar|candle|ohlc|log/i.test(p)) found.fragments.add(p);
  }
  // A whole template, if one ships intact.
  //
  // ⚠️ THE CHARACTER CLASS MUST ALLOW BRACES ON BOTH SIDES OF THE KEYWORD. It
  // used to stop at `{`, so the one thing worth finding —
  // `/dex/chart/amm/v9/{dex}/bars/{chain}/{pair}` — fell through to `fragments`
  // and was never probed: the sweep asked six built-in guesses and skipped the
  // template the bundle had just handed it. Caught by the stub, which is the
  // whole reason a script about an unreachable host has one.
  for (const m of src.matchAll(/["'`](\/[A-Za-z0-9/_${}-]*(?:bars|candles|ohlcv)[A-Za-z0-9/_${}-]*)["'`]/g)) {
    found.templates.add(m[1]);
  }
  return found;
}

async function discover(chain, pairAddress) {
  const page = await get(`${SITE_BASE}/${chain}/${pairAddress}`, {
    headers: { ...CHART_HEADERS, accept: "text/html,application/xhtml+xml" },
  });
  if (!page.ok) return { ok: false, why: `${SITE_BASE} ${page.status || "unreachable"}${page.why ? ` (${page.why})` : ""}`, hosts: [], fragments: [], templates: [], scripts: 0 };

  const srcs = [...String(page.body).matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  const urls = srcs
    .map((s) => (s.startsWith("http") ? s : `${SITE_BASE}${s.startsWith("/") ? "" : "/"}${s}`))
    .filter((u) => /\.js(\?|$)/i.test(u));

  const all = { hosts: new Set(), fragments: new Set(), templates: new Set() };
  // The page itself can carry an inline datafeed config.
  for (const k of ["hosts", "fragments", "templates"]) for (const v of scanBundle(String(page.body))[k]) all[k].add(v);

  let read = 0;
  for (const u of urls.slice(0, 40)) {
    const js = await get(u, { headers: { ...CHART_HEADERS, accept: "*/*" } });
    if (!js.ok) continue;
    read++;
    const hit = scanBundle(String(js.body));
    for (const k of ["hosts", "fragments", "templates"]) for (const v of hit[k]) all[k].add(v);
  }
  return {
    ok: true,
    why: null,
    scripts: read,
    hosts: [...all.hosts],
    fragments: [...all.fragments].sort(),
    templates: [...all.templates].sort(),
  };
}

// ── 3. PROBE ─────────────────────────────────────────────────────────────────
/** The shapes dsChart.ts ships, plus the neighbours a renamed segment would
 *  land on. Discovered ones go in front of these. */
const BUILTIN_PATHS = [
  "/dex/chart/amm/v3/{dex}/bars/{chain}/{pair}",
  "/dex/chart/amm/v2/{dex}/bars/{chain}/{pair}",
  "/dex/chart/amm/{dex}/bars/{chain}/{pair}",
  "/dex/chart/bars/{chain}/{pair}",
  "/dex/bars/{chain}/{pair}",
  "/u/chart/bars/{chain}/{pair}",
];
const BUILTIN_QUERIES = [
  "from={from}&to={to}&res={res}&cb={limit}",
  "from={from}&to={to}&resolution={res}&countback={limit}",
  "symbol={pair}&from={from}&to={to}&resolution={res}",
];

export const fill = (tpl, v) =>
  tpl.replace(/\{dex\}/g, v.dex).replace(/\{chain\}/g, v.chain).replace(/\{pair\}/g, v.pair)
     .replace(/\{from\}/g, v.from).replace(/\{to\}/g, v.to).replace(/\{res\}/g, v.res).replace(/\{limit\}/g, v.limit);

/** dsChart.barsOf, in plain JS — same envelope vocabulary, same one level of
 *  nesting. A probe that parses more leniently than the provider would report
 *  a shape the provider then cannot read. */
export function barsOf(body, depth = 0) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object" || depth > 2) return null;
  for (const k of ["bars", "data", "candles", "rows", "result"]) {
    const v = body[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      const inner = barsOf(v, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

/** What the answer MEANS — the distinction dsChart.ts is built around and the
 *  only thing that makes a red line actionable. */
export function classify(r) {
  if (r.status === 0) return { mark: `${R}✗${X}`, verdict: `could not ask (${r.why ?? "no answer"})`, win: false };
  if ([401, 403, 451].includes(r.status)) return { mark: `${R}✗${X}`, verdict: `${r.status} — the host refuses THIS SERVER, not this path`, win: false };
  if (r.status === 429) return { mark: `${Y}·${X}`, verdict: "429 — rate limited, ask again later", win: false };
  if (r.status === 404) return { mark: `${D}·${X}`, verdict: "404 — wrong path (the host is fine)", win: false };
  if (r.status === 400) return { mark: `${Y}·${X}`, verdict: `400 — RIGHT PATH, wrong parameters${hint(r)}`, win: false };
  if (!r.ok) return { mark: `${R}✗${X}`, verdict: `${r.status}${hint(r)}`, win: false };
  const bars = barsOf(safeJson(r.body));
  if (!bars) return { mark: `${Y}·${X}`, verdict: `200 but no bar list found${hint(r)} — try DS_CHART_BARS_KEY`, win: false };
  if (!bars.length) return { mark: `${Y}·${X}`, verdict: "200, empty bar list — asked, nothing there", win: false };
  return { mark: `${G}✓${X}`, verdict: `${G}200 with ${bars.length} bar(s)${X}`, win: true, bars };
}

const safeJson = (t) => { try { return typeof t === "string" ? JSON.parse(t) : t; } catch { return null; } };
const hint = (r) => {
  const flat = String(r.body ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return flat ? ` ${D}— ${flat.slice(0, 110)}${flat.length > 110 ? "…" : ""}${X}` : "";
};

// ── main ─────────────────────────────────────────────────────────────────────
const SAMPLE = [{ chain: "solana", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", label: "USDC (Solana)" }];
const argv = process.argv.slice(2);
const targets = argv.length >= 2 ? [{ chain: argv[0], address: argv[1], label: `${argv[1].slice(0, 10)}… (${argv[0]})` }] : SAMPLE;

async function main() {
  console.log(`\nWhat is DexScreener's real candle request?   ${D}checkout ${stamp()}${X}`);
  console.log(`${D}  Whether a host answers is a property of THIS box's egress today.${X}\n`);

  let anyWin = false;
  for (const t of targets) {
    console.log(`${C}${t.label}${X}  ${D}${t.chain} ${t.address}${X}`);

    const { pair, why } = await topPair(t.chain, t.address);
    if (!pair) { console.log(`  ${R}✗ resolve${X} ${why}\n`); continue; }
    console.log(`  ${G}✓ resolve${X} pair ${pair.pairAddress} ${D}dex=${pair.dexId || "?"} liq=$${Math.round(pair.liquidityUsd).toLocaleString()}${X}`);

    const d = await discover(pair.chainId, pair.pairAddress);
    if (!d.ok) console.log(`  ${Y}· discover${X} ${d.why} ${D}(candidates fall back to the built-in guesses)${X}`);
    else {
      console.log(`  ${G}✓ discover${X} read ${d.scripts} bundle(s) ${D}hosts: ${d.hosts.join(", ") || "none"}${X}`);
      for (const f of d.fragments.slice(0, 25)) console.log(`      ${D}fragment${X} ${f}`);
      for (const f of d.templates.slice(0, 25)) console.log(`      ${C}template${X} ${f}`);
      if (!d.fragments.length && !d.templates.length) console.log(`      ${D}nothing datafeed-shaped in the bundle — it may be built from split literals${X}`);
    }

    const bases = (process.env.DS_CHART_API ? [strip(process.env.DS_CHART_API)] : [...(d.hosts ?? []).filter((h) => h.startsWith("io.")).map((h) => `https://${h}`), "https://io.dexscreener.com"]);
    // Discovered first, then the built-in guesses. A discovered string is only
    // a candidate PATH if it can actually address a pair — the bundle also
    // yields prefixes like "/dex/log/amm/v9/", which are worth PRINTING for a
    // human to assemble but not worth an HTTP request.
    const addressable = (p) => p.includes("{pair}") || p.includes("{chain}");
    const discovered = [...(d.templates ?? []), ...(d.fragments ?? [])].filter(addressable);
    const paths = [...new Set([...discovered, ...BUILTIN_PATHS])];
    const now = Math.floor(Date.now() / 1000);
    const vars = { dex: pair.dexId, chain: pair.chainId, pair: pair.pairAddress, from: now - 6 * 3600, to: now, res: "15", limit: 100 };

    console.log(`  ${D}probing ${[...new Set(bases)].length} base(s) × ${paths.length} path(s) × ${BUILTIN_QUERIES.length} query shape(s)${X}`);
    let win = null;
    const seen = new Map(); // status -> count, so a silent sweep still shows its work
    for (const base of [...new Set(bases)]) {
      for (const path of paths) {
        for (const q of BUILTIN_QUERIES) {
          const url = `${base}${fill(path, vars)}?${fill(q, vars)}`;
          const r = await get(url);
          const v = classify(r);
          const key = r.status === 0 ? "could not ask" : String(r.status);
          seen.set(key, (seen.get(key) ?? 0) + 1);
          // Only a hit, or something that is TALKING to us, is worth a line —
          // a full 404 matrix would bury the one line that matters.
          if (v.win || r.status === 400 || (r.status === 200 && !v.win) || [401, 403, 429, 451].includes(r.status)) {
            console.log(`    ${v.mark} ${D}${path}${X} ${D}?${q}${X}\n        ${v.verdict} ${D}${r.ms}ms${X}`);
          }
          if (v.win && !win) { win = { base, path, q }; break; }
        }
        if (win) break;
      }
      if (win) break;
    }
    // ⚠️ ALWAYS SAY WHAT THE SWEEP SAW. Only lines worth acting on are printed
    // above, so a run that is all 404s prints nothing at all — which reads as
    // "it never asked" rather than "the path is wrong everywhere", and those
    // need opposite next steps.
    const tally = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}×${k}`).join(" · ");
    console.log(`  ${D}asked ${[...seen.values()].reduce((a, b) => a + b, 0)}: ${tally || "nothing"}${X}`);

    if (win) {
      anyWin = true;
      console.log(`\n  ${G}FOUND IT.${X} Paste into ${C}/opt/dexvra/.env.local${X} — no deploy, then ${C}pm2 restart dexvra --update-env${X}:\n`);
      console.log(`${G}DS_CHART_API=${win.base}${X}`);
      console.log(`${G}DS_CHART_PATH=${win.path}${X}`);
      console.log(`${G}DS_CHART_QUERY=${win.q}${X}\n`);
      console.log(`  ${D}Then confirm through the real route:  npm run chart:check${X}\n`);
    } else {
      console.log(`\n  ${R}Nothing returned bars.${X} Read the lines above in this order:\n`);
      console.log(`   ${D}• every line 403/401 → the host refuses this server's IP. DS_CHART_HEADERS may help;${X}`);
      console.log(`   ${D}  if not, this box cannot use the datafeed and GeckoTerminal stays the only source.${X}`);
      console.log(`   ${D}• a line 400 → that PATH is right and the query is not. Copy the real query off${X}`);
      console.log(`   ${D}  dexscreener.com in a browser (DevTools → Network → filter "bars") → DS_CHART_QUERY.${X}`);
      console.log(`   ${D}• only 404s → the path moved. The fragments printed above are what its own bundle${X}`);
      console.log(`   ${D}  still contains; assemble one and pin it with DS_CHART_PATH.${X}`);
      console.log(`   ${D}• could not ask → egress. curl -sS -o /dev/null -w '%{http_code}' https://io.dexscreener.com/\n${X}`);
    }
  }
  process.exit(anyWin ? 0 : 1);
}

// ⚠️ ONLY WHEN RUN, NEVER WHEN IMPORTED. The pure halves above are covered by
// src/lib/dsChartProbe.test.ts — a real test that drives them, rather than the
// source guard this repo falls back to when a module cannot be imported. That
// only works if importing this file does not fire a network sweep and call
// process.exit() inside the test runner.
const RUN_DIRECTLY = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (RUN_DIRECTLY) main().catch((err) => { console.error(err); process.exit(1); });
