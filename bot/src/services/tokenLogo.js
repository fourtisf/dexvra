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
const marketdata = require('../marketdata');
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

async function coingecko(chain, address) {
  const plat = CG_PLATFORM[chain];
  if (!plat || !address) return null;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${plat}/contract/${encodeURIComponent(address)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    // 404 is the ordinary answer here — CoinGecko is curated, so most tokens a
    // seeding run finds are simply not in it. Never a reason to warn.
    if (!res.ok) return null;
    const j = await res.json();
    const img = j && j.image;
    return httpsUrl((img && (img.large || img.small || img.thumb)) || null);
  } catch {
    return null;
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
  const gtInfo = deps.gtInfo || marketdata.fetchMarket;
  const padInfo = deps.padInfo || launchpads.fetchTokenInfo;
  const cgInfo = deps.cgInfo || coingecko;
  const verify = deps.isImage || isImage;

  const tried = [];
  const candidates = [];

  // 1 + 2 + 3 are ASKED CONCURRENTLY — they are independent services and a
  // cleanup walks hundreds of rows, so three serial timeouts per token is the
  // difference between a run and an afternoon.
  const [ds, gt, pad, cg] = await Promise.all([
    Promise.resolve()
      .then(() => dsInfo(chain, address))
      .catch(() => null),
    Promise.resolve()
      .then(() => gtInfo(chain, address))
      .catch(() => null),
    Promise.resolve()
      .then(() => (padInfo ? padInfo(chain, address) : null))
      .catch(() => null),
    Promise.resolve()
      .then(() => cgInfo(chain, address))
      .catch(() => null),
  ]);
  candidates.push(['dexscreener', httpsUrl(ds && ds.logoUrl)]);
  candidates.push(['geckoterminal', httpsUrl(gt && gt.logoUrl)]);
  candidates.push(['launchpad', httpsUrl(pad && pad.logoUrl)]);
  candidates.push(['coingecko', httpsUrl(cg)]);
  candidates.push(['trustwallet', httpsUrl(trustWallet(chain, address))]);
  candidates.push(['dexscreener-cdn', httpsUrl(cdnGuess(chain, address))]);

  for (const [source, url] of candidates) {
    if (!url) continue;
    tried.push(source);
    if (await verify(url)) return { url, source, tried };
  }
  log.debug(`[tokenlogo] ${chain}/${address}: no logo from ${tried.join(', ') || 'any source'}`);
  return null;
}

module.exports = { resolveLogo, isImage, cdnGuess, trustWallet, coingecko, CG_PLATFORM, TW_CHAIN, _httpsUrl: httpsUrl };
