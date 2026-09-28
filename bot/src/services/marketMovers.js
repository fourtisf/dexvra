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
const { loadJSONSync, saveJSON } = require('../helpers/persist');
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

// ⚠️ THE SCAN MUST NOT WAIT ON THE GT QUEUE — IT READS WHAT THE LAST REFRESH GOT.
//
// The first cut asked GT inside the scan, bounded at 25s, and cached answers
// for 10 minutes. `listing:check` — a FRESH process with an EMPTY GT queue —
// then printed `gtmovers → 53 candidate(s)` and "5 would be listed", while ⚡ Run
// now in `dexvra-bot` answered "nothing qualified": there the same queue is
// shared with the buy bot's realtime reads and nine background pipelines, one
// slot every 12s on the keyless tier, so five chains never fit in 25s, every
// chain was skipped, and the scan saw the microcap feeds again. The late
// answers DID land — in a 10-minute cache that expired long before the next
// scan 25–90 min later. A guard measured in a process that does not share the
// production queue is `fonts:check`'s nine green ticks, one feature over.
//
// So the two questions are split:
//   • a REFRESH asks GT, in the background, concurrently for every chain, with
//     no deadline — it lands when the queue lets it, and is never awaited by a
//     caller that has a cached answer;
//   • a READ serves the newest answer on file, up to STALE_MS old. These rows
//     only ORDER the lookup budget and every gate is judged on a live pricing
//     read, so a trending list from two hours ago costs nothing but a slightly
//     staler order — while no list at all costs the whole scan.
// The answers are PERSISTED (DATA_DIR/marketMovers.json), so a restart, the
// previous scan, or an operator's `listing:check` in its own process all warm
// the cache the bot reads. A caller with NOTHING on file waits for its refresh,
// bounded by `budgetMs` — the only time a scan can spend GT's time.
const FRESH_MS = 10 * 60_000; // younger than this: do not even refresh
const STALE_MS = 6 * 3_600_000; // older than this: not served
const FILE = 'marketMovers.json';
const BUDGET_MS = (() => {
  const raw = String(process.env.AUTOLIST_MOVERS_MS || '').trim();
  const n = raw === '' ? NaN : Number(raw); // blank is ABSENT — `Number('')` is 0
  return Number.isFinite(n) && n >= 1_000 ? n : 25_000;
})();

const mem = new Map(); // chain → { at, items } — the newest answer this process holds
const inflight = new Map(); // chain → Promise<{ok, why}> — one refresh per chain at a time
let lastErr = new Map(); // chain → why the last refresh failed, for the report

function readFile() {
  const f = loadJSONSync(FILE, {});
  return f && typeof f === 'object' ? f : {};
}

/** The newest answer for `chain` — memory or disk, whichever is newer. */
function cachedFor(chain) {
  const a = mem.get(chain);
  const d = readFile()[chain];
  const b = d && Array.isArray(d.items) && Number(d.at) > 0 ? { at: Number(d.at), items: d.items } : null;
  if (!a) return b;
  if (!b) return a;
  return a.at >= b.at ? a : b;
}

// ONE WRITER AT A TIME. The chains refresh concurrently and each write is a
// read-modify-write of one file, so two landing together would each drop the
// other's chain — the lost update `setTemplate` is recorded as having.
let writeQ = Promise.resolve();
function store(chain, entry) {
  mem.set(chain, entry);
  writeQ = writeQ
    .then(async () => {
      const all = readFile();
      all[chain] = entry;
      await saveJSON(FILE, all);
    })
    .catch((e) => log.debug(`[movers] could not persist: ${e.message}`));
  return writeQ;
}

