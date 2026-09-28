'use strict';
/*
 * THE TOKENS THAT ARE ACTUALLY MOVING, per chain — a discovery source that asks
 * the auto-lister's real question.
 *
 * "mengapa free listing not much work padahal setiap hari ada project memecoin
 * yang 1m ke atas mcnya" (2026-09-28), over an ops line reading
 * "Auto-Listing has published nothing for 41h — the last scan priced 12 and none
 * qualified — below its trigger ×12".
 *
 * Every word of that line was true, and it was measuring the wrong market. The
 * only discovery feeds were DexScreener's `token-profiles/latest` and
 * `token-boosts/*` — a SNAPSHOT of whoever published a profile or paid for a
 * boost in the last few minutes. That is a stream of minutes-old microcaps, and
 * a token that is minutes old is at $30k, not $1M. So the feed saw every future
 * $1M project while it was still tiny, turned it down "below its trigger", and
 * by the time it crossed $1M it had long since scrolled off a "latest" feed and
 * was never looked at again. The scanner was structurally blind to exactly the
 * tokens it exists for, with every light on the panel green.
 *
 * GeckoTerminal's `trending_pools` IS the question: the pools the market is
 * trading hardest right now, per network, with the market cap already on each
 * row. One request per chain per scan (scans are 25–90 min apart), so a handful
 * of GT requests an hour — against the ~30/min per-IP ceiling this box shares.
 *
 * ⚠️ THE CAP ON EACH ROW IS A HINT, NEVER A VERDICT. It is GT's `market_cap_usd`
 * or, far more often, its `fdv_usd` — and the auto-lister's gates are judged on
 * its OWN pricing read, as always. What the hint buys is ORDER: a candidate
 * already known to sit near the floor goes to the front of the lookup budget
 * instead of behind forty minutes-old launches. Nothing is listed or refused on
 * GT's word.
 *
 * ONE GeckoTerminal client, the shared one (`group/gtPairs`), at background
 * priority behind the same 429 cooldown as everything else — the rule
 * `bigCoins.js` states for the same reason: a second client would have its own
 * idea of the quota and the buy bot would pay for it.
 *
 * SAME CONTRACT as every other source here: `{ items, ok, why }`, never throws,
 * and `ok:false` is "we could not ask", never "nothing is moving".
 */
const gt = require('../group/gtPairs');
const { notAProject } = require('./bigCoins');
const log = require('../helpers/logger');

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Blank is ON — `raid/sourceFlag.js`'s rule. `0`/`false`/`off` is the kill switch.
const enabled = () => !/^(0|false|off|no)$/i.test(String(process.env.AUTOLIST_MOVERS || '').trim());

// Where the $1M memecoins actually are. Used only when the operator has not
// scoped the auto-lister to particular chains — a scope wins, because spending
// GT requests on a chain the scan will skip anyway is quota for nothing.
const DEFAULT_CHAINS = ['solana', 'bsc', 'base', 'ethereum'];
// A ceiling on requests per scan whatever the scope says. Twenty chains would
// be twenty GT slots queued behind the buy bot's realtime reads.
const MAX_CHAINS = 6;

