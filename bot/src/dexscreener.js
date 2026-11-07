// DexScreener token info — richer than GeckoTerminal for LISTING AUTOFILL: it
// returns the project's socials (X / Telegram) + website + logo, which GT does
// not. Always filtered by chain (never match a same-address token on another
// chain). Used to prefill the listing form when a CA is dropped.
const log = require("./helpers/logger");
// ⚠️ Which pairs are ABOUT a token: its BASE-side pairs only. The deepest pair
// of a token's answer can be a stranger's pool with this token as its QUOTE —
// C5xph…pump ($BTC) was listed as $LTC that way. See the module's header.
const tokenPairs = require("../../shared/dexscreener/tokenPairs");

const BASE = "https://api.dexscreener.com/latest/dex/tokens/";

// our chain id -> DexScreener chainId.
//
// DERIVED FROM THE SUPPORTED CHAINS, not hand-listed. It used to be a literal of
// nine entries while config/chains.js supported twenty-two, so thirteen chains —
// Polygon, Arbitrum, Optimism, Avalanche, Blast, Sei and the rest — were
// invisible to discovery: OUR_CHAIN below could not map their feed entries back,
// so the auto-lister dropped every token on them before it ever priced one. The
// panel meanwhile said it watches "every supported chain". Adding a chain to
// chains.js now makes it discoverable, which is the only way the two stay in
// step.
//
// ⚠️ ONE OWNER FOR THE SLUG, and this file used not to be it. `config/chains.js`
// already carries `DEXSCREENER_SLUG` — the map the buy alert's 📈 Chart link is
// built from — and this module kept a SECOND idea of the same fact: identity,
// with an empty OVERRIDES table nobody ever filled in. They disagreed on exactly
// one chain, and the cost of that one disagreement is the whole reason the rule
// exists:
//
//   DexScreener spells Sei `seiv2`. With identity, `fetchTokenInfo("sei", …)`
//   filtered its pairs on `chainId === "sei"`, matched none, and answered null —
//   which the auto-lister records as "no market data", a statement about the
//   TOKEN. And `OUR_CHAIN["seiv2"]` was undefined, so every Sei entry in the
//   discovery feeds was dropped before it was even counted. One whole network
//   invisible to free listings, silently, with the panel saying it watches
//   "every supported chain".
//
// Identity is still the FALLBACK, so adding a chain to chains.js keeps making it
// discoverable without a second edit — the guarantee the derived map was written
// for. A slug that is wrong is still safe in both directions (no pair matches,
// the feed entry is skipped); what is not safe is two maps that can drift.
const { CHAINS, DEXSCREENER_SLUG } = require("./config/chains");
const dsPair = require("../../shared/dexscreener/pair");

const DS_CHAIN = Object.fromEntries(Object.keys(CHAINS).map((c) => [c, DEXSCREENER_SLUG[c] || c]));

const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

// ── One bench for the whole host ────────────────────────────────────────────
//
// ⚠️ A SOURCE THAT REFUSES US MUST BE BENCHED, and this is the third module in
// the repo to need the rule (`gt.ts`, `dsChart.ts`, `providers/tokenLogo.ts`).
// The discovery feeds and the pricing endpoint are the SAME HOST, so one bench
// and not two: two would let the half that is still asking keep the refusal in
// place for the half that stopped.
//
// REFUSALS ONLY. A 5xx or a timeout is a per-request failure and says nothing
// about the quota — arming on one would take pricing down for two minutes over
// a single slow response. A 404 is an ANSWER about the token and benches
// nothing at all. This is `gt.ts`'s contract, verbatim.
const REFUSAL = new Set([401, 403, 429, 451]);
const BENCH_MS = Math.max(0, Number(process.env.DEXSCREENER_BENCH_MS) || 120_000);
let benchedUntil = 0;
let benchWhy = "";

/** Arm the bench from a refusal, honouring Retry-After once. */
function benchFrom(status, res, now = Date.now()) {
  if (!REFUSAL.has(status)) return false;
  const ra = Number(res && res.headers && res.headers.get && res.headers.get("retry-after"));
  const ms = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10 * 60_000) : BENCH_MS;
  benchedUntil = now + ms;
  benchWhy = `HTTP ${status}`;
  log.warn(`[dexscreener] refusing this box (${benchWhy}) — not asking again for ${Math.round(ms / 1000)}s`);
  return true;
}