/** Ask GT for one chain, once at a time. Resolves {ok, why}; never rejects. */
function refresh(chain, get, now) {
  if (inflight.has(chain)) return inflight.get(chain);
  const net = gt.networkOf(chain);
  const p = Promise.resolve()
    .then(() => get(`/networks/${net}/trending_pools`, { include: 'base_token', page: 1, duration: '24h' }))
    .then(async (res) => {
      if (!res || !res.ok) {
        const why = (res && res.reason) || `HTTP ${res && res.status}`;
        lastErr.set(chain, why);
        return { ok: false, why };
      }
      lastErr.delete(chain);
      await store(chain, { at: now, items: parsePools(res.body, chain) });
      return { ok: true, why: null };
    })
    .catch((e) => {
      lastErr.set(chain, e.message);
      return { ok: false, why: e.message };
    })
    .finally(() => inflight.delete(chain));
  inflight.set(chain, p);
  return p;
}

// Not unref'd: somebody is awaiting it. Cleared on the winning path, or a 25s
// budget holds the loop open 25s past a 200ms answer.
function within(p, ms) {
  let t;
  const deadline = new Promise((r) => (t = setTimeout(() => r({ late: true }), ms)));
  return Promise.race([p.then((v) => ({ v })), deadline]).finally(() => clearTimeout(t));
}

/**
 * @param chains    the auto-lister's chain scope (empty = the defaults above)
 * @param get       test seam for `gt.gtGet`
 * @param budgetMs  how long a caller with NOTHING on file may wait for GT
 */
async function fetchMoversX({ chains = [], get = gt.gtGet, now = Date.now(), budgetMs = BUDGET_MS } = {}) {
  if (!enabled()) return { items: [], ok: true, why: 'AUTOLIST_MOVERS=0', chains: [] };
  const list = chainsFor(chains);
  if (!list.length) return { items: [], ok: true, why: 'no chain in scope has a GeckoTerminal network', chains: [] };

  // Every chain that is not fresh gets a refresh STARTED — concurrently, so the
  // whole set enters the GT queue together instead of one behind the other.
  const started = new Map();
  for (const chain of list) {
    const c = cachedFor(chain);
    if (!c || now - c.at >= FRESH_MS) started.set(chain, refresh(chain, get, now));
  }
  // Only a chain with nothing servable is waited on — and only within budget.
  const cold = list.filter((ch) => {
    const c = cachedFor(ch);
    return !c || now - c.at > STALE_MS;
  });
  if (cold.length && started.size) {
    await within(Promise.all(cold.filter((ch) => started.has(ch)).map((ch) => started.get(ch))), budgetMs);
  }

  const lists = [];
  const whys = [];
  let served = 0;
  for (const chain of list) {
    const c = cachedFor(chain);
    if (c && now - c.at <= STALE_MS) {
      served++;
      lists.push(c.items);
      continue;
    }
    lists.push([]);
    // NAMED, per chain: "GT rate limited" sends an operator to a key, "no slot
    // yet" says the queue is long — and neither is a quiet market.
    whys.push(`${chain}: ${lastErr.get(chain) || `no answer yet — the GeckoTerminal queue did not reach it within ${Math.round(budgetMs / 1000)}s (it will land for the next scan)`}`);
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
      const k = `${c.chain}:${String(c.address).toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }
  if (whys.length) log.debug(`[movers] ${whys.join(' · ')}`);
  return { items: out, ok: served > 0, why: whys.length ? whys.join(' · ') : null, chains: list };
}

/** Start refreshes without waiting — the auto-lister's boot, so the first scan
 *  after a deploy already has an answer on file. */
function warm(chains = [], { get = gt.gtGet, now = Date.now() } = {}) {
  if (!enabled()) return;
  for (const chain of chainsFor(chains)) {
    const c = cachedFor(chain);
    if (!c || now - c.at >= FRESH_MS) refresh(chain, get, now);
  }
}

/** Test seam: a NEW PROCESS — memory gone, the file kept. */
function _forgetMemory() {
  mem.clear();
  inflight.clear();
  lastErr = new Map();
}

/** Test seam: forget memory, in-flight refreshes and the file. */
async function _reset() {
  mem.clear();
  inflight.clear();
  lastErr = new Map();
  await writeQ;
  await saveJSON(FILE, {}).catch(() => {});
}

module.exports = { fetchMoversX, warm, parsePools, chainsFor, DEFAULT_CHAINS, MAX_CHAINS, FRESH_MS, STALE_MS, _reset, _forgetMemory };
