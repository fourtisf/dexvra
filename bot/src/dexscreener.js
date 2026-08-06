// DexScreener token info — richer than GeckoTerminal for LISTING AUTOFILL: it
// returns the project's socials (X / Telegram) + website + logo, which GT does
// not. Always filtered by chain (never match a same-address token on another
// chain). Used to prefill the listing form when a CA is dropped.
const log = require("./helpers/logger");

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
// Identity by default; OVERRIDES carries the ones DexScreener spells
// differently. Getting a slug wrong is SAFE in both directions — fetchTokenInfo
// finds no chain-matching pair and returns null, and discovery simply skips a
// feed entry it cannot map — so an unverified slug costs nothing and a correct
// one gains a chain.
const { CHAINS } = require("./config/chains");

const OVERRIDES = {
  // (none known) — add "ourId: 'theirSlug'" here when DexScreener's chainId
  // differs from ours rather than editing the generated map.
};

const DS_CHAIN = Object.fromEntries(Object.keys(CHAINS).map((c) => [c, OVERRIDES[c] || c]));

const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

/** @returns {Promise<{name,symbol,priceUsd,mcap,logoUrl,website,twitter,telegram}|null>} */
async function fetchTokenInfo(chain, address) {
  const dsChain = DS_CHAIN[chain];
  if (!dsChain) return null;
  try {
    const res = await fetch(BASE + encodeURIComponent(address), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = await res.json();
    const pairs = (j.pairs || []).filter((p) => p.chainId === dsChain);
    if (!pairs.length) return null;
    // highest-liquidity pair wins
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    const base = p.baseToken || {};
    const info = p.info || {};
    const socials = info.socials || [];
    const tw = socials.find((s) => /twitter|^x$/i.test(s.type || ""));
    const tg = socials.find((s) => /telegram/i.test(s.type || ""));
    const web = first(info.websites);
    return {
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
      pairCreatedAt: Number(p.pairCreatedAt) || 0,
      pairCount: pairs.length,
    };
  } catch (e) {
    log.debug(`[dexscreener] ${chain}/${address}: ${e.message}`);
    return null;
  }
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

async function fetchFeed(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      log.debug(`[dexscreener] feed ${url}: HTTP ${res.status}`);
      return [];
    }
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  } catch (e) {
    log.debug(`[dexscreener] feed ${url}: ${e.message}`);
    return [];
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
async function fetchDiscovery(feeds = DISCOVERY_FEEDS) {
  const lists = (await Promise.all(feeds.map(fetchFeed))).map((items) =>
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
  return out;
}

// DS_CHAIN is exported because the token-logo CDN path is keyed on DexScreener's
// chain slug (dd.dexscreener.com/ds-data/tokens/<slug>/<addr>.png) — gainers.js
// builds that URL as a logo fallback and must not keep a second copy of the map.
module.exports = { fetchTokenInfo, fetchDiscovery, DISCOVERY_FEEDS, DS_CHAIN };