/** "we may not ask right now", or null. Reported as a REASON, never as a result. */
function benched(now = Date.now()) {
  if (now >= benchedUntil) return null;
  return `DexScreener is refusing this server (${benchWhy}) — backing off for ${Math.round((benchedUntil - now) / 1000)}s`;
}

/** Test seam: forget the bench. */
function resetBench() {
  benchedUntil = 0;
  benchWhy = "";
}

/**
 * Market data for one token — with the reason when there is none.
 *
 * ⚠️ "IT ANSWERED WITH NOTHING" AND "IT DID NOT ANSWER" ARE DIFFERENT FACTS,
 * and collapsing them here cost the free-listing feed. This used to return a
 * bare `null` for a 403, a 429, a dead socket AND a token DexScreener genuinely
 * has no pair for — and `autoLister.rejectReason` renders a null as
 * "no market data", which is a claim about the TOKEN. So a DexScreener that was
 * refusing this box produced `40 priced · 0 listed — no market data ×40`, a
 * sentence that reads as a quiet market, and `coolUntil` then benched every one
 * of those tokens for TWELVE HOURS — so the damage outlived the outage.
 *
 * The `{ items, ok, why }` shape is `pumpfunNewX`'s and `core.dsPairsX`'s; this
 * is the same contract with one record instead of a list:
 *   ok:true,  info:{…}  — it answered, and here is the market
 *   ok:true,  info:null — it answered, and it has no pair for this token
 *   ok:false, info:null — we could not ask; `why` says what stopped us
 */
