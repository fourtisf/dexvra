'use strict';
/*
 * A LOGO FOR EVERY LISTING, from whichever source has one.
 *
 * "setiap token harus punya logo anda cari sumber logo entah dri dexscrener
 * pumpfun atau apalah cri dri banyak sumber dan jika tidak ada logo hapus aja
 * tokenya." The board was rendering `FL` initials for $FLOKI — the site's
 * monogram fallback, which is the right thing to draw and the wrong thing to
 * have to draw on a row nobody will ever come and fix.
 *
 * Four sources, in the order of how much they KNOW about the token:
 *
 *   1. DexScreener pair info    — what the project itself uploaded
 *   2. GeckoTerminal token      — a second index, different submissions
 *   3. The launchpad            — pump.fun and friends have artwork from the
 *                                 first minute, long before either index
 *   4. CoinGecko by contract    — curated, and the only one of these that a
 *                                 human at the index has actually looked at
 *   5. Trust Wallet assets      — a community repo of token artwork, which is
 *                                 where a wallet gets its icons from
 *   6. DexScreener's CDN path   — a convention, not an answer; see below
 *
 * ⚠️ AND WHEN ALL SIX HAVE NOTHING, THAT IS INFORMATION. "ga mungkin kalo
 * project g punya logo" is right about projects and the tokens it was said
 * about were not projects: `$SAFE`, `$BONK`, `$CAT`, `$WOJAK`, `$MEME` — one
 * per search TERM the seeder uses, on three chains, none with artwork. A real
 * project is on at least one of six indexes within a day of launching. Six
 * empty answers is the cheapest junk filter this repo has.
 *
 * ⚠️ EVERY CANDIDATE IS FETCHED BEFORE IT IS BELIEVED. Source 4 is a URL
 * TEMPLATE — `dd.dexscreener.com/ds-data/tokens/<chain>/<addr>.png` — so it can
 * always be constructed and is very often a 404. Storing one unverified turns
 * "no logo" into "broken image", which is worse: the monogram at least looks
 * deliberate. The check also catches an HTML error page served with a 200,
 * which is what a CDN does when it does not want to admit a miss.
 */
const dexscreener = require('../dexscreener');
const gt = require('../group/gtPairs');
const launchpads = require('../launchpads');
const { DS_CHAIN } = require('../dexscreener');
const log = require('../helpers/logger');

const TIMEOUT_MS = 8000;
const httpsUrl = (u) => (/^https:\/\/\S+$/.test(String(u || '')) ? String(u) : null);

/**
 * Does this url actually serve an image? Never throws.
 *
 * HEAD first because it costs no bytes, then GET — some CDNs answer HEAD with
 * 405 while serving the file perfectly well, and treating that as a miss would
 * discard a good logo.
 */
async function isImage(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, { method, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 405 || res.status === 501) continue; // HEAD refused — try GET
      if (!res.ok) return false;
      const type = String(res.headers.get('content-type') || '').toLowerCase();
      // A 200 carrying HTML is a CDN's error page, not a logo.
      if (type.startsWith('image/')) return true;
      if (type) return false;
      // No content-type at all: accept only if something came back.
      return method === 'GET';
    } catch {
      return false; // a source we cannot reach is a source we cannot use
    }
  }
  return false;
}

/** DexScreener's token-image CDN path. A CONVENTION we construct, which is why
 *  it is last and why it is verified like everything else. */
function cdnGuess(chain, address) {
  const slug = DS_CHAIN[chain];
  return slug && address ? `https://dd.dexscreener.com/ds-data/tokens/${slug}/${address}.png` : null;
}

// CoinGecko's own platform ids. Not our chain ids and not DexScreener's — a
// third spelling of the same set, which is exactly the kind of table that goes
// stale silently, so a chain missing here costs one source and never a throw.
const CG_PLATFORM = {
  ethereum: 'ethereum',
  bsc: 'binance-smart-chain',
  base: 'base',
  solana: 'solana',
  polygon: 'polygon-pos',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  avalanche: 'avalanche',
  tron: 'tron',
  ton: 'the-open-network',
  sui: 'sui',
  aptos: 'aptos',
  sei: 'sei-v2',
  blast: 'blast',
  berachain: 'berachain',
  sonic: 'sonic',
  unichain: 'unichain',
};

/** Trust Wallet's assets repo — a fourth spelling again, and EVM only: the
 *  path is keyed on the EIP-55 CHECKSUMMED address, so a lowercase one 404s. */
const TW_CHAIN = {
  ethereum: 'ethereum',
  bsc: 'smartchain',
  base: 'base',
  polygon: 'polygon',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  avalanche: 'avalanchec',
};

/**
 * GeckoTerminal's own token record — ONE light call for `image_url`.
 *
 * ⚠️ It used to ask `marketdata.fetchMarket`, which is the heavy read: pools,
 * candles, a price, a market cap. Eighty-three rows × several GT requests each
 * is a rate limit we arm OURSELVES, and the first cleanup run did exactly that
 * — one 429 on row one, then eighty-two rows reported `undecided` because the
 * cooldown it caused never lifted inside the run. A logo needs one endpoint.
 *
 * Through `gtGet`, so it shares the paced queue and the cooldown rather than
 * being a private client with its own idea of the quota.
 */
