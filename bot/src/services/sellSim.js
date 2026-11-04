'use strict';
/**
 * CAN A HOLDER SELL IT? — asked of the CHAIN, for the chains no safety API covers.
 *
 * "INI TOKEN ANDA FREE LISTING TOKEN HONEYPOT" — $NASDUCK on Robinhood Chain,
 * free-listed, then announced "+1900%" while GMGN printed "Possible honeypot!
 * Buying is allowed". `listingSafety` asks GoPlus (EVM) and RugCheck (Solana),
 * and GoPlus does not cover Robinhood — nor Polygon, Optimism, Avalanche, Blast,
 * Sonic and the rest of the tracked EVM chains — so on all of them the contract
 * check PASSED BY DEFAULT. The honeypot was refused by nothing because nothing
 * was able to ask.
 *
 * The chain itself can be asked. A honeypot lets anyone buy and reverts the
 * sell, and a sell begins with the holder's tokens moving INTO the venue that
 * sold them (the pair, the v3 pool, the v4 PoolManager). So:
 *
 *   1. read the token's recent Transfer logs, newest first;
 *   2. keep the ones that came OUT of a contract (a buy: pool → wallet) INTO a
 *      plain wallet that can sign a sell;
 *   3. for a few such buyers still holding it, `eth_call` the token's own
 *      `transfer(venue, 1% of balance)` FROM that buyer — the first leg of
 *      selling it back where it came from.
 *
 * One buyer whose sell goes through is enough: the token can be sold. Every
 * buyer tried (at least MIN_BLOCKED of them) reverting — or the token
 * answering `false` — is the honeypot. Anything short of that is
 * INCONCLUSIVE, which `listingSafety` reports as "could not ask": never safe,
 * never a scam, asked again next scan. `eth_call` moves nothing and costs
 * nothing; no key is involved anywhere.
 *
 * ⚠️ What this does NOT see: a sell TAX (the transfer succeeds, the seller is
 * paid 1%) and a block keyed on the router rather than on the pool. Those are
 * GoPlus's simulation's job where GoPlus exists; here the market checks
 * (`listingQuality` §5–6: one-way market, a pool that cannot back the cap) are
 * the second line. A honeypot that reverts the sell — the common kind, and
 * GMGN's "Buying is allowed" — is what this catches.
 *
 * `FREE_LISTING_SELL_SIM=0` turns it off (an uncovered chain then passes, as it
 * used to). Blank is ON — the `raid/sourceFlag.js` rule.
 */
const rpcCfg = require('../config/rpc');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SEL_BALANCE_OF = '0x70a08231';
const SEL_TRANSFER = '0xa9059cbb';
const ZERO = '0x0000000000000000000000000000000000000000';
const BURN = new Set([ZERO, '0x000000000000000000000000000000000000dead']);

// How hard to look. A token past a $1M cap with $50k of daily volume has
// buyers in the last few thousand blocks on any chain; the window grows
// backwards in CHUNKs until enough are found, and halves on a node that
// refuses the range.
const BUYERS = 3; // sells to try
const MIN_BLOCKED = 2; // reverts needed, with no success, to call it a honeypot
const CHUNK = 5000;
const MIN_CHUNK = 500;
const MAX_WINDOWS = 10;
const MAX_CODE_READS = 60;
const DEADLINE_MS = 25_000;

const enabled = () => {
  const v = String(process.env.FREE_LISTING_SELL_SIM == null ? '' : process.env.FREE_LISTING_SELL_SIM).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
};

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const pad32 = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const topicAddr = (t) => '0x' + String(t || '').slice(-40).toLowerCase();
const hex = (n) => '0x' + Math.max(0, n).toString(16);
const encBalanceOf = (a) => SEL_BALANCE_OF + pad32(a);
const encTransfer = (to, amount) => SEL_TRANSFER + pad32(to) + amount.toString(16).padStart(64, '0');

/** A JSON-RPC error that is the CONTRACT refusing, not the node failing. */
const isRevert = (err) => !!err && (Number(err.code) === 3 || /revert/i.test(String(err.message || '')));
/** An ERC-20 that answers `false` instead of reverting has refused just the same.
 *  An empty return (USDT-style tokens return nothing) is a success. */
const returnedFalse = (result) => /^0x0{64}$/.test(String(result || ''));

/**
 * One JSON-RPC request. THROWS only on transport — an HTTP failure or a dead
 * socket — so `rpcRead` walks to the next endpoint; a JSON-RPC error (a revert,
 * a range the node will not serve) is RETURNED as `{ error }`, because it is
 * the same answer on every endpoint.
 */
async function jsonRpc(url, method, params, timeoutMs = 8000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j && j.error) return { error: j.error };
  return { result: j ? j.result : null };
}

function defaultRpc(chain) {
  return async (method, params) => {
    const { value } = await rpcCfg.rpcRead(chain, (url) => jsonRpc(url, method, params), { timeoutMs: 8000, budgetMs: 15_000 });
    return value;
  };
}

/**
 * @param {string} chain   our chain key (picks the RPC list)
 * @param {string} token   0x token address
 * @param {object} [o]
 * @param {string} [o.pool] the pair/pool address when known (DexScreener's
 *   `pairAddress`). A v4 pool's id is 32 bytes and is not an address — then the
 *   venue is whatever contract the buys came out of (the PoolManager).
 * @param {Function} [o.rpc] `(method, params) → {result}|{error}`; a test seam.
 * @returns {Promise<{ok:true, sells:true, tried}|{ok:true, sells:false, why, tried}|{ok:false, why, tried?}|{ok:true, unsupported:true, why}>}
 */