function chainsFor(scope) {
  const env = String(process.env.AUTOLIST_MOVER_CHAINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const base = Array.isArray(scope) && scope.length ? scope : env.length ? env : DEFAULT_CHAINS;
  // Only chains GT can be asked about. A chain with no network id is not
  // "nothing moving" — it is a chain this source cannot see, and it is skipped
  // rather than reported as empty.
  return [...new Set(base)].filter((c) => gt.networkOf(c)).slice(0, MAX_CHAINS);
}

/**
 * Pure: a GT pools response → candidates, one per BASE token, deepest pool kept.
 * Exported so the parsing is tested by being called, not by reading it.
 */
function parsePools(body, chain) {
  const tokens = new Map();
  for (const inc of (body && body.included) || []) {
    if (inc && inc.type === 'token' && inc.id) tokens.set(inc.id, inc.attributes || {});
  }
  const best = new Map();
  for (const pool of (body && body.data) || []) {
    const a = (pool && pool.attributes) || {};
    const rel = pool && pool.relationships && pool.relationships.base_token && pool.relationships.base_token.data;
    const t = rel ? tokens.get(rel.id) : null;
    // No included token means no address we can trust — the pool's own name is
    // "PEPE / WETH", which is not a contract.
    if (!t || !t.address) continue;
    // The money, not a project — the one owner of that set, shared with the
    // market filler and the site. A mover list's top rows are very often WETH.
    if (notAProject(t.symbol, t.name)) continue;
    const item = {
      chain,
      address: String(t.address),
      mcapHint: num(a.market_cap_usd) || num(a.fdv_usd),
      liq: num(a.reserve_in_usd) || 0,
    };
    const key = item.address.toLowerCase();
    const prev = best.get(key);
    // One token, many pools: judged by its deepest. A thin sibling pool's fdv
    // is how a real token reads as a different size.
    if (!prev || item.liq > prev.liq) best.set(key, item);
  }
  return [...best.values()].map(({ chain: c, address, mcapHint }) => ({ chain: c, address, mcapHint }));
}

// ⚠️ A BUDGET, because `gtGet` waits on `gtSlot`, which has NO DEADLINE OF ITS
// OWN — the defect CLAUDE.md records for the listing form ("the form was queued
// behind every timer job"). On the keyless tier a slot is seconds apart and the
// buy bot's realtime reads jump the queue, so six chains could hold the scan —
// and a ⚡ Run now waiting on it — for minutes. Past the budget a chain is
// skipped with its reason; its request is left RUNNING and still fills the
// cache, so the next scan gets it for free.
const BUDGET_MS = (() => {
  const raw = String(process.env.AUTOLIST_MOVERS_MS || '').trim();
  const n = raw === '' ? NaN : Number(raw); // blank is ABSENT — `Number('')` is 0
  return Number.isFinite(n) && n >= 1_000 ? n : 25_000;
})();

// Not unref'd: the scan is awaiting it. Cleared on the winning path, or a 25s
// budget holds the loop open 25s past a 200ms answer.
function within(p, ms) {
  let t;
  const deadline = new Promise((r) => (t = setTimeout(() => r({ late: true }), ms)));
  return Promise.race([p.then((v) => ({ v })), deadline]).finally(() => clearTimeout(t));
}

// A scan and a 🔎 Test scan minutes apart must not each spend a GT request per
// chain on the same question. Short enough that a new mover is seen next scan.
const TTL_MS = 10 * 60_000;
const cache = new Map(); // chain → { at, items }

/**
 * @param chains  the auto-lister's chain scope (empty = the defaults above)
 * @param get     test seam for `gt.gtGet`
 */
async function fetchMoversX({ chains = [], get = gt.gtGet, now = Date.now(), budgetMs = BUDGET_MS } = {}) {
  if (!enabled()) return { items: [], ok: true, why: 'AUTOLIST_MOVERS=0', chains: [] };
  const list = chainsFor(chains);
  if (!list.length) return { items: [], ok: true, why: 'no chain in scope has a GeckoTerminal network', chains: [] };
  const lists = [];
  const whys = [];
  let answered = 0;
  const started = Date.now();
  for (const chain of list) {
    const hit = cache.get(chain);
    if (hit && now - hit.at < TTL_MS) {
      lists.push(hit.items);
      answered++;
      continue;
    }
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) {
      whys.push(`${chain}: skipped — the GeckoTerminal queue used the whole ${Math.round(budgetMs / 1000)}s budget`);
      lists.push([]);
      continue;
    }
    const net = gt.networkOf(chain);
    const req = Promise.resolve(get(`/networks/${net}/trending_pools`, { include: 'base_token', page: 1, duration: '24h' })).catch((e) => ({
      ok: false,
      status: 0,
      reason: e.message,
    }));
    const r = await within(req, left);
    if (r.late) {
      // Left running: a late answer is still an answer for the NEXT scan.
      req.then((res) => res && res.ok && cache.set(chain, { at: now, items: parsePools(res.body, chain) })).catch(() => {});
      whys.push(`${chain}: no GeckoTerminal slot within ${Math.round(left / 1000)}s`);
      lists.push([]);
      continue;
    }
    const res = r.v;
    if (!res || !res.ok) {
      // NAMED, per chain: "GT rate limited" sends an operator to a key, a 404
      // on one network sends them to its id — and neither is a quiet market.
      whys.push(`${chain}: ${(res && res.reason) || `HTTP ${res && res.status}`}`);
      lists.push([]);
      continue;
    }
    answered++;
    const items = parsePools(res.body, chain);
    cache.set(chain, { at: now, items });
    lists.push(items);
  }
  // Interleaved across chains, for the reason `discovery.js` interleaves its
  // sources: the caller has a lookup budget, and concatenating would hand all
  // of it to whichever chain came first.
  const out = [];
  const seen = new Set();
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < depth; i++) {
    for (const l of lists) {
      const c = l[i];
      if (!c) continue;
      const k = `${c.chain}:${c.address.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }
  const ok = answered > 0;
  if (whys.length) log.debug(`[movers] ${whys.join(' · ')}`);
  return { items: out, ok, why: whys.length ? whys.join(' · ') : null, chains: list };
}

/** Test seam. */
function _reset() {
  cache.clear();
}

module.exports = { fetchMoversX, parsePools, chainsFor, DEFAULT_CHAINS, MAX_CHAINS, _reset };