async function gtLogo(chain, address) {
  const net = gt.networkOf(chain);
  if (!net || !address) return { ok: true, url: null }; // nothing to ask
  const res = await gt.gtGet(`/networks/${net}/tokens/${encodeURIComponent(address)}`);
  if (!res.ok) {
    // A 404 is an answer — GT does not index this token. Anything else means
    // it never looked.
    if (res.status === 404) return { ok: true, url: null };
    return { ok: false, why: res.reason || `HTTP ${res.status}` };
  }
  const attr = (res.body && res.body.data && res.body.data.attributes) || {};
  return { ok: true, url: httpsUrl(attr.image_url) };
}

async function coingecko(chain, address) {
  const plat = CG_PLATFORM[chain];
  // A chain CoinGecko has no id for is ANSWERED — there is nothing to ask.
  if (!plat || !address) return { ok: true, url: null };
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${plat}/contract/${encodeURIComponent(address)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    // 404 is the ordinary answer here — CoinGecko is curated, so most tokens a
    // seeding run finds are simply not in it. A 429 or a 5xx is the opposite:
    // the index never looked, and reporting that as "not in CoinGecko" is how
    // a rate limit becomes a deleted listing.
    if (res.status === 404) return { ok: true, url: null };
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const j = await res.json();
    const img = j && j.image;
    return { ok: true, url: httpsUrl((img && (img.large || img.small || img.thumb)) || null) };
  } catch (e) {
    return { ok: false, why: (e && e.message) || 'request failed' };
  }
}

function trustWallet(chain, address) {
  const slug = TW_CHAIN[chain];
  if (!slug || !/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) return null;
  let checksummed;
  try {
    checksummed = require('ethers').getAddress(String(address));
  } catch {
    return null; // not a valid address — nothing to build a path from
  }
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${slug}/assets/${checksummed}/logo.png`;
}

/**
 * The best logo url for a token, or `null` when no source has one.
 *
 * `{ url, source }` so a cleanup run can report WHERE each logo came from —
 * "42 from the launchpad" is the difference between a working chain of sources
 * and one source quietly carrying all of it.
 */
async function resolveLogo(chain, address, { deps = {} } = {}) {
  const dsInfo = deps.dsInfo || dexscreener.fetchTokenInfo;
  const gtInfo = deps.gtInfo || gtLogo;
  const padInfo = deps.padInfo || launchpads.fetchTokenInfo;
  const cgInfo = deps.cgInfo || coingecko;
  const gtDown = deps.gtInCooldown || gt.inCooldown;
  const verify = deps.isImage || isImage;

  const tried = [];
  const unreachable = [];

  /** Ask one source. A THROW means we could not ask; `null` means it answered
   *  and has nothing. Those are different facts and this is where they part. */
  const ask = (name, fn) =>
    Promise.resolve()
      .then(fn)
      .catch((e) => {
        unreachable.push(`${name}: ${(e && e.message) || 'failed'}`);
        return null;
      });

  // Asked CONCURRENTLY — independent services, and a cleanup walks hundreds of
  // rows, so serial timeouts per token are the difference between a run and an
  // afternoon.
  const [ds, gt2, pad, cg] = await Promise.all([
    ask('dexscreener', () => dsInfo(chain, address)),
    // ⚠️ GeckoTerminal's 429 arms a PROCESS-WIDE cooldown, after which every
    // read returns instantly with nothing. Calling it anyway and reading that
    // as "GT has no logo" is exactly how one rate limit deleted eighty-three
    // rows' worth of evidence.
    gtDown() ? Promise.resolve(unreachable.push('geckoterminal: cooldown') && null) : ask('geckoterminal', () => gtInfo(chain, address)),

    ask('launchpad', () => (padInfo ? padInfo(chain, address) : null)),
    ask('coingecko', () => cgInfo(chain, address)),
  ]);
  if (cg && cg.ok === false) unreachable.push(`coingecko: ${cg.why}`);
  if (gt2 && gt2.ok === false) unreachable.push(`geckoterminal: ${gt2.why}`);

  const candidates = [
    ['dexscreener', httpsUrl(ds && ds.logoUrl)],
    // `.url` from gtLogo; `.logoUrl` is the shape a caller's own stub may use.
    ['geckoterminal', httpsUrl(gt2 && (gt2.url || gt2.logoUrl))],
    ['launchpad', httpsUrl(pad && pad.logoUrl)],
    ['coingecko', httpsUrl(cg && cg.url)],
    ['trustwallet', httpsUrl(trustWallet(chain, address))],
    ['dexscreener-cdn', httpsUrl(cdnGuess(chain, address))],
  ];

  for (const [source, url] of candidates) {
    if (!url) continue;
    tried.push(source);
    if (await verify(url)) return { ok: true, url, source, tried, unreachable };
  }

  // ⚠️ `ok` is the whole point of this return shape. `ok:true, url:null` means
  // every source ANSWERED and none had artwork — the only state in which a
  // caller may delete the listing. `ok:false` means at least one could not be
  // asked, and the honest answer is "not yet known".
  const ok = unreachable.length === 0;
  if (!ok) log.debug(`[tokenlogo] ${chain}/${address}: undecided — ${unreachable.join(', ')}`);
  return { ok, url: null, source: null, tried, unreachable };
}

module.exports = { resolveLogo, isImage, cdnGuess, trustWallet, coingecko, gtLogo, CG_PLATFORM, TW_CHAIN, _httpsUrl: httpsUrl };