async function sellCheckX(chain, token, o = {}) {
  if (!isAddr(token)) return { ok: true, unsupported: true, why: 'not an EVM token address' };
  let rpc = o.rpc;
  if (!rpc) {
    if (!rpcCfg.rpcUrls(chain).length) return { ok: true, unsupported: true, why: `no RPC configured for ${chain}` };
    rpc = defaultRpc(chain);
  }
  const buyers = o.buyers || BUYERS;
  const started = Date.now();
  const deadline = o.deadlineMs || DEADLINE_MS;
  const late = () => Date.now() - started > deadline;
  const tokenLc = token.toLowerCase();
  const poolLc = isAddr(o.pool) ? String(o.pool).toLowerCase() : null;

  const call = async (method, params) => {
    const r = await rpc(method, params);
    if (r && r.error) {
      const e = new Error(String(r.error.message || 'rpc error').slice(0, 160));
      e.rpc = r.error;
      throw e;
    }
    return r ? r.result : null;
  };

  let head;
  try {
    head = parseInt(await call('eth_blockNumber', []), 16);
  } catch (e) {
    return { ok: false, why: `could not read the chain head: ${e.message}` };
  }
  if (!Number.isFinite(head) || head <= 0) return { ok: false, why: 'the chain head was unreadable' };

  // getCode per address, cached and capped: a busy token's window can name
  // hundreds of wallets, and this is not worth more than a few dozen reads.
  const code = new Map();
  let codeReads = 0;
  const isContract = async (a) => {
    if (code.has(a)) return code.get(a);
    if (codeReads >= MAX_CODE_READS) return null;
    codeReads++;
    const c = String((await call('eth_getCode', [a, 'latest'])) || '0x');
    // An EIP-7702 delegation (0xef0100…) is still a wallet that signs its own sells.
    const v = c !== '0x' && !/^0xef0100/i.test(c);
    code.set(a, v);
    return v;
  };

  const candidates = [];
  const seen = new Set();
  let to = head;
  let size = o.chunk || CHUNK;
  let windows = 0;
  while (candidates.length < buyers * 2 && windows < (o.maxWindows || MAX_WINDOWS) && to > 0 && !late() && codeReads < MAX_CODE_READS) {
    const from = Math.max(0, to - size + 1);
    let logs;
    try {
      logs = await call('eth_getLogs', [{ address: token, topics: [TRANSFER_TOPIC], fromBlock: hex(from), toBlock: hex(to) }]);
    } catch (e) {
      // A node that will not serve the range says so as an ERROR, not as an
      // empty answer — halve and retry before giving up on the chain.
      if (size > MIN_CHUNK) {
        size = Math.max(MIN_CHUNK, Math.floor(size / 2));
        continue;
      }
      return { ok: false, why: `could not read its transfers: ${e.message}` };
    }
    windows++;
    const list = Array.isArray(logs) ? logs.slice().reverse() : []; // newest first
    for (const l of list) {
      if (late() || candidates.length >= buyers * 2) break;
      if (!l || !Array.isArray(l.topics) || l.topics.length < 3) continue;
      const src = topicAddr(l.topics[1]);
      const dst = topicAddr(l.topics[2]);
      if (BURN.has(src) || BURN.has(dst) || dst === tokenLc || src === dst || seen.has(dst)) continue;
      if (poolLc && src !== poolLc) continue; // the pool is known: only ITS buys
      let srcC;
      let dstC;
      try {
        srcC = await isContract(src);
        if (!srcC) continue; // wallet to wallet — not a buy
        dstC = await isContract(dst);
      } catch {
        continue;
      }
      if (dstC !== false) continue; // a contract (or unread) cannot be the seller we simulate
      seen.add(dst);
      candidates.push({ holder: dst, venue: src });
    }
    to = from - 1;
  }

  const tried = [];
  for (const c of candidates) {
    if (tried.length >= buyers || late()) break;
    let bal;
    try {
      bal = BigInt((await call('eth_call', [{ to: token, data: encBalanceOf(c.holder) }, 'latest'])) || '0x0');
    } catch {
      continue;
    }
    if (bal <= 0n) continue; // sold out already — says nothing either way
    const amount = bal / 100n > 0n ? bal / 100n : bal;
    let verdict = null;
    try {
      const out = await rpc('eth_call', [{ from: c.holder, to: token, data: encTransfer(c.venue, amount) }, 'latest']);
      if (out && out.error) verdict = isRevert(out.error) ? 'reverted' : null;
      else verdict = returnedFalse(out && out.result) ? 'returned false' : 'ok';
    } catch {
      verdict = null; // the node did not answer this one — no proof either way
    }
    if (!verdict) continue;
    tried.push({ holder: c.holder, venue: c.venue, verdict });
    if (verdict === 'ok') return { ok: true, sells: true, tried, why: null };
  }

  if (tried.length >= MIN_BLOCKED) {
    return {
      ok: true,
      sells: false,
      tried,
      why: `a sell back into the pool ${tried[0].verdict === 'returned false' ? 'is refused' : 'reverts'} for ${tried.length} of ${tried.length} recent buyers`,
    };
  }
  let why;
  if (tried.length) why = `only ${tried.length} buyer could be simulated, and it could not sell`;
  else if (candidates.length) why = 'no recent buyer still holds it';
  else why = `no recent buyer found in ${windows} log window${windows === 1 ? '' : 's'}`;
  return { ok: false, tried, why };
}

module.exports = { sellCheckX, enabled, jsonRpc, isRevert, returnedFalse, encTransfer, encBalanceOf, TRANSFER_TOPIC, BUYERS, MIN_BLOCKED };