const rawChanges = (pc) => {
  const out = {};
  for (const w of ['m5', 'h1', 'h6', 'h24']) {
    const v = pc && pc[w];
    out[w] = typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return out;
};

// ── The pool's REAL depth ("CEK LP BUKAN HANYA MC DAN VOLUME") ─────────────
//
// `liquidity.usd` is BOTH sides of the pool valued at the pool's own price, so
// a pool stuffed with the token itself — a single-sided v3 position above the
// price, or a price the deployer walked up through a thin pool — reads as deep
// liquidity while holding almost nothing a seller can take out. $NASDUCK
// (Robinhood) was free-listed on numbers like that, and GMGN later measured
// its pool at $507 against a $684M cap. The OTHER side of the pool — the
// WETH/SOL/USDC — is what a sell is paid from, so it travels on its own.
// `null` when DexScreener did not publish it: an absent reading makes no claim.
const sameAddr = tokenPairs.sameAddr;
const finiteOrNull = (v) => {
  if (v == null || String(v).trim() === "") return null; // Number(null) is 0 — not a reading
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** USD value of the pool side that is NOT this token, or null. */
function otherSideUsd(p, address) {
  const liq = p && p.liquidity;
  if (!liq) return null;
  const priceUsd = finiteOrNull(p.priceUsd);
  if (p.baseToken && sameAddr(p.baseToken.address, address)) {
    // Our token is the base: the other side is `liquidity.quote`, in quote
    // units, and one quote unit is worth priceUsd / priceNative.
    const q = finiteOrNull(liq.quote);
    const native = finiteOrNull(p.priceNative);
    if (q == null || q < 0 || !(priceUsd > 0) || !(native > 0)) return null;
    return q * (priceUsd / native);
  }
  if (p.quoteToken && sameAddr(p.quoteToken.address, address)) {
    // Our token is the quote (rare): the other side is the base, priced at priceUsd.
    const b = finiteOrNull(liq.base);
    if (b == null || b < 0 || !(priceUsd > 0)) return null;
    return b * priceUsd;
  }
  return null;
}

/** `{ buys, sells }` for a window, or null when either count is unpublished. */
function txnsOf(p, w) {
  const t = p && p.txns && p.txns[w];
  if (!t) return null;
  const buys = finiteOrNull(t.buys);
  const sells = finiteOrNull(t.sells);
  return buys == null || sells == null ? null : { buys, sells };
}

async function fetchTokenInfoX(chain, address, { now = Date.now() } = {}) {
  const dsChain = DS_CHAIN[chain];
  // A chain DexScreener does not carry is an ANSWER, not a failure: the caller
  // is meant to fall through to another source, not to retry us.
  if (!dsChain) return { info: null, ok: true, why: "DexScreener does not index this chain" };
  const held = benched(now);
  if (held) return { info: null, ok: false, why: held };
  try {
    const res = await fetch(BASE + encodeURIComponent(address), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      benchFrom(res.status, res, now);
      // A 404 is the one status that is about the TOKEN. Everything else is
      // about the host or about us.
      if (res.status === 404) return { info: null, ok: true, why: "no pair on DexScreener" };
      return { info: null, ok: false, why: `DexScreener HTTP ${res.status}` };
    }
    const j = await res.json();
    // ⚠️ ITS OWN PAIRS ONLY, deepest first — a pair where this token is the
    // QUOTE describes the OTHER token in every field below (name, ticker,
    // price, cap, logo, socials). That is how $BTC was listed as $LTC.
    const pairs = tokenPairs.ownPairs(j.pairs, address, { chainId: dsChain });
    if (!pairs.length) {
      // Seen only as the quote of other tokens' pools: two facts survive — who
      // it is and its USD price — and nothing else. No cap, no logo, no depth:
      // those would be somebody else's numbers. liq 0 keeps every size gate shut.
      const q = tokenPairs.quoteView(j.pairs, address, { chainId: dsChain });
      if (!q) return { info: null, ok: true, why: `no ${dsChain} pair on DexScreener` };
      return {
        info: {
          name: q.name, symbol: q.symbol, priceUsd: q.priceUsd, mcap: null, logoUrl: null,
          website: null, twitter: null, telegram: null, liq: 0, vol24: 0, change24h: 0,
          priceChange: rawChanges(null), pairCreatedAt: 0, pairCount: 0, liqQuoteUsd: null,
          quoteSymbol: null, txns24: null, poolAddress: null, dexId: null, quoteOnly: true,
        },
        ok: true,
        why: null,
      };
    }
    const p = pairs[0];
    const base = p.baseToken || {};
    const info = p.info || {};
    const socials = info.socials || [];
    const tw = socials.find((s) => /twitter|^x$/i.test(s.type || ""));
    const tg = socials.find((s) => /telegram/i.test(s.type || ""));
    const web = first(info.websites);
    const out = {
      name: base.name || null,
      symbol: base.symbol || null,
      priceUsd: Number(p.priceUsd) || null,
      mcap: Number(p.marketCap) || Number(p.fdv) || null,
      logoUrl: info.imageUrl || null,
      website: (web && web.url) || null,
      twitter: (tw && tw.url) || null,
      telegram: (tg && tg.url) || null,
      // Health signals — the auto-lister needs them to tell a real $1M project
      // from a $1M "market cap" printed on $300 of liquidity.
      liq: Number(p.liquidity && p.liquidity.usd) || 0,
      vol24: Number(p.volume && p.volume.h24) || 0,
      change24h: Number(p.priceChange && p.priceChange.h24) || 0,
      // RAW, per window: `change24h` above folds an absent reading into 0, which
      // is fine for a display and useless for asking "did the price not move?".
      // A window DexScreener did not publish stays null — never a flat 0.
      priceChange: rawChanges(p.priceChange),
      pairCreatedAt: Number(p.pairCreatedAt) || 0,
      pairCount: pairs.length,
      // The pool's real depth and whether anybody is SELLING — see the block
      // above `otherSideUsd`. listingQuality judges them; null makes no claim.
      liqQuoteUsd: otherSideUsd(p, address),
      quoteSymbol: (p.baseToken && sameAddr(p.baseToken.address, address) ? p.quoteToken?.symbol : p.baseToken?.symbol) || null,
      txns24: txnsOf(p, "h24"),
      poolAddress: p.pairAddress || null,
      dexId: p.dexId || null,
    };
    return { info: out, ok: true, why: null };
  } catch (e) {
    // undici hides the syscall in err.cause; keeping it is the difference
    // between "DNS is dead" and "the request timed out".
    const why = `DexScreener ${e.message}${e.cause && e.cause.code ? ` (${e.cause.code})` : ""}`;
    log.debug(`[dexscreener] ${chain}/${address}: ${why}`);
    return { info: null, ok: false, why };
  }
}

/**
 * The same bench, as the transport the shared pair resolver injects. A refusal
 * parks DexScreener for every caller in this process, exactly as it does for
 * fetchTokenInfoX — a second private idea of "is DexScreener up" in one process
 * is how one half keeps hammering a host the other half already backed off.
 * Resolves `{ ok, status, body, why }` and never throws.
 */
async function benchedFetchJson(url, { timeoutMs = 8000, now = Date.now() } = {}) {
  const held = benched(now);
  if (held) return { ok: false, status: 0, body: null, why: held };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      benchFrom(res.status, res, now);
      return { ok: false, status: res.status, body: null, why: `DexScreener HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, body: await res.json(), why: null };
  } catch (e) {
    return { ok: false, status: 0, body: null, why: `DexScreener ${e.message}${e.cause && e.cause.code ? ` (${e.cause.code})` : ""}` };
  }
}

/**
 * Is `address` a DexScreener PAIR on any of `chains` (our chain keys)?
 *
 * The address in a dexscreener.com URL is the pool, and every other reader in
 * this file asks `latest/dex/tokens/` — which knows nothing about pools. See
 * shared/dexscreener/pair.js for the whole reasoning; this only maps our chain
 * keys onto DexScreener's slugs (the one map, DS_CHAIN) and back.
 *
 *   ok:true,  pair:{…, chain} — it is that pair; `pair.token` is what it trades
 *   ok:true,  pair:null       — every chain answered, and it is not a pair
 *   ok:false, pair:null       — could not ask; `why` says what stopped us
 */
async function fetchPairX(address, chains) {
  const slugs = [...new Set((chains || []).map((c) => DS_CHAIN[c]).filter(Boolean))];
  const r = await dsPair.resolvePairX(address, { slugs, fetchJson: benchedFetchJson });
  if (r.pair) r.pair.chain = OUR_CHAIN[r.pair.chainId] || null;
  return r;
}

/** Our chain key for a DexScreener chain id (`seiv2` → `sei`), or null. */
const chainOfSlug = (slug) => OUR_CHAIN[String(slug || "").toLowerCase()] || null;

/** The long-standing shape, for the callers that only ever wanted the record.
 *  ⚠️ It cannot tell a refusal from a token with no pair — that is what
 *  `fetchTokenInfoX` exists for, and why the auto-lister uses that one. */
async function fetchTokenInfo(chain, address) {
  return (await fetchTokenInfoX(chain, address)).info;
}

// ── Discovery feeds ─────────────────────────────────────────────────────────
// DexScreener has no "every token above $X market cap" endpoint, so discovery
// rides its public feeds — the same streams the site's own "new pairs" pages
// are built from. Each returns tokens across EVERY chain; we keep the ones on
// chains Dexvra supports and let the caller price them.
//
//   token-profiles/latest  — projects that just published a profile (icon,
//                            socials): the closest thing to "a real project
//                            just showed up"
//   token-boosts/top       — currently boosted, i.e. actively promoted
//   token-boosts/latest    — newly boosted
//
// Best-effort by design: a feed that is down or reshaped yields nothing and the
// scan simply finds fewer candidates. It must never throw into the service loop.
const DISCOVERY_FEEDS = [
  "https://api.dexscreener.com/token-profiles/latest/v1",
  "https://api.dexscreener.com/token-boosts/top/v1",
  "https://api.dexscreener.com/token-boosts/latest/v1",
];

// DexScreener chainId → our chain id (the inverse of DS_CHAIN).
const OUR_CHAIN = Object.fromEntries(Object.entries(DS_CHAIN).map(([ours, ds]) => [ds, ours]));

/**
 * One feed, with the reason when it gave us nothing.
 *
 * ⚠️ Every way this can fail used to collapse into `[]` at DEBUG level — which
 * production does not print — and the auto-lister's blocker then asserted the
 * one thing that was not true: "every source empty". All three feeds live on
 * ONE host, so a single 403 takes all three at once and the operator is sent to
 * look for a quiet market. `{ items, ok, status, why }` is the shape this repo
 * already uses (`pumpfunNewX`, `core.dsPairsX`) for exactly this reason.
 */
async function fetchFeedX(url, { now = Date.now() } = {}) {
  const held = benched(now);
  if (held) return { items: [], ok: false, status: 0, why: held };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      benchFrom(res.status, res, now);
      log.debug(`[dexscreener] feed ${url}: HTTP ${res.status}`);
      return { items: [], ok: false, status: res.status, why: `HTTP ${res.status}` };
    }
    const j = await res.json();
    // A 200 carrying something that is not a list is a RESHAPED response, not an
    // empty feed — and the two need different answers.
    if (!Array.isArray(j)) return { items: [], ok: false, status: 200, why: "answered 200 with a non-list body (reshaped?)" };
    return { items: j, ok: true, status: 200, why: null };
  } catch (e) {
    const why = `${e.message}${e.cause && e.cause.code ? ` (${e.cause.code})` : ""}`;
    log.debug(`[dexscreener] feed ${url}: ${why}`);
    return { items: [], ok: false, status: 0, why };
  }
}

/**
 * Candidate tokens from every discovery feed, de-duplicated, on supported
 * chains only.
 *
 * INTERLEAVED, not concatenated. The caller prices only the first N per scan
 * (autoLister.maxLookupsPerRun, 40 by default) and there are three feeds, so
 * concatenating meant the budget was spent head-first on ONE of them:
 * token-profiles/latest is the newest profiles — minutes-old microcaps that
 * cannot clear a $1M trigger, a $25k liquidity floor and a 6h age gate — and
 * whenever it alone ran to 40 entries the boosted feeds, which is where
 * established $1M+ projects actually appear, were never priced at all. The
 * service then lists nothing, scan after scan, with every feed perfectly
 * healthy.
 *
 * Round-robin gives each feed an even share of whatever budget the caller has.
 * Order within a feed is still preserved.
 * @returns {Promise<Array<{chain: string, address: string}>>}
 */
async function fetchDiscoveryX(feeds = DISCOVERY_FEEDS) {
  const answers = await Promise.all(feeds.map((u) => fetchFeedX(u)));
  const lists = answers.map(({ items }) =>
    (Array.isArray(items) ? items : []).flatMap((it) => {
      const chain = OUR_CHAIN[String(it && it.chainId)];
      const address = String((it && it.tokenAddress) || "").trim();
      return chain && address ? [{ chain, address }] : [];
    }),
  );
  const seen = new Set();
  const out = [];
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < depth; i++) {
    for (const list of lists) {
      const c = list[i];
      if (!c) continue;
      const key = `${c.chain}:${c.address.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  // `ok` is "at least one feed answered". All three failing is a fact about the
  // HOST, and the caller must be able to say so instead of reporting an empty
  // market.
  const ok = answers.some((a) => a.ok);
  // DEDUPED. All three feeds are one host, so they usually fail for the same
  // reason — and repeating a sentence three times in a blocker makes the line
  // longer without making it more informative. Which feeds is in `feeds`.
  const why = ok ? null : [...new Set(answers.map((a) => a.why))].join(" · ");
  return { items: out, ok, why, feeds: answers.map((a, i) => ({ url: feeds[i], n: lists[i].length, ok: a.ok, why: a.why })) };
}

/** The long-standing array shape, for callers that do not need the reason. */
async function fetchDiscovery(feeds = DISCOVERY_FEEDS) {
  return (await fetchDiscoveryX(feeds)).items;
}

// DS_CHAIN is exported because the token-logo CDN path is keyed on DexScreener's
// chain slug (dd.dexscreener.com/ds-data/tokens/<slug>/<addr>.png) — gainers.js
// builds that URL as a logo fallback and must not keep a second copy of the map.
module.exports = { otherSideUsd, txnsOf, fetchTokenInfo, fetchTokenInfoX, fetchPairX, chainOfSlug, fetchDiscovery, fetchDiscoveryX, DISCOVERY_FEEDS, DS_CHAIN, benched, resetBench };
