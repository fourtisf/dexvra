'use strict';
/*
 * "What does this token's OWN CONTRACT call itself?" — and does the name we are
 * about to publish agree?
 *
 * "harusnya tokenya btc not ltc" (2026-11-05): C5xph…pump, Big Titty Coin
 * ($BTC), went out to 12,338 subscribers as Little Titty Coin ($LTC) — name,
 * ticker, logo and every figure — because the market data had been read off a
 * stranger's deeper pool. The cause is fixed in both indexers' readers
 * (shared/dexscreener/tokenPairs.js, shared/geckoterminal/poolSide.js). This is
 * what keeps the NEXT cause, whatever it is, from publishing another token's
 * name: the indexers are third parties describing the token from the outside;
 * the token's own metadata — a Solana mint's Metaplex / Token-2022 record, an
 * EVM contract's symbol() — is the one source that cannot be about somebody
 * else. The Pons and BINWISE rounds in CLAUDE.md, applied to the IDENTITY.
 *
 * Rules, each a way this could mislead:
 *
 *  • "WE COULD NOT ASK" IS NEVER A VERDICT. An RPC that did not answer is
 *    `ok:false`, and every caller FAILS OPEN on it: on this box the Solana RPC
 *    answers 429 on a busy minute, and refusing every free listing whenever it
 *    does would switch the feed off over a check. Chosen deliberately: the
 *    indexer readers are already fixed and this is the second line.
 *  • A CONTRACT WITH NO SYMBOL MAKES NO CLAIM. An empty Metaplex record, a
 *    bytes32 ticker, a symbol() that reverts — nothing to compare, never a
 *    mismatch.
 *  • TICKERS ARE COMPARED THE WAY WE PUBLISH THEM: through `sanitizeTicker`,
 *    so "PEPE🐸" on chain and "PEPE" on the card are the same token, and case
 *    and a leading "$" never decide anything.
 */
const solanaMeta = require('../solanaMeta');
const chainPools = require('../group/chainPools');
const { sanitizeTicker } = require('../helpers/ticker');
const log = require('../helpers/logger');

/** Seams for the tests. Production reads the chain through the two existing
 *  owners — never a third private reader of the same accounts. */
const _deps = {
  solana: (address, o) => solanaMeta.fetchTokenInfoX('solana', address, o),
  solanaCovers: () => solanaMeta.covers('solana'),
  evm: (chain, address, o) => chainPools.tokenMetaX(chain, address, o),
  evmCovers: (chain) => chainPools.supports(chain),
};

