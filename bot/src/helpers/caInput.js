// What TOKEN does this message mean?
//
// One owner for every place a person hands the bot a contract: the listing
// form, /settoken and its reply, the group's "activate this token?" card, Mass
// DM, Trending, the gainers slot swap and a bare paste in the DM.
//
// Reported 2026-10-30 with https://dexscreener.com/bsc/0x20da3ebe…b546554:
// DexScreener carried the token and the bot "could not read the CA". The
// address in a DexScreener URL is the POOL (shared/dexscreener/pair.js says
// why), and every reader here asked only "which token is this?". So a link was
// refused as "not a valid address", and a pair address pasted on its own went
// on to be priced, tracked — and on the listing form, LISTED — as if it were
// the token. Nothing could ever price that row again.
//
// Rules:
//
//  • THE ANSWER IS ALWAYS THE TOKEN. A caller that stores an address stores
//    `address` from here, never what was typed — the pair goes in `pair`, for
//    the one caller (the buy bot) that wants to watch that exact pool.
//
//  • A LINK WE COULD NOT VERIFY IS REFUSED, A BARE ADDRESS IS NOT. A link is
//    almost always a pair, so treating one as a token while DexScreener is not
//    answering would put the pool on a paid listing. A bare address is almost
//    always a token, and refusing every paste whenever DexScreener refuses this
//    box would switch the whole intake off over a check — so it fails OPEN to
//    exactly the behaviour that shipped before this existed.
//
//  • ONE CHAIN WHEN THE FLOW FIXED ONE. The listing form picks the chain first,
//    so the check there is one request to the documented pair endpoint.
//    Elsewhere the candidates are `probeChains`, the list the buy bot has
//    always probed — one owner, re-exported by group/setup.js.
//
//  • EVERY SUBSTITUTION AND EVERY REFUSAL IS LOGGED, HERE. The card a person
//    sees says it in chat, and a chat is not something an operator can grep.
//    The problem this module exists for was found by a screenshot; a pm2 line
//    per outcome is what lets the next one be found by `grep -F '[ca]'`. A link
//    refused because DexScreener could not be ASKED is a WARN (the ops channel,
//    de-duplicated): that state switches link reading off for every person at
//    once, and it is a fault of ours, never of the paste.
const dexscreener = require("../dexscreener");
const dsPair = require("../../../shared/dexscreener/pair");
const { CHAINS, isValidAddress } = require("../config/chains");
const log = require("./logger");

const short = (a) => {
  const s = String(a || "");
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
};
/** The pm2 line for a pair resolved to its token. Short addresses only — the
 *  full ones are on the card the person just got, and this is a log. */
function notePair(pair, from) {
  const sym = pair.token.symbol ? ` ($${String(pair.token.symbol).replace(/^\$+/, "")})` : "";
  log.info(`[ca] ${from} ${short(pair.pairAddress)} is a DexScreener pair on ${pair.chain} — using its token ${short(pair.token.address)}${sym}`);
}

