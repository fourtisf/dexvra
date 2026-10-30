'use strict';
/*
 * "Is this address a DexScreener PAIR — and if so, whose?" One owner, for
 * every package that takes a contract address from a person.
 *
 * Reported 2026-10-30 with https://dexscreener.com/bsc/0x20da3ebe…b546554:
 * DexScreener carried the token, and the bot "could not read the CA".
 *
 * ⚠️ THE ADDRESS IN A DEXSCREENER URL IS THE POOL, NOT THE TOKEN. A token page
 * redirects to its top pair, so what lands in the address bar — and in every
 * "copy link" — is `dexscreener.com/<chain>/<pairAddress>`. This repo even
 * PUBLISHES those links itself: the buy alert's 📈 Chart button is
 * `chartUrl(chain, poolAddress)`. And every reader in both bots asked exactly
 * one question of DexScreener, `latest/dex/tokens/{address}`, which knows
 * nothing about pairs. So a pasted pair answered "no market" from DexScreener,
 * "no pool" from GeckoTerminal, and nothing from the chain sweep — about a
 * token trading perfectly well — and a pasted LINK was refused outright as
 * "not a valid address". Worse, a paid listing could be created with the PAIR
 * as its contract, and no price read would ever find it again.
 *
 * `latest/dex/pairs/{chainId}/{pairAddress}` is DexScreener's DOCUMENTED pair
 * endpoint; it answers the question in one request per chain.
 *
 * Rules, each a way this could mislead:
 *
 *  • THE MATCH IS EXACT. A pair counts only when its `pairAddress` IS the
 *    address asked about — never "the first pair in the answer". EVM hex
 *    compares case-insensitively; base58 and every other spelling is
 *    case-SENSITIVE, because a lowercased Solana pool is a different account.
 *
 *  • THE TOKEN IS THE PAIR'S BASE. A DexScreener page is about its baseToken —
 *    the chart, the price and the heading all describe it — so the base is
 *    what the person who shared the link meant. Guessing "the side that is not
 *    WBNB" instead would be a second, private idea of the same fact.
 *
 *  • "IT ANSWERED WITH NOTHING" AND "IT DID NOT ANSWER" STAY DIFFERENT FACTS:
 *      ok:true,  pair:{…}  — this address is that pair
 *      ok:true,  pair:null — every chain asked answered, and it is not a pair
 *      ok:false, pair:null — at least one chain could not be asked; `why` says
 *    A refusal read as "not a pair" would let a pair through as a token.
 *
 *  • TRANSPORT IS INJECTED. The listing bot has a DexScreener bench (a refusal
 *    parks the host for every caller in that process) and the trade bot has its
 *    own cache; this module owns the RULE and lets each package keep its own
 *    budget, so nothing here can bypass a bench that exists for a reason.
 *
 *  • DISPLAY AND LOOKUP ONLY. An address this returns is a POINTER somebody
 *    else's index gave us. The trade bot SHOWS a token resolved this way and
 *    never spends on it blind — see tradebot `resolvePaste`.
 */

const PAIRS_API = 'https://api.dexscreener.com/latest/dex/pairs';

// An address segment in a dexscreener.com URL. Wide on purpose — 0x hex (40 for
// a v2/v3 pair, 64 for a v4 pool id or a Sui object), base58, Tron, TON's
// base64url — and bounded below at 32 so a path like `/new-pairs/bsc` or
// `/gainers` can never read as a chain plus an address.
const ADDR_SEG = '[A-Za-z0-9_:\\-]{32,120}';
const LINK_RE = new RegExp(`^(?:https?:\\/\\/)?(?:www\\.)?dexscreener\\.com\\/([a-z0-9-]+)\\/(${ADDR_SEG})(?:[/?#].*)?$`, 'i');
const SEARCH_RE = new RegExp(`^(?:https?:\\/\\/)?(?:www\\.)?dexscreener\\.com\\/search\\?(?:.*&)?q=(${ADDR_SEG})(?:[&#].*)?$`, 'i');

/**
 * A dexscreener.com link → `{ slug, address }`, `{ slug: null, address }` for a
 * search link, or null. The WHOLE input must be the link (surrounding
 * whitespace aside): a link quoted inside a sentence is somebody talking about
 * a token, not handing it over.
 */
function parseLink(text) {
  const s = String(text || '').trim();
  if (!s || /\s/.test(s)) return null;
  const q = SEARCH_RE.exec(s);
  if (q) return { slug: null, address: q[1] };
  const m = LINK_RE.exec(s);
  if (!m) return null;
  return { slug: m[1].toLowerCase(), address: m[2] };
}