/** Blank is ON (raid/sourceFlag.js's rule); only an explicit off switches it off. */
function enabled() {
  const raw = process.env.LISTING_IDENTITY;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * `{ ok, symbol, name, why }` from the token's own contract. `ok:false` means
 * the chain could not be asked; `ok:true` with `symbol:null` is an answer with
 * nothing to compare (no metadata, no reader for this chain).
 */
async function readX(chain, address, { budgetMs = 5000 } = {}) {
  const addr = String(address || '').trim();
  if (!addr) return { ok: true, symbol: null, name: null, why: 'no address' };
  try {
    if (chain === 'solana') {
      if (!_deps.solanaCovers()) return { ok: true, symbol: null, name: null, why: 'on-chain metadata reading is off (SOLANA_META=0)' };
      const r = await _deps.solana(addr, { budgetMs });
      const info = r && r.info;
      // The on-chain half is enough: a metadata DOCUMENT that could not be
      // fetched still leaves the name and ticker the mint itself carries.
      if (info && info.symbol) return { ok: true, symbol: str(info.symbol, 40), name: str(info.name, 80) || null, why: null };
      if (!r || !r.ok) return { ok: false, symbol: null, name: null, why: (r && r.why) || 'the Solana metadata read did not answer' };
      return { ok: true, symbol: null, name: null, why: r.why || 'the mint carries no symbol' };
    }
    if (_deps.evmCovers(chain)) {
      const r = await _deps.evm(chain, addr, { timeoutMs: Math.min(4000, budgetMs), budgetMs });
      if (!r || !r.ok) return { ok: false, symbol: null, name: null, why: (r && r.why) || 'the contract read did not answer' };
      return { ok: true, symbol: r.symbol ? str(r.symbol, 40) : null, name: r.name ? str(r.name, 80) : null, why: r.symbol ? null : r.why };
    }
    return { ok: true, symbol: null, name: null, why: `no on-chain identity reader for ${chain}` };
  } catch (e) {
    return { ok: false, symbol: null, name: null, why: `identity read crashed: ${str(e && e.message, 120)}` };
  }
}

/** A name or ticker as compared: letters and digits only, case-folded —
 *  "Banana For Scale" and "banana-for-scale" agree, as do LEMON.FUN and LEMONFUN. */
const key = (v) =>
  String(v == null ? '' : v)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

/**
 * ONE TOKEN, TWO SPELLINGS OF ITS TICKER. The first `identity:check -- --all`
 * flagged $LEMON over a contract saying $LEMON.FUN ("Lemon"), and $BANANAS31
 * over $BANANA ("Banana For Scale") — the ticker an exchange or a launchpad
 * uses beside the one the contract carries. A flag HOLDS that row's pump alerts
 * and tells the operator to delete it, so a false one costs a real listing.
 *
 * What told those two apart from the real mismatches is the NAME: a stranger's
 * pool carries the stranger's name AND ticker together (Little Titty Coin /
 * $LTC over Big Titty Coin / $BTC), so it is never the same name. Both are
 * required here — the same name, AND one ticker is the other with something
 * added — so a row whose name is right and whose ticker came from somewhere
 * else ($LTC published as "Big Titty Coin") is still a mismatch.
 */
function sameToken(a, b, names) {
  const pn = key(names && names.published);
  const cn = key(names && names.contract);
  if (pn.length < 3 || pn !== cn) return false;
  const x = key(a);
  const y = key(b);
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 3 && long.startsWith(short);
}

/**
 * Null when the two agree (or either is missing); otherwise
 * `{ published, contract }` in the form we publish tickers. `names` is
 * `{ published, contract }` — the listing's name and the contract's name()
 * — and lets one token's two ticker spellings agree (see `sameToken`).
 */
function conflict(published, contractSymbol, names) {
  const a = sanitizeTicker(published);
  const b = sanitizeTicker(contractSymbol);
  if (!a || !b || a === b) return null;
  if (sameToken(a, b, names)) return null;
  return { published: a, contract: b };
}

/**
 * The free-listing door's question: `{ ok, refusal, why, contract }`. A
 * mismatch is a REFUSAL (its variable parts in parentheses, so every one is a
 * single bucket on the scan line); a read that could not happen is `ok:false`
 * and the caller lists anyway, as before this check existed.
 */
async function checkX(chain, address, info, opts = {}) {
  if (!enabled()) return { ok: true, refusal: null, why: 'off', contract: null };
  const r = await readX(chain, address, opts);
  if (!r.ok) return { ok: false, refusal: null, why: r.why, contract: null };
  const c = conflict(info && info.symbol, r.symbol, { published: info && info.name, contract: r.name });
  if (!c) return { ok: true, refusal: null, why: r.why, contract: r };
  return {
    ok: true,
    refusal: `identity mismatch (the market data says $${c.published}, the contract says $${c.contract})`,
    why: null,
    contract: r,
  };
}

/** One line for the ops channel when a mismatch is caught at a door. */
function noteMismatch(where, chain, address, c) {
  log.warn(
    `[identity] ${where}: ${chain}/${address} — the market data named this token $${c.published}, but its own contract says $${c.contract}. ` +
      'An indexer read another token\'s pool. Every listing can be checked with: cd /opt/dexvra/bot && npm run identity:check',
  );
}

module.exports = { readX, conflict, checkX, enabled, noteMismatch, _deps };