// https://dexvra.io/token/<chain>/<address> — the site's own token page.
const DEXVRA_LINK = /\/token\/([a-z0-9]+)\/([^/\s?#]+)/i;

/** Candidate chains to probe for a pasted address, by shape. Ordered so the
 *  most likely wins first. Moved here from group/setup.js unchanged — a second
 *  copy is how the buy bot and the listing bot would come to probe a different
 *  set of chains for the same paste. */
function probeChains(address) {
  const a = String(address || "");
  if (/^0x[a-fA-F0-9]{40}$/.test(a)) return ["ethereum", "bsc", "base", "robinhood", "plasma", "elysium"];
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return ["tron"];
  if (/^(EQ|UQ|0:)/.test(a)) return ["ton"];
  if (/^0x[a-fA-F0-9]+::/.test(a)) return ["sui"];
  return ["solana"]; // base58 mint
}

/**
 * Sync, no network: what KIND of thing was pasted.
 *   { kind: "dexvra", address, chain }
 *   { kind: "dslink", address, slug, chain }   chain null if Dexvra lacks the network
 *   { kind: "address", address }
 *   null — neither a link nor anything shaped like an address
 */
function parseInput(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const ds = dsPair.parseLink(s);
  if (ds) return { kind: "dslink", address: ds.address, slug: ds.slug, chain: ds.slug ? dexscreener.chainOfSlug(ds.slug) : null };
  const d = DEXVRA_LINK.exec(s);
  if (d && isValidAddress(d[1].toLowerCase(), d[2])) return { kind: "dexvra", address: d[2], chain: d[1].toLowerCase() };
  if (/\s/.test(s)) return null;
  if (Object.keys(CHAINS).some((c) => isValidAddress(c, s))) return { kind: "address", address: s };
  return null;
}

const pairResult = (pair) => ({ address: pair.token.address, chain: pair.chain, via: "pair", pair, refused: null });

/**
 * Full answer.
 *   resolveInput(text, { chain, chains, pairCheck })
 *     chain     — the chain the flow already fixed; only that one is asked
 *     chains    — candidates when nothing fixed one (default: probeChains)
 *     pairCheck — false to skip the network for a BARE address (callers that
 *                 run their own token lookup first and ask `asPair` on a miss)
 *
 *   → null                                   nothing usable in the message
 *   → { address, chain, via, pair, refused }
 *       via: "dexvra" | "link" | "pair" | "plain"
 *       refused: a sentence when the input cannot be read honestly (a link we
 *                could not verify, a network Dexvra does not support); the
 *                caller says it and stops
 *       unverified: on a BARE address, the reason DexScreener could not be
 *                asked whether it is a pair — it is used as typed (fail open,
 *                see the header). null when it was asked. ⚠️ "not a pair" and
 *                "we could not ask" otherwise come back identical, and ca:check
 *                once printed a green "no listing is stored as a pair" over
 *                hundreds of rows its own 429 had stopped it asking about.
 */
async function resolveInput(text, { chain = null, chains = null, pairCheck = true } = {}) {
  const p = parseInput(text);
  if (!p) return null;
  if (p.kind === "dexvra") return { address: p.address, chain: p.chain, via: "dexvra", pair: null, refused: null };

  if (p.kind === "dslink") {
    if (p.slug && !p.chain) {
      log.info(`[ca] a DexScreener link on "${p.slug}" was refused — not a network Dexvra supports`);
      return { address: p.address, chain: null, via: "link", pair: null, refused: `that DexScreener link is on "${p.slug}", a network Dexvra doesn't support` };
    }
    const ask = p.chain ? [p.chain] : chain ? [chain] : (chains && chains.length ? chains : probeChains(p.address));
    const r = await dexscreener.fetchPairX(p.address, ask);
    if (r.pair && r.pair.chain) return (notePair(r.pair, "link"), pairResult(r.pair));
    if (!r.ok) {
      // No address in the message: the dedupe key keeps addresses distinct, and
      // this is ONE fault however many people paste a link while it lasts.
      log.warn(`[ca] a DexScreener link was refused — DexScreener could not be asked (${r.why}). Links cannot be read until it answers; a bare contract still works.`);
      return {
        address: p.address,
        chain: p.chain,
        via: "link",
        pair: null,
        refused: `couldn't read that DexScreener link just now (${r.why}) — paste the token's contract address instead, or try again in a minute`,
      };
    }
    // Every chain answered and it is not a pair: the link opened a TOKEN page.
    return { address: p.address, chain: p.chain || chain || null, via: "link", pair: null, refused: null };
  }

  // A bare address.
  const fixed = chain && isValidAddress(chain, p.address) ? chain : null;
  let unverified = null;
  if (pairCheck) {
    const ask = fixed ? [fixed] : (chains && chains.length ? chains : probeChains(p.address));
    const r = await dexscreener.fetchPairX(p.address, ask);
    if (r.pair && r.pair.chain) return (notePair(r.pair, "address"), pairResult(r.pair));
    // r.ok false → could not ask: FAIL OPEN, see the header — and SAY so, or a
    // pair that slipped through as a token is invisible until it is listed.
    if (!r.ok) {
      unverified = r.why || "DexScreener did not answer";
      log.info(`[ca] ${short(p.address)} taken as typed — could not ask DexScreener whether it is a pair (${r.why})`);
    }
  }
  return { address: p.address, chain: fixed, via: "plain", pair: null, refused: null, unverified };
}

/**
 * resolveInput with a deadline, for the flows that have a person waiting and
 * no ceiling of their own. Null on timeout — "we could not ask in time", which
 * every caller treats as the input as typed (a bare address) or a refusal (a
 * link). ⚠️ The timer is NOT unref'd (somebody is awaiting it) and is cleared
 * on the winning path — the helpers/bounded.js scar, written down again.
 */
const CA_INPUT_MS = Math.max(1000, Number(process.env.CA_INPUT_MS) || 5000);
function resolveInputSoon(text, opts, ms = CA_INPUT_MS) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    Promise.resolve()
      .then(() => module.exports.resolveInput(text, opts))
      .then(
        (v) => { clearTimeout(t); resolve(v); },
        () => { clearTimeout(t); resolve(null); },
      );
  });
}

/** Only the pair check, for a caller whose own token lookup just missed. */
async function asPair(address, chains) {
  const r = await dexscreener.fetchPairX(address, chains && chains.length ? chains : probeChains(address));
  if (r.pair && r.pair.chain) return (notePair(r.pair, "address"), r.pair);
  return null;
}

/** Template vars for `ca_pair_resolved` — the card that says the address was a
 *  pair and which token is being used instead. A substitution the person did
 *  not see happen is a token they did not choose. */
function pairVars(pair) {
  const { chainOf } = require("../config/chains");
  const ch = pair && pair.chain ? chainOf(pair.chain) : null;
  const sym = pair && pair.token.symbol ? `$${String(pair.token.symbol).replace(/^\$+/, "")}` : "the token";
  return { symbol: sym, address: pair ? pair.token.address : "", chain: (ch && ch.label) || (pair && pair.chain) || "" };
}

module.exports = { parseInput, resolveInput, resolveInputSoon, asPair, probeChains, pairVars, CA_INPUT_MS };