/** Same account? EVM hex is case-insensitive; everything else is exact. */
function sameAddress(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y) return false;
  if (/^0x[0-9a-f]+$/i.test(x) && /^0x[0-9a-f]+$/i.test(y)) return x.toLowerCase() === y.toLowerCase();
  return x === y;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The parts of a DexScreener pair a caller needs, plus the raw record for the
 *  ones (the buy bot's pool reader) that already know how to read it. */
function summarize(p) {
  const base = p.baseToken || {};
  const quote = p.quoteToken || {};
  return {
    chainId: String(p.chainId || ''),
    pairAddress: String(p.pairAddress || ''),
    dexId: String(p.dexId || ''),
    labels: Array.isArray(p.labels) ? p.labels : [],
    token: { address: String(base.address || ''), name: String(base.name || ''), symbol: String(base.symbol || '') },
    quote: { address: String(quote.address || ''), name: String(quote.name || ''), symbol: String(quote.symbol || '') },
    priceUsd: num(p.priceUsd),
    liquidityUsd: num(p.liquidity && p.liquidity.usd),
    url: String(p.url || ''),
    raw: p,
  };
}

/** The pair in a DexScreener answer whose address IS `address`, or null.
 *  The endpoint spells it `pairs: [...]` and, on older schema versions,
 *  `pair: {...}` — both are read. */
function pickPair(body, address) {
  const list = [];
  if (body && Array.isArray(body.pairs)) list.push(...body.pairs);
  if (body && body.pair && typeof body.pair === 'object') list.push(body.pair);
  const hits = list.filter((p) => p && sameAddress(p.pairAddress, address) && p.baseToken && p.baseToken.address);
  if (!hits.length) return null;
  hits.sort((a, b) => (num(b.liquidity && b.liquidity.usd) || 0) - (num(a.liquidity && a.liquidity.usd) || 0));
  return hits[0];
}

/** Default transport: global fetch, bounded, the reason kept. Packages with a
 *  bench pass their own. Resolves `{ ok, status, body, why }` and never throws. */
async function defaultFetchJson(url, { timeoutMs = 6000 } = {}) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!r.ok) {
      try { await r.body?.cancel(); } catch (_) {}
      return { ok: false, status: r.status, body: null, why: `DexScreener HTTP ${r.status}` };
    }
    return { ok: true, status: r.status, body: await r.json(), why: null };
  } catch (e) {
    const code = e && e.cause && e.cause.code;
    return { ok: false, status: 0, body: null, why: `DexScreener ${e && e.message}${code ? ` (${code})` : ''}` };
  }
}

/**
 * Is `address` a pair on any of `slugs` (DexScreener chain ids)?
 *
 * Asked concurrently, one request per slug — a person is waiting, and these are
 * the cheapest requests DexScreener serves. Only callers that have ALREADY
 * learnt the address is not a token they know reach this, so it costs nothing
 * on the common path.
 */
async function resolvePairX(address, { slugs = [], fetchJson = defaultFetchJson, timeoutMs } = {}) {
  const addr = String(address || '').trim();
  const want = [...new Set((slugs || []).filter(Boolean).map((s) => String(s).toLowerCase()))];
  if (!addr || !want.length) return { ok: true, pair: null, why: 'no DexScreener chain to ask' };
  // LOWERCASED for EVM hex, never for anything else. A paste from a block
  // explorer is the EIP-55 checksum spelling, and the indexes are keyed on the
  // lowercase one; a base58 pool lowercased is a different account.
  const q = /^0x[0-9a-f]+$/i.test(addr) ? addr.toLowerCase() : addr;
  const answers = await Promise.all(want.map(async (slug) => {
    const res = await Promise.resolve()
      .then(() => fetchJson(`${PAIRS_API}/${slug}/${encodeURIComponent(q)}`, { timeoutMs }))
      .catch((e) => ({ ok: false, status: 0, body: null, why: `DexScreener ${e && e.message}` }));
    // A 404 is an ANSWER about the address ("no such pair here"), never an outage.
    if (res && res.status === 404) return { slug, ok: true, pair: null };
    if (!res || !res.ok) return { slug, ok: false, pair: null, why: (res && res.why) || 'DexScreener did not answer' };
    return { slug, ok: true, pair: pickPair(res.body, addr) };
  }));
  const hits = answers.filter((a) => a.pair);
  if (hits.length) {
    hits.sort((a, b) => (num(b.pair.liquidity && b.pair.liquidity.usd) || 0) - (num(a.pair.liquidity && a.pair.liquidity.usd) || 0));
    return { ok: true, pair: summarize(hits[0].pair), why: null };
  }
  const failed = answers.filter((a) => !a.ok);
  // The FIRST reason, not the last: one dead socket on a chain the token is not
  // on must not bury the refusal that stopped the chain it IS on.
  if (failed.length) return { ok: false, pair: null, why: failed[0].why };
  return { ok: true, pair: null, why: null };
}

module.exports = { PAIRS_API, parseLink, sameAddress, pickPair, summarize, resolvePairX, defaultFetchJson };
