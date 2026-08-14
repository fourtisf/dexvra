'use strict';
/*
 * Background watchers for the Dexvra Trade Bot:
 *   • SNIPE  — new-launch auto-buy. Robinhood Chain (factory TokenCreated), EVM DEX
 *              (PairCreated on ETH/Base/BNB/Arbitrum), and SOLANA (pump.fun new-coins
 *              feed → Jupiter buy). Buys for every armed+funded user.
 *   • COPY   — mirror a followed wallet's buys. EVM watches ERC20 Transfer logs from
 *              the token's WETH pair; SOLANA polls the target's signatures and mirrors
 *              a SOL-funded SPL increase. DANGER-flagged tokens (GoPlus/RugCheck) skipped.
 *   • ORDERS — limit-buy / take-profit / stop-loss on any chain (Solana included via
 *              DexScreener pricing). Polls each order's live price, ONE-SHOT on cross.
 *
 * Fund-safety: a triggered order is REMOVED and persisted synchronously BEFORE the
 * trade is sent, so a crash/restart can never replay a fill (double-spend). Orders
 * are one-shot — a triggered order that fails is dropped with a DM, not retried
 * (retrying a possibly-half-executed trade is unsafe).
 */
const { ethers } = require('ethers');
const core = require('./core');
const goplus = require('./goplus');
const safety = require('./safety');   // chain-aware safety (GoPlus on EVM, RugCheck on Solana)
const solana = require('./solana');   // Solana snipe/copy helpers
const upstreams = require('./upstreams');   // are the third parties answering? (one list, shared with the preflight)
const report = require('./report');         // ops channel — never secrets

let _notify = () => {};
function setNotifier(fn) { if (typeof fn === 'function') _notify = fn; }
const SNIPE_CHAIN = 'robinhood';

// Bounded-concurrency map: run `fn` over items, at most `limit` in flight. Keeps
// one slow trade/confirmation from stalling the whole shared cycle (a triggered
// order or snipe that waits up to 180s for a receipt no longer blocks everyone).
async function mapLimit(items, limit, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch (_) {} } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
}
const SNIPE_CONCURRENCY = Math.max(1, Number(process.env.SNIPE_CONCURRENCY || 4));

// ------------------------------------------------------------------ snipe
let _lastSnipeBlock = 0;
const SNIPE_MAX_SPAN = Math.max(200, Number(process.env.SNIPE_MAX_SPAN || 2000));
const _snipeFailAt = new Map();   // chatId -> last failure-DM ms (rate limit)
// Per-launch dedup for the "snipe ALL launches" EVM paths. Their block cursor can be
// pinned BACKWARD when a load-balanced RPC returns a lagging head (the cycles explicitly
// handle head < cursor), which re-scans a block range and would otherwise buy the same
// launch twice (core.buy has no on-chain idempotency). Marking each launch seen makes
// snipe-all one-shot. Dev-wallet snipe does NOT use this — it's already idempotent via
// its target's own `bought` map. (Audit #1 fix.)
const _snipeSeen = new Map();   // chainKey -> Set(token). PER-CHAIN: a high-volume chain
                                // must NOT be able to evict a slow chain's still-in-window
                                // launch (which would let a cursor regression re-buy it).
const SNIPE_SEEN_CAP = Math.max(4000, Number(process.env.SNIPE_SEEN_CAP || 20000));
function _snipeMark(chainKey, token) {
  let set = _snipeSeen.get(chainKey);
  if (!set) { set = new Set(); _snipeSeen.set(chainKey, set); }
  const k = String(token).toLowerCase();
  if (set.has(k)) return false;
  set.add(k);
  // FIFO cap comfortably exceeds the most launches that can fall inside ONE chain's
  // re-scan window (SNIPE_MAX_SPAN blocks ≈ tens–hundreds of launches), so an in-window
  // launch is never evicted → no re-buy on a cursor regression. (Audit #1 fix.)
  if (set.size > SNIPE_SEEN_CAP) { const it = set.values().next().value; set.delete(it); }
  return true;
}
// What the launch feed has actually SEEN. Kept because the single most diagnostic
// number in this service was being thrown away: a loop that scanned tens of thousands
// of blocks and found zero launches is indistinguishable, from inside the process,
// from a quiet market — and eth_getLogs returns an EMPTY ARRAY (not an error) for a
// topic nothing emits. So a snipe pointed at the wrong launchpad ran forever, reported
// 🟢 on /health, and never fired. These counters are what make that state visible.
const _snipeStats = { scans: 0, blocksScanned: 0, launchesSeen: 0, lastLaunchAt: null, lastScanAt: null };
// The Solana twin. `lastFeedOkAt` and `lastLaunchAt` are BOTH needed and mean
// different things: the first says pump.fun answered, the second says it had
// something. With only the loop's own heartbeat, a feed that had been dead for
// days still rendered a green tick — the state that looks most like a healthy one.
const _solSnipeStats = { polls: 0, launchesSeen: 0, lastLaunchAt: null, lastFeedOkAt: null, lastErr: null, lastErrAt: null };
function snipeStats() { return { ..._snipeStats }; }

async function snipeCycle() {
  const prov = core.providerFor(SNIPE_CHAIN);
  let head;
  // Rethrow rather than swallow: runLoop marks the loop failed and /health turns 🔴.
  // Returning normally here made a dead RPC look like a healthy, quiet scan.
  try { head = await prov.getBlockNumber(); }
  catch (e) { console.error('[snipe] getBlockNumber:', e.message); throw e; }
  if (!_lastSnipeBlock || head < _lastSnipeBlock) _lastSnipeBlock = head;   // pin cursor near head always
  const armed = core.allUsers().filter((u) => u.snipe && u.snipe.chains && u.snipe.chains.robinhood && Number(u.snipe.ethAmount) > 0);
  const devFollowers = launchFollowers('robinhood');   // users sniping specific dev wallets on Robinhood
  if (!armed.length && !devFollowers.length) { _lastSnipeBlock = head; return; }
  const factory = new ethers.Contract(core.chainOf(SNIPE_CHAIN).factory, core.FACTORY_ABI, prov);
  const from = Math.max(_lastSnipeBlock + 1, head - SNIPE_MAX_SPAN);
  if (from > head) { _lastSnipeBlock = head; return; }
  let evs = [];
  // Same reasoning as above — a getLogs failure is a real fault, not a quiet scan.
  // The cursor deliberately stays put so the range is re-scanned next cycle.
  try { evs = await factory.queryFilter(factory.filters.TokenCreated(), from, head); }
  catch (e) { console.error('[snipe] queryFilter:', e.message); throw e; }
  _lastSnipeBlock = head;
  _snipeStats.scans++;
  _snipeStats.blocksScanned += Math.max(0, head - from + 1);
  _snipeStats.lastScanAt = Date.now();
  if (evs.length) { _snipeStats.launchesSeen += evs.length; _snipeStats.lastLaunchAt = Date.now(); }
  // One line per scan, only while somebody is armed (the early return above means an
  // idle bot logs nothing). Without it, "is the snipe working?" had no answer short of
  // waiting for a fill that may never come.
  console.log(`[snipe] ${SNIPE_CHAIN} blocks ${from}-${head} · launches ${evs.length} · armed ${armed.length} · devFollowers ${devFollowers.length} · seen-total ${_snipeStats.launchesSeen}`);
  for (const e of evs) {
    const ca = e.args && e.args.token;
    const sym = (e.args && e.args.symbol) || '?';
    if (!ca) continue;
    // Record EVERY launch once — even in a dev-follower-only window with no armed
    // snipe-all user — so snipe-all stays forward-looking (a user who arms AFTER a
    // launch never retro-snipes it on a re-scan). Matches solSnipeCycle's unconditional
    // _solSnipeSeen. (Audit #2 fix.)
    const firstSee = _snipeMark(SNIPE_CHAIN, ca);
    // ── Dev-wallet snipe: buy this launch for anyone following its CREATOR. Idempotent
    // via each target's own dedup map, so a cursor regression / re-scan can't double-buy.
    const devBoughtBy = new Set();   // chatIds that dev-sniped THIS launch → skip them in snipe-all (no double buy)
    if (devFollowers.length) {
      const creator = (e.args && e.args.creator) ? String(e.args.creator).toLowerCase() : '';
      if (creator) {
        const matches = [];
        for (const u of devFollowers) for (const t of u.copy.targets) if (t.mode === 'launches' && t.chain === 'robinhood' && String(t.address).toLowerCase() === creator) matches.push({ u, t });
        if (matches.length) await mapLimit(matches, SNIPE_CONCURRENCY, async ({ u, t }) => { if (await _followerBuy(u, t, ca, 'robinhood')) devBoughtBy.add(u.chatId); });
      }
    }
    // ── Snipe ALL launches: every armed user buys concurrently (bounded) with their
    // ACTIVE wallet. `firstSee` gates it so a re-scanned block range can't buy the same
    // launch twice (audit #1) — dev-snipe above is exempt (own dedup).
    if (armed.length && firstSee) {
      await mapLimit(armed, SNIPE_CONCURRENCY, async (u) => {
        if (devBoughtBy.has(u.chatId)) return;   // already dev-sniped this exact launch → don't also snipe-all it
        const addr = core.activeAddress(u); if (!addr) return;
        try {
          const bal = await core.ethBalance(addr, SNIPE_CHAIN);
          const need = ethers.parseEther(String(u.snipe.ethAmount)) + core.gasBufferWei(SNIPE_CHAIN);
          if (_affordCheck(u, SNIPE_CHAIN, bal, need)) return;
        } catch (_) { return; }
        try {
          const r = await core.buy(u.chatId, ca, u.snipe.ethAmount, SNIPE_CHAIN);
          _notify(u.chatId, `🎯 <b>Sniped $${esc(sym)}</b>\nBought ${fmt(r.gotTokens)} $${esc(r.sym)} for ${r.spentEth} ${r.native}\n<code>${ca}</code>\n${txLink(SNIPE_CHAIN, r.hash)}`, undefined, 'snipe');
        } catch (err) {
          const now = Date.now();
          if (now - (_snipeFailAt.get(u.chatId) || 0) > 300000) {   // ≤ 1 failure DM / 5 min / user
            _snipeFailAt.set(u.chatId, now);
            _notify(u.chatId, `⚠️ A snipe failed: ${esc(err.message || String(err))} (further failures muted for 5 min)`, undefined, 'snipe');
          }
        }
      });
    }
  }
}
// Can this user afford the snipe? Returns true when they CANNOT (skip them).
//
// The old code skipped silently — right idea — but the pre-check reserved
// CFG.gasBufferEth (0.0004) while buy() reserved ETH_GAS_BUFFER (0.006), so on
// Ethereum the skip never fired: the buy ran, threw "insufficient ETH — need
// ~0.016, have 0.01499", and that notice went out on every new pair, for ever,
// "muted 5 min" notwithstanding. Both now read core.gasBufferWei, so a wallet
// that is short lands here instead of in the failure handler.
//
// Told ONCE. Not once per hour, not once per balance — once. A wallet's balance
// drifts constantly (gas spent elsewhere, dust arriving), so keying the notice
// on the balance still produced a stream of them; keying it on a timer produces
// one per window for as long as the wallet stays small, which is for ever. The
// flag lives on the user record and is persisted, so a restart does not
// re-announce it either.
//
// It re-arms on exactly one event: the wallet becoming able to afford the snipe
// again. That is the problem being solved, and a problem that recurs later is a
// new problem worth one new notice.
function _affordCheck(u, chainKey, bal, need) {
  const flags = (u._shortAlert = u._shortAlert || {});
  if (bal >= need) {
    if (flags[chainKey]) { delete flags[chainKey]; core.saveStoreNow(); }   // fixed → arm for next time
    return false;
  }
  if (!flags[chainKey]) {
    flags[chainKey] = true;
    core.saveStoreNow();
    const ch = core.chainOf(chainKey);
    const native = (ch && ch.native) || 'ETH';
    _notify(
      u.chatId,
      `⏸ <b>Snipe skipped — not enough ${esc(native)}</b>\n` +
        `Need <b>${ethers.formatEther(need)}</b> (${u.snipe.ethAmount} + gas), wallet has <b>${Number(ethers.formatEther(bal)).toFixed(5)}</b>.\n` +
        `Sniping stays on. Top up or lower the amount — you will not be told about this again.`,
      undefined,
      'snipe',
    );
  }
  return true;
}

// Users with the master copy switch ON who follow ≥1 dev wallet (launch mode) on `chainKey`.
function launchFollowers(chainKey) {
  return core.allUsers().filter((u) => u.copy && u.copy.on && Array.isArray(u.copy.targets) && u.copy.targets.some((t) => t.mode === 'launches' && t.chain === chainKey));
}
// Crash-safe single buy for a copy/dev-snipe target — SAME budget+dedup commit as
// copyCycle: commit bought+spent (persisted) BEFORE the buy, and roll back ONLY when the
// buy clearly didn't spend (never on err.broadcast, so a tx that may still land can't be
// double-spent or blow the budget cap). Used by the dev-wallet snipe paths.
// Returns true if the buy HELD (succeeded, or was broadcast and may still land) — so the
// caller skips a redundant snipe-all buy of the same launch for that user. Returns false
// when nothing was spent: an early skip (dedup/budget/danger) OR a failed buy that rolled
// back — in which case a snipe-all fallback for that user is still allowed. (Audit #3 fix.)
async function _followerBuy(u, t, token, chainKey) {
  const svm = core.chains.isSvm(chainKey);
  const key = svm ? String(token) : String(token).toLowerCase();
  t.bought = t.bought || {};
  if (t.bought[key]) return false;                                                     // already sniped this launch for this target
  if (Number(t.spentEth) + Number(t.buyEth) > Number(t.maxEth) + 1e-12) return false;  // budget cap
  if (safety.supported(chainKey)) { const s = await safety.tokenSecurity(chainKey, token).catch(() => null); if (s && safety.verdict(chainKey, s).level === 'danger') return false; }
  const bk = Object.keys(t.bought); if (bk.length >= 2000) delete t.bought[bk[0]];
  t.bought[key] = true;
  t.spentEth = Number(t.spentEth) + Number(t.buyEth);
  core.saveStoreNow();
  let held = true;   // did the spend hold? false only when the buy clearly didn't spend and we rolled back
  const ch = core.chainOf(chainKey) || { emoji: '', name: chainKey, native: 'ETH' };
  // Pin the wallet, so the exit sells from the same one (see copyHoldingAdd).
  const wid = (core.activeWallet(u) || {}).id || undefined;
  try {
    const r = await core.buy(u.chatId, token, t.buyEth, chainKey, wid);
    // A dev snipe is exit-mirrored too, and it is the case that needs it most:
    // the dev dumping their own launch is the single most informative sell a
    // followed wallet can make. Leaving launches off the ledger meant the one
    // mode built entirely around trusting a wallet was the one mode that never
    // watched it leave.
    core.copyHoldingAdd(t, token, await _targetBalance(chainKey, t.address, token), wid, r.gotRaw);
    _notify(u.chatId, `🎯 <b>Dev snipe</b> — $${esc(r.sym)} on ${ch.emoji} ${esc(ch.name)}\nDev <code>${short(t.address)}</code> just launched it · bought ${fmt(r.gotTokens)} for ${r.spentEth} ${r.native}${t.copySell ? ' · <i>exit mirrored</i>' : ''}\n<code>${token}</code>\n${txLink(chainKey, r.hash)}`, undefined, 'copy');
  } catch (err) {
    if (!err || !err.broadcast) { t.spentEth = Math.max(0, Number(t.spentEth) - Number(t.buyEth)); delete t.bought[key]; core.saveStoreNow(); held = false; }
    else core.copyHoldingAdd(t, token, await _targetBalance(chainKey, t.address, token), wid);   // budget held → track it, but the FILL is unknown
    const now = Date.now(), fk = u.chatId + ':devsnipe:' + key;
    if (now - (_snipeFailAt.get(fk) || 0) > 300000) { _snipeFailAt.set(fk, now); _notify(u.chatId, `⚠️ Dev-snipe of ${short(token)} failed: ${esc(err.message || String(err))} (muted 5 min)`, undefined, 'copy'); }
  }
  return held;
}

// ------------------------------------------------------------------ multi-chain snipe (new DEX pairs)
const _dexSnipeCursor = {};   // chainKey -> last scanned block
const _dexFactory = {};       // chainKey -> DEX pair factory (cached)
const DEX_SNIPE_MAX_TOKENS = Math.max(1, Number(process.env.DEX_SNIPE_MAX_TOKENS || 15));   // cap tokens/chain/cycle
const PAIR_CREATED_ABI = ['event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'];
const ROUTER_FACTORY_ABI = ['function factory() view returns (address)'];

async function dexFactoryOf(chainKey) {
  if (_dexFactory[chainKey]) return _dexFactory[chainKey];
  try {
    const f = await new ethers.Contract(core.chainOf(chainKey).router, ROUTER_FACTORY_ABI, core.providerFor(chainKey)).factory();
    if (f && f !== ethers.ZeroAddress) { _dexFactory[chainKey] = f; return f; }
  } catch (_) {}
  return null;
}
// A getLogs/queryFilter error that means "the block range is too wide" (as opposed
// to a transient timeout). On these we skip the cursor FORWARD rather than retrying
// the same doomed range forever (which would livelock that chain's loop).
function _isRangeError(e) {
  const m = String((e && (e.message || e.info || e)) || '').toLowerCase();
  if (/too many requests|rate.?limit|\b429\b/.test(m)) return false;   // transient → retry the range, don't skip past it
  return /(too many results|more than \d+ results|query returned more than|block range|range is too|range too (large|wide|big)|response size|limited to|logs? .*range|\b10000\b|max.*results)/.test(m);
}

// Snipe brand-new DEX pairs on ETH/Base/BNB/Arbitrum for users who opted in per
// chain. Honeypots are skipped; each armed user's ACTIVE wallet buys the amount.
// Each chain scans INDEPENDENTLY and CONCURRENTLY so one slow/flaky RPC can't delay
// sniping on the others.
async function dexSnipeCycle() {
  const list = core.chains.enabledChains().filter((ch) => !ch.curve);   // Robinhood is handled by snipeCycle
  await Promise.all(list.map((ch) => _dexSnipeChain(ch).catch((e) => console.error('dexsnipe', ch.key, (e && e.message) || e))));
}
async function _dexSnipeChain(ch) {
  const armed = core.allUsers().filter((u) => u.snipe && u.snipe.chains && u.snipe.chains[ch.key] && Number(u.snipe.ethAmount) > 0);
  if (!armed.length) return;
  const prov = core.providerFor(ch.key);
  let head; try { head = await prov.getBlockNumber(); } catch (_) { return; }
  const cursor = _dexSnipeCursor[ch.key];
  if (!cursor || head < cursor) { _dexSnipeCursor[ch.key] = head; return; }   // pin near head first pass (no backfill flood)
  const factory = await dexFactoryOf(ch.key); if (!factory) { _dexSnipeCursor[ch.key] = head; return; }
  const from = Math.max(cursor + 1, head - SNIPE_MAX_SPAN);
  if (from > head) { _dexSnipeCursor[ch.key] = head; return; }
  let evs = [];
  try { const fc = new ethers.Contract(factory, PAIR_CREATED_ABI, prov); evs = await fc.queryFilter(fc.filters.PairCreated(), from, head); }
  catch (e) { if (_isRangeError(e)) _dexSnipeCursor[ch.key] = head; return; }   // range too wide → skip forward; else keep cursor, retry next cycle
  _dexSnipeCursor[ch.key] = head;
  const weth = ch.weth.toLowerCase();
  let processed = 0;
  for (const e of evs) {
    if (processed >= DEX_SNIPE_MAX_TOKENS) break;
    const a = e.args || {};
    const t0 = String(a.token0 || '').toLowerCase(), t1 = String(a.token1 || '').toLowerCase();
    let token = null;
    if (t0 === weth) token = a.token1; else if (t1 === weth) token = a.token0; else continue;   // only native-paired launches
    if (!token) continue;
    if (!_snipeMark(ch.key, token)) continue;   // already sniped → don't re-buy on a cursor regression / re-scan (audit #1)
    processed++;
    // Skip anything GoPlus flags as DANGER (honeypot, can't-sell, pausable, owner-rug,
    // blacklist, >10% tax). When GoPlus has no data yet (brand-new token) we proceed —
    // sniping fresh launches is the whole point; blind-buy risk is bounded by the amount.
    if (safety.supported(ch.key)) { const s = await safety.tokenSecurity(ch.key, token).catch(() => null); if (s && safety.verdict(ch.key, s).level === 'danger') continue; }
    await mapLimit(armed, SNIPE_CONCURRENCY, async (u) => {
      const addr = core.activeAddress(u); if (!addr) return;
      try {
        const bal = await core.ethBalance(addr, ch.key);
        const need = ethers.parseEther(String(u.snipe.ethAmount)) + core.gasBufferWei(ch.key);
        if (_affordCheck(u, ch.key, bal, need)) return;
      } catch (_) { return; }
      try {
        const r = await core.buy(u.chatId, token, u.snipe.ethAmount, ch.key);
        _notify(u.chatId, `🎯 <b>Sniped $${esc(r.sym)}</b> on ${ch.emoji} ${esc(ch.name)}\nBought ${fmt(r.gotTokens)} for ${r.spentEth} ${r.native}\n<code>${token}</code>\n${txLink(ch.key, r.hash)}`, undefined, 'snipe');
      } catch (err) {
        const now = Date.now(), key = u.chatId + ':' + ch.key;
        if (now - (_snipeFailAt.get(key) || 0) > 300000) { _snipeFailAt.set(key, now); _notify(u.chatId, `⚠️ A snipe on ${esc(ch.name)} failed: ${esc(err.message || String(err))} (muted 5 min)`, undefined, 'snipe'); }
      }
    });
  }
}

// ------------------------------------------------------------------ orders
// Orders live ON a wallet (wallet.orders) and are tagged with walletId so a
// TP/SL/limit set on one wallet always executes on THAT wallet, even after the
// user switches their active wallet.
let _oid = 1;
const MAX_ORDERS_PER_USER = Math.max(1, Number(process.env.MAX_ORDERS_PER_USER || 25));
const ORDER_MAX_READS = Math.max(20, Number(process.env.ORDER_MAX_READS || 300));
const ORDER_CONCURRENCY = Math.max(1, Number(process.env.ORDER_CONCURRENCY || 4));
const ORDER_READ_TIMEOUT_MS = Math.max(1000, Number(process.env.ORDER_READ_TIMEOUT_MS || 3500));

// Shared bounded SNAPSHOT reader: de-dups concurrent reads (caches the in-flight
// Promise), caps total distinct reads per cycle, and hard-times-out each read — so a
// hostile/unpriceable token can neither stall a cycle nor drain the RPC. Returns the
// full snapshot (price + mcap) so orders can target either metric.
// ---------------------------------------------------------------- order execution
//
// What a triggered order is allowed to spend to actually LAND.
//
// A stop-loss fires at precisely the moment the price is falling and every other
// holder is trying to leave: the worst conditions for the default gas price and
// the default slippage there are. Auto-protect has escalated since it was
// written (gasMult 2, slipAddBps 1500) — but the stop-loss the user set BY HAND,
// the one they are relying on, went out with no escalation at all. A stop-loss
// that does not fill is not a stop-loss, it is a notification that you lost the
// money anyway.
//
// The user's own gas priority is the floor in core.buy/core.sell, so these only
// ever raise it.
const ORDER_SPEED = {
  normal: { gasMult: 1, slipAddBps: 0 },
  fast: { gasMult: 2, slipAddBps: 500 },
  turbo: { gasMult: 3, slipAddBps: 1500 },
};
// Defaults by INTENT, not one setting for all four. Getting out of a falling
// position is urgent; taking profit into a rise is not; a limit buy that misses
// its price simply waits for the next one.
const ORDER_SPEED_DEFAULT = { sl: 'turbo', trail: 'turbo', tp: 'fast', limitbuy: 'fast' };
function orderSpeed(o) { return (o && ORDER_SPEED[o.speed]) ? o.speed : (ORDER_SPEED_DEFAULT[o && o.type] || 'fast'); }
function orderExec(o) { return { ...ORDER_SPEED[orderSpeed(o)] }; }

function snapReader(label) {
  const cache = new Map(); let reads = 0, capped = 0;
  const fn = (chain, ca) => {
    const k = chain + ':' + (core.chains.isSvm(chain) ? String(ca) : String(ca).toLowerCase());
    if (cache.has(k)) return cache.get(k);
    if (reads++ >= ORDER_MAX_READS) { capped++; const p = Promise.resolve(null); cache.set(k, p); return p; }
    const p = Promise.race([
      core.tokenSnapshot(ca, chain).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), ORDER_READ_TIMEOUT_MS)),
    ]);
    cache.set(k, p);
    return p;
  };
  // A cap that bites SILENTLY reads as "everything was checked and nothing
  // triggered". Say it out loud instead.
  fn.report = () => {
    if (capped) console.warn(`${label || 'snapReader'}: read budget spent — ${capped} token(s) went unpriced this cycle (ORDER_MAX_READS=${ORDER_MAX_READS})`);
    return capped;
  };
  return fn;
}

// Rotate the start of a work list each cycle.
//
// The read budget above exists to protect the RPC, and that is fair. What is not
// fair is WHICH items pay for it: users are iterated in insertion order and the
// order never changes, so once there are more tokens than budget it is the same
// tail that goes unpriced every single cycle, for ever. A stop-loss that is never
// evaluated is not a saved round trip — it is a stop-loss that does not exist,
// and the user has no way of knowing. Rotating the start means the cap costs
// everyone a little latency instead of costing a few people the feature.
let _rotSeq = 0;
function rotated(items) {
  if (!Array.isArray(items) || items.length < 2) return items;
  const off = (_rotSeq++ * ORDER_MAX_READS) % items.length;
  return off ? items.slice(off).concat(items.slice(0, off)) : items;
}

function addOrder(chatId, order, walletId) {
  const u = core.getUser(chatId); if (!u) throw new Error('no wallet');
  const w = (walletId && core.walletById(u, walletId)) || core.activeWallet(u); if (!w) throw new Error('no wallet');
  // DoS guard: cap total active orders per USER (across all wallets). Without this
  // a single free account could enqueue thousands of never-triggering orders on
  // junk tokens and force the shared ordersCycle to do unbounded serial RPC reads.
  const total = core.walletList(u).reduce((n, x) => n + ((x.orders && x.orders.length) || 0), 0);
  if (total >= MAX_ORDERS_PER_USER) throw new Error(`order limit reached (${MAX_ORDERS_PER_USER}). Cancel some first.`);
  order.id = (_oid++) + Date.now().toString(36);
  order.createdAt = Date.now();
  if (!order.chain) order.chain = core.userChain(u);
  order.walletId = w.id;
  w.orders = w.orders || [];
  w.orders.push(order);
  core.saveStore();
  return order;
}
function cancelOrder(chatId, id) {
  const u = core.getUser(chatId); if (!u) return false;
  let removed = false;
  for (const w of core.walletList(u)) {
    if (!Array.isArray(w.orders)) continue;
    const before = w.orders.length;
    w.orders = w.orders.filter((o) => o.id !== id);
    if (w.orders.length !== before) removed = true;
  }
  if (removed) core.saveStore();
  return removed;
}
async function ordersCycle() {
  // Flatten every wallet's orders into work items.
  const items = [];
  for (const u of core.allUsers()) {
    for (const w of core.walletList(u)) {
      for (const o of (w.orders || [])) items.push({ u, w, o });
    }
  }
  if (!items.length) return;
  const snapOf = snapReader('orders');   // bounded, de-duped, timeout-guarded snapshot reads
  let trailDirty = false;
  // Process concurrently (bounded) so one slow trade/user can't starve the rest.
  await mapLimit(rotated(items), ORDER_CONCURRENCY, async ({ u, w, o }) => {
    if (!Array.isArray(w.orders) || !w.orders.some((x) => x.id === o.id)) return;   // already filled/cancelled
    const chain = o.chain || SNIPE_CHAIN;
    let snap;
    try { snap = await snapOf(chain, o.ca); } catch (_) { return; }
    if (!snap) return;
    const px = snap.priceEth;
    if (!(px > 0)) return;
    // tp/sl/limitbuy compare either PRICE or MARKET CAP (o.metric), both in native units.
    const val = o.metric === 'mcap' ? (snap.mcapEth || 0) : px;
    let hit = false;
    if (o.type === 'trail') {
      // Trailing stop on PRICE: track the running peak; fire when price falls trailPct
      // below it. A rising price only ratchets the peak up (never triggers).
      if (!(o.peakEth > 0) || px > o.peakEth) { o.peakEth = px; trailDirty = true; }
      hit = px <= o.peakEth * (1 - (Number(o.trailPct) || 0) / 100);
    } else if (o.type === 'tp') hit = val >= o.targetPriceEth;
    else if (o.type === 'sl') hit = val <= o.targetPriceEth;
    else if (o.type === 'limitbuy') hit = val <= o.targetPriceEth;
    if (o.metric === 'mcap' && !(val > 0)) return;   // couldn't read mcap this cycle → wait
    if (!hit) return;
    // ONE-SHOT: remove + persist SYNCHRONOUSLY before the trade, so a crash can
    // never replay this fill on restart.
    w.orders = w.orders.filter((x) => x.id !== o.id);
    core.saveStoreNow();
    try {
      // Execute on the wallet the order LIVES ON (`w` is authoritative — the order
      // was pulled from w.orders), never on whatever wallet is merely active now.
      const exec = orderExec(o);
      if (o.type === 'limitbuy') {
        const r = await core.buy(u.chatId, o.ca, o.ethAmount, chain, w.id, exec);
        _notify(u.chatId, `✅ <b>Limit buy filled</b> $${esc(r.sym)}\nBought ${fmt(r.gotTokens)} for ${r.spentEth} ${r.native}\n${txLink(chain, r.hash)}`);
      } else {
        const r = await core.sell(u.chatId, o.ca, o.sellPct || 100, chain, w.id, exec);
        const label = o.type === 'tp' ? 'Take-profit' : o.type === 'trail' ? 'Trailing stop' : 'Stop-loss';
        _notify(u.chatId, `✅ <b>${label} filled</b> $${esc(o.sym || '')}\nSold ${r.soldPct}% for ${r.proceedsEth} ${r.native}\n${txLink(chain, r.hash)}`);
      }
    } catch (err) {
      _notify(u.chatId, `⚠️ Order on $${esc(o.sym || '')} triggered but failed: ${esc(err.message || String(err))}\nIt was removed — re-create it if you still want it.`);
    }
  });
  snapOf.report();
  if (trailDirty) core.saveStore();   // persist ratcheted trailing peaks (debounced)
}

// ------------------------------------------------------------------ price alerts (notify-only)
let _aid = 1;
const MAX_ALERTS_PER_USER = Math.max(1, Number(process.env.MAX_ALERTS_PER_USER || 25));
function addAlert(chatId, alert) {
  const u = core.getUser(chatId); if (!u) throw new Error('no wallet');
  u.alerts = u.alerts || [];
  if (u.alerts.length >= MAX_ALERTS_PER_USER) throw new Error(`alert limit reached (${MAX_ALERTS_PER_USER}). Cancel some first.`);
  alert.id = 'al' + (_aid++) + Date.now().toString(36);
  alert.createdAt = Date.now();
  if (!alert.chain) alert.chain = core.userChain(u);
  u.alerts.push(alert);
  core.saveStore();
  return alert;
}
function cancelAlert(chatId, id) {
  const u = core.getUser(chatId); if (!u || !Array.isArray(u.alerts)) return false;
  const before = u.alerts.length;
  u.alerts = u.alerts.filter((a) => a.id !== id);
  if (u.alerts.length !== before) { core.saveStore(); return true; }
  return false;
}
async function alertsCycle() {
  const items = [];
  for (const u of core.allUsers()) for (const a of (u.alerts || [])) items.push({ u, a });
  if (!items.length) return;
  const snapOf = snapReader('alerts');
  await mapLimit(rotated(items), ORDER_CONCURRENCY, async ({ u, a }) => {
    if (!Array.isArray(u.alerts) || !u.alerts.some((x) => x.id === a.id)) return;   // cancelled since
    const chain = a.chain || SNIPE_CHAIN;
    let snap; try { snap = await snapOf(chain, a.ca); } catch (_) { return; }
    const px = snap ? snap.priceEth : null;
    if (px == null || !(px > 0)) return;
    const hit = (a.dir === 'above' && px >= a.targetPriceEth) || (a.dir === 'below' && px <= a.targetPriceEth);
    if (!hit) return;
    // ONE-SHOT: remove + persist BEFORE notifying, so a crash can't double-fire.
    u.alerts = u.alerts.filter((x) => x.id !== a.id);
    core.saveStoreNow();
    const c = core.chainOf(chain) || { native: 'ETH', name: chain, emoji: '' };
    const wi = ((u.wallets || []).findIndex((w) => w.id === u.activeWalletId) + 1) || 1;   // active wallet (1-based), not a hardcoded #1
    const kb = { inline_keyboard: [[{ text: '📈 Trade', callback_data: `tok:${chain}:${wi}:${a.ca}` }]] };
    _notify(u.chatId, `🔔 <b>Price alert</b> — $${esc(a.sym || '')} is now <b>${a.dir === 'above' ? 'above' : 'below'}</b> your target${a.targetUsd ? ' of $' + a.targetUsd : ''} on ${c.emoji ? c.emoji + ' ' : ''}${esc(c.name || chain)}.`, kb);   // user-created one-shot signal → always deliver (never gated)
  });
  snapOf.report();
}

// ------------------------------------------------------------------ held-position alerts
// Watch every open position and ping the holder on big moves — profit milestones (2×, 5×,
// …) and a possible rug/dump (value collapsed from its peak). Uses the bot-tracked bag
// (p.tokens) so it's cheap; notified milestones are remembered per position to avoid
// spam. Gated by the user's 🔔 alerts toggle.
const POS_MILESTONES = [2, 5, 10, 25, 50, 100];
const RUG_MIN_PEAK = Math.max(0, Number(process.env.POS_RUG_MIN_PEAK || 0.01));   // native; ignore dust positions
const RUG_DROP = Math.min(0.9, Math.max(0.01, Number(process.env.POS_RUG_DROP || 0.15)));   // value ≤ 15% of peak = rug-ish
// Auto-protect (rug guard) — opt-in per user. Sells 100% ONLY to protect capital:
// when the bag is deep in LOSS versus your ENTRY (a dump/rug), or the contract turned
// into a honeypot / sell-tax trap. Deliberately measured against COST, not the all-time
// peak — a winner that merely retraces from its high is never force-sold.
const AUTO_PROTECT_DROP = Math.min(0.95, Math.max(0.3, Number(process.env.AUTO_PROTECT_DROP_PCT || 60) / 100));   // sell if down ≥60% on your entry
const AUTO_PROTECT_COOLDOWN_MS = 5 * 60 * 1000;   // min gap between auto-sell attempts on one bag (honeypot retry guard)
const AUTO_PROTECT_CHECK_MS = 3 * 60 * 1000;      // min gap between safety re-checks on one bag (API rate guard)
async function positionsCycle() {
  const items = [];
  for (const u of core.allUsers()) {
    const wantProtect = !!(u.settings && u.settings.autoProtect);
    // Process a user's positions if they want alerts OR have the rug guard on. (The
    // milestone/rug ALERTS self-gate on the 'alerts' toggle inside _notify; the
    // auto-protect SELL runs whenever the guard is on, and its DM is never muted.)
    if (!core.notifyOn(u.chatId, 'alerts') && !wantProtect) continue;
    for (const w of core.walletList(u)) {
      for (const key of Object.keys(w.positions || {})) {
        const p = w.positions[key];
        if (!p || p.closed || !(Number(p.ethIn) > 0)) continue;
        let heldRaw = 0n; try { heldRaw = BigInt(p.tokens || '0'); } catch (_) {}
        if (heldRaw <= 0n) continue;
        items.push({ u, w, p, heldRaw, wantProtect });
      }
    }
  }
  if (!items.length) return;
  const snapOf = snapReader('positions');
  let dirty = false;
  await mapLimit(rotated(items), ORDER_CONCURRENCY, async ({ u, w, p, heldRaw, wantProtect }) => {
    let snap; try { snap = await snapOf(p.chain, p.ca); } catch (_) { return; }
    if (!snap || !(snap.priceEth > 0)) return;
    const c = core.chainOf(p.chain) || { native: 'ETH', emoji: '' };
    const held = Number(ethers.formatUnits(heldRaw, p.dec || 18));
    const valueEth = held * snap.priceEth;
    p.notified = (p.notified && typeof p.notified === 'object') ? p.notified : {};
    if (!(p.peakValueEth > 0) || valueEth > p.peakValueEth) { p.peakValueEth = valueEth; dirty = true; }
    const wi = (core.walletList(u).findIndex((x) => x.id === w.id) + 1) || 1;
    const kb = { inline_keyboard: [[{ text: '📈 Trade', callback_data: `tok:${p.chain}:${wi}:${p.ca}` }]] };
    // profit milestone: notify the HIGHEST newly-crossed multiple, marking all below it seen.
    const mult = (valueEth + Number(p.ethOut || 0)) / Number(p.ethIn);
    let hi = 0; for (const m of POS_MILESTONES) if (mult >= m) hi = m;
    if (hi && !p.notified['x' + hi]) {
      for (const m of POS_MILESTONES) if (m <= hi) p.notified['x' + m] = true;
      dirty = true;
      _notify(u.chatId, `🚀 <b>$${esc(p.sym || '')} is up ${hi}×</b> on your entry!\nBag ≈ <b>${valueEth.toFixed(4)} ${c.native}</b> · consider taking profit.`, kb, 'alerts');
    }
    // ── Auto-protect (rug guard): sell 100% ONLY to protect capital — when the bag is
    // deep in LOSS vs your ENTRY (a dump/rug), or the contract turned into a honeypot /
    // sell-tax trap. NOT peak-based, so a winner that retraces from its high is never
    // dumped. Best-effort — a genuine honeypot may still block the exit.
    if (wantProtect) {
      const cost = (p.costEth != null) ? Number(p.costEth) : Math.max(0, Number(p.ethIn || 0) - Number(p.ethOut || 0));
      if (cost >= RUG_MIN_PEAK) {
        const cooled = (Date.now() - (p.notified.protectAt || 0)) > AUTO_PROTECT_COOLDOWN_MS;
        const lossFrac = cost > 0 ? 1 - (valueEth / cost) : 0;
        let reason = '';
        if (lossFrac >= AUTO_PROTECT_DROP) {
          reason = `it's down ${Math.round(lossFrac * 100)}% on your entry`;
        } else if (safety.supported(p.chain) && (Date.now() - (p.notified.protectCheckAt || 0)) > AUTO_PROTECT_CHECK_MS) {
          // Re-check the CONTRACT regardless of price — a honeypot can be switched on while
          // you're still in profit. Only the unambiguous "can't sell" signals trigger a
          // sale (honeypot flag, or a sell-tax spike) — NOT broad warnings like pausable /
          // blacklist / high buy-tax, which many legitimate tokens carry.
          p.notified.protectCheckAt = Date.now(); dirty = true;
          const sec = await safety.tokenSecurity(p.chain, p.ca).catch(() => null);
          if (sec && (sec.honeypot === true || Number(sec.sellTaxPct) >= 50)) reason = 'it turned into a honeypot (you can no longer sell it normally)';
        }
        if (reason && cooled) {
          p.notified.protectAt = Date.now(); dirty = true; core.saveStoreNow();   // write-through the cooldown so a crash can't retry the sell
          try {
            const r = await core.sell(u.chatId, p.ca, 100, p.chain, w.id, { slipAddBps: 1500, gasMult: 2 });   // exit aggressively (wide slippage)
            _notify(u.chatId, `🛡 <b>Auto-protect sold $${esc(p.sym || '')}</b>\nReason: ${reason}.\nRecovered <b>${Number(r.proceedsEth).toFixed(5)} ${c.native}</b>.\n${txLink(p.chain, r.hash)}`);
          } catch (err) {
            _notify(u.chatId, `🛡 <b>Auto-protect couldn't exit $${esc(p.sym || '')}</b>\n${esc((err && (err.message || err)) || 'sell failed')}\nThe token may be blocking sells (honeypot). I'll try again shortly.`);
          }
          return;   // handled — skip the passive rug alert this cycle
        }
      }
    }
    // rug/dump: value fell to ≤RUG_DROP of a meaningful peak (once).
    if (!p.notified.rug && p.peakValueEth >= RUG_MIN_PEAK && valueEth <= p.peakValueEth * RUG_DROP) {
      p.notified.rug = true; dirty = true;
      _notify(u.chatId, `⚠️ <b>Possible rug / dump: $${esc(p.sym || '')}</b>\nValue fell to ≈ <b>${valueEth.toFixed(4)} ${c.native}</b> from a peak of ≈ ${p.peakValueEth.toFixed(4)}. Check the chart / your safety.`, kb, 'alerts');
    }
  });
  snapOf.report();
  if (dirty) core.saveStore();
}

// ------------------------------------------------------------------ copy-trading (copy-BUY only)
// Mirror a followed wallet's BUYS: watch ERC20 Transfer logs TO the target, and
// only mirror when the token came FROM its own WETH pair (i.e. a real swap-buy,
// not an airdrop/transfer). Honeypots skipped. Total spend per target is HARD-
// capped at maxEth, so worst-case loss is bounded even if it mirrors a bad token.
// Sells are the user's job (TP/SL/manual) — we never auto-sell someone else's exit.
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const COPY_MAX_MIRRORS_PER_CYCLE = Math.max(1, Number(process.env.COPY_MAX_MIRRORS || 5));
// How many candidate TRANSACTIONS may be probed per target per cycle. Separate
// from the mirror cap because a probe costs an RPC call whether or not it turns
// into a trade, and an address that collects dust airdrops generates them
// without limit.
const COPY_MAX_PROBES_PER_CYCLE = Math.max(1, Number(process.env.COPY_MAX_PROBES || 25));
// Stablecoins a buy can be funded with, per chain. A target who swaps USDC for a
// token spent money on it just as surely as one who spent ETH.
const STABLES = {
  ethereum: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7', '0x6b175474e89094c44da98b954eedeac495271d0f'],
  base: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca'],
  bsc: ['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0x55d398326f99059ff775485246999027b3197955'],
  arbitrum: ['0xaf88d065e77c8cc2239327c5edb3a432268e5831', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'],
  robinhood: [],
};

/** Did `target` PAY for the tokens they received in `txHash`?
 *
 *  This replaces matching the Transfer's sender against getPair(token, WETH).
 *  That test only ever recognised a Uniswap V2 pool, so a target buying through
 *  V3, V4, Aerodrome, 1inch, 0x, CoW, or another Telegram bot's router was
 *  invisible — which on Ethereum and Base in 2026 is most of the volume. The
 *  bot could already ROUTE through V3; it just could not SEE anyone else do it.
 *
 *  Keyed on the money instead of on the venue: the target signed a transaction,
 *  tokens arrived, and value left. That is a buy however it was routed.
 *
 *    • native-funded — tx.from is the target and tx.value > 0
 *    • token-funded  — the receipt carries a Transfer of WETH or a stablecoin
 *                      FROM the target
 *
 *  Cheap on the common path: one getTransaction, and the receipt only when the
 *  value is zero. Returns false when it cannot tell — mirroring an airdrop
 *  spends real money on a token nobody bought. */
async function _targetPaid(chainKey, target, txHash) {
  const prov = core.providerFor(chainKey);
  const tgt = String(target).toLowerCase();
  let tx = null;
  try { tx = await prov.getTransaction(txHash); } catch (_) { return false; }
  if (!tx) return false;
  if (String(tx.from || '').toLowerCase() !== tgt) return false;   // somebody else's transaction — not their buy
  try { if (BigInt(tx.value || 0) > 0n) return true; } catch (_) {}
  // Zero value: they paid in WETH or a stablecoin, so look for it leaving them.
  const ch = core.chainOf(chainKey) || {};
  const pay = new Set([String(ch.weth || '').toLowerCase(), ...(STABLES[chainKey] || [])].filter(Boolean));
  if (!pay.size) return false;
  let rc = null;
  try { rc = await prov.getTransactionReceipt(txHash); } catch (_) { return false; }
  if (!rc || !Array.isArray(rc.logs)) return false;
  for (const l of rc.logs) {
    if (!l.topics || l.topics[0] !== TRANSFER_TOPIC || l.topics.length < 3) continue;
    if (!pay.has(String(l.address || '').toLowerCase())) continue;
    if (('0x' + l.topics[1].slice(26)).toLowerCase() === tgt) return true;   // they sent the money
  }
  return false;
}

// ---------------------------------------------------------------- copy: exits
//
// Following a wallet IN and never OUT is half a strategy: you take all of the
// downside with none of its exit signal. This mirrors the exit.
//
// It works off the target's BALANCE, not off swap logs, and that is deliberate.
// The copy-BUY detector watches Transfers INTO the target, so it cannot see a
// sale at all — the tokens leave, and a log filtered on "to = target" never
// fires. Missing an entry costs an opportunity; missing an EXIT costs the
// position. A balance that fell is a balance that fell, whatever route it took.
//
// Cost is one balance read per copy-held token per cycle, and that set is
// bounded by the target's own budget.
const COPY_EXIT_DROP_PCT = Math.min(100, Math.max(1, Number(process.env.COPY_EXIT_DROP_PCT || 10)));

/** The target's live balance of `token`, raw. null when it could not be read —
 *  never 0, because a failed read must not look like a wallet that just sold. */
async function _targetBalance(chainKey, target, token) {
  try {
    if (core.chains.isSvm(chainKey)) {
      const { raw } = await solana.splBalance(core.providerFor(chainKey), target, token);
      return raw;
    }
    return await core.tokenBalanceOrNull(token, target, chainKey);
  } catch (_) { return null; }
}

// Give up after this many failed exit attempts and tell the user plainly. An
// exit that keeps reverting (a honeypot, a dead pool) must not be retried
// forever in silence, and must not be forgotten either.
const COPY_EXIT_MAX_TRIES = Math.max(1, Number(process.env.COPY_EXIT_MAX_TRIES || 5));
const COPY_EXIT_RETRY_MS = Math.max(5000, Number(process.env.COPY_EXIT_RETRY_MS || 60000));

/** Which of the user's wallets should sell `token`.
 *
 *  Returns { id, known }. `known:false` means we could not READ the wallets, and
 *  that is not the same answer as "nobody holds it" — collapsing the two is how
 *  a position gets silently forgotten during an RPC blip. The caller must leave
 *  an unknown on the ledger and try again; only a known answer is safe to act on.
 *
 *  An unknown answer therefore carries NO id at all. It used to fall back to the
 *  pinned wallet, which quietly undid the whole guard: every position opened by
 *  copy has a pinned wallet, so `known` was false and `id` was truthy on the
 *  exact path it was written to protect. The caller sold from a wallet the read
 *  had just failed to vouch for, got "token balance is 0" — which is on the
 *  swallow list — and dropped the position for good while another, unreadable,
 *  wallet was still holding the bag.
 *
 *  The wallet the position was opened on wins when it still holds something;
 *  otherwise we find whichever wallet does, because the user may have moved the
 *  tokens or removed that wallet. */
async function _exitWalletId(chatId, token, chainKey, preferredId) {
  let rows = [];
  try { rows = await core.tokenBalancesAcross(chatId, token, chainKey); }
  catch (_) { return { id: null, known: false }; }
  const readable = rows.filter((r) => r.raw != null);
  if (!readable.length) return { id: null, known: false };   // read failed everywhere → retry
  // ONLY the wallet this position was opened on. There used to be a fallback to
  // whichever wallet held the MOST of the token, for the case where the user had
  // moved their bag — and that fallback is how a 0.01 ETH mirror could reach a
  // 20 ETH position the user opened themselves a year earlier, on a different
  // wallet, and market-sell it. Convenience on one hand, somebody else's money
  // on the other.
  if (preferredId) {
    const pin = rows.find((r) => r.id === preferredId);
    if (!pin) return { id: null, known: true };              // that wallet is gone
    if (pin.raw == null) return { id: null, known: false };    // unreadable → retry
    return { id: pin.raw > 0n ? pin.id : null, known: true };  // empty → the slice was closed by hand
  }
  // No pin at all. We cannot know which wallet this mirror traded on, and
  // guessing is precisely what the largest-holder fallback did — so there is
  // nothing to act on. A partial read is still not proof of an empty position.
  if (readable.length < rows.length) return { id: null, known: false };
  return { id: null, known: true };
}

// How many target-balance reads may be in flight at once. The reads used to run
// strictly one after another — one RPC round trip per held token, per cycle,
// across every user on the box. Twenty positions at ~400ms is already the whole
// 8s loop, and the loop only sleeps AFTER the cycle returns, so the exit that
// matters simply arrives later and later as the bot gets more users. They are
// independent reads; they go out together.
const COPY_EXIT_CONCURRENCY = Math.max(1, Number(process.env.COPY_EXIT_CONCURRENCY || 8));

const sym0 = (ca) => short(String(ca));
async function copyExitCycle() {
  const users = core.allUsers().filter((u) => u.copy && u.copy.on && Array.isArray(u.copy.targets) && u.copy.targets.length);
  // Gather everything due a check first, read all the balances together, and only
  // then act. Selling stays serial — it is the rare path, and two sells from one
  // wallet are serialized by the wallet lock anyway.
  const due = [];
  for (const u of users) {
    for (const t of u.copy.targets) {
      if (!t.copySell || !t.holding) continue;
      const ch = core.chainOf(t.chain); if (!ch) continue;
      for (const token of Object.keys(t.holding)) {
        const h = t.holding[token] || {};
        // Back off between retries so a position that cannot be sold does not
        // hammer the chain every cycle.
        if (h.tries > 0 && Date.now() - (h.lastTryAt || 0) < COPY_EXIT_RETRY_MS) continue;
        due.push({ u, t, ch, token, h, now: null });
      }
    }
  }
  if (!due.length) return;
  await mapLimit(due, COPY_EXIT_CONCURRENCY, async (d) => { d.now = await _targetBalance(d.t.chain, d.t.address, d.token); });

  for (const d of due) {
    const { u, t, ch, token, h, now } = d;
    if (!t.holding || !t.holding[token]) continue;    // ledger moved under us while the reads were in flight
    if (now == null) continue;                        // unreadable ≠ sold
    let base = 0n; try { base = BigInt(h.bal || '0'); } catch (_) { base = 0n; }
    if (!h.tries) {
      // A followed wallet holding NONE of it is an exit, and it needs no
      // baseline to be one. This used to be unreachable: a zero read fell into
      // the "no baseline yet — adopt this one" branch, copyHoldingBump refused
      // to lower a baseline, so base stayed 0 and the very same branch caught it
      // again on every cycle, for ever. A target that had already dumped by the
      // time we recorded the baseline — the fastest rug there is, and the one
      // case copy-sell exists for — parked the position permanently.
      if (now > 0n) {
        if (base <= 0n) { core.copyHoldingBump(t, token, now); continue; }   // first positive read — adopt it
        if (now > base) { core.copyHoldingBump(t, token, now); continue; }   // they bought more: raise the peak
        // "Started selling" = the peak fell by more than the trigger. A dust
        // change is not an exit, and neither is a rounding artefact.
        if ((base - now) * 100n < base * BigInt(COPY_EXIT_DROP_PCT)) continue;
      }
    }
    const dropped = base > now ? base - now : 0n;

    // Sell from the wallet that OPENED this position, not from whatever is
    // active right now — see copyHoldingAdd.
    // Resolve the wallet BEFORE touching the ledger. Dropping first and then
    // discovering we cannot act would forget the position outright.
    const wal = await _exitWalletId(u.chatId, token, t.chain, h.wid);
    // "We could not read your wallets" is not an answer, and must never be acted
    // on: selling on it lands on a wallet the read failed to vouch for, throws
    // "token balance is 0", and that message is on the swallow list below — so
    // one bad read would retire a position the user still holds.
    if (!wal.known) continue;                         // leave it on the ledger, read again next cycle

    // Off the ledger BEFORE selling: a crash mid-sell must not leave it
    // eligible to be sold a second time on the next cycle. It goes back on
    // if the sell fails for a reason worth retrying.
    core.copyHoldingDrop(t, token);
    if (!wal.id) continue;                            // nobody holds it — already exited by hand
    const wid = wal.id;

    // ONLY WHAT COPY BOUGHT. `own` is the raw amount this mirror actually filled;
    // selling 100% closed whatever the wallet happened to hold, which on a token
    // the user also owns is their money, not copy's. The operator's rule has
    // always been "only tokens bought via copy" — that guarded WHICH token was
    // sold and never how much.
    let own = 0n; try { own = BigInt(h.own || '0'); } catch (_) { own = 0n; }
    if (own <= 0n) {
      // The fill was never recorded — a mirror whose buy was broadcast but never
      // confirmed, or a position from before this was tracked. We do not know
      // which part of that bag is ours, so we do not guess with it.
      _notify(u.chatId,
        `👥 <b>Copy-sell skipped</b> — <code>${short(t.address)}</code> is selling $${esc(sym0(token))}, but I never recorded how much of your bag this mirror filled.\n` +
        `<b>Nothing was sold.</b> Close it yourself if you want out: /monitor`,
        undefined, 'copy');
      continue;
    }
    try {
      const r = await core.sell(u.chatId, token, 100, t.chain, wid, { exactTokens: own.toString() });
      const why = base > 0n
        ? `cut its bag by ~${Number((dropped * 100n) / base)}%`
        : 'holds none of it';
      _notify(u.chatId,
        `👥 <b>Copy-sell</b> $${esc(r.sym)} on ${ch.emoji} ${esc(ch.name)}\n` +
        `<code>${short(t.address)}</code> ${why} — you exited <b>100%</b>\n` +
        `Received ${r.proceedsEth} ${r.native}\n<code>${token}</code>\n${txLink(t.chain, r.hash)}`,
        undefined, 'copy');
    } catch (err) {
      const msg = String((err && err.message) || err);
      // Already empty is not a failure — the user got out by hand.
      if (/token balance is 0|no wallet/i.test(msg)) continue;
      const tries = core.copyHoldingRetry(t, token, { ...h, bal: String(base), own: own.toString(), wid });
      if (tries >= COPY_EXIT_MAX_TRIES) {
        core.copyHoldingDrop(t, token);
        _notify(u.chatId,
          `🔻 <b>Copy-sell gave up</b> on <code>${short(token)}</code> after ${tries} attempts\n` +
          `Last error: ${esc(msg)}\n<b>You still hold this — sell it yourself if you want out.</b>`,
          undefined, 'copy');
      } else {
        const now2 = Date.now(), key = u.chatId + ':copysell:' + token;
        if (now2 - (_snipeFailAt.get(key) || 0) > 300000) {
          _snipeFailAt.set(key, now2);
          _notify(u.chatId, `⚠️ Copy-sell of ${short(token)} failed (attempt ${tries}/${COPY_EXIT_MAX_TRIES}): ${esc(msg)} — retrying (muted 5 min)`, undefined, 'copy');
        }
      }
    }
  }
}

async function copyCycle() {
  const users = core.allUsers().filter((u) => u.copy && u.copy.on && Array.isArray(u.copy.targets) && u.copy.targets.length);
  if (!users.length) return;
  for (const u of users) {
    for (const t of u.copy.targets) {
      if (t.mode === 'launches') continue;   // dev-wallet snipe is driven by the snipe cycles, not swap-buy logs
      const ch = core.chainOf(t.chain); if (!ch) continue;
      // Solana copy-buy uses signature polling (no EVM logs) — dedicated path.
      if (core.chains.isSvm(t.chain)) { await _copySolTarget(u, t).catch((e) => console.error('copysol', (e && e.message) || e)); continue; }
      const prov = core.providerFor(t.chain);
      let head; try { head = await prov.getBlockNumber(); } catch (_) { continue; }
      if (!t.cursor || head < t.cursor) { t.cursor = head; core.saveStore(); continue; }   // pin near head first pass
      const from = Math.max(t.cursor + 1, head - SNIPE_MAX_SPAN);
      if (from > head) { t.cursor = head; continue; }
      let logs = [];
      try { logs = await prov.getLogs({ fromBlock: from, toBlock: head, topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(t.address.toLowerCase(), 32)] }); }
      catch (e) { if (_isRangeError(e)) { t.cursor = head; core.saveStore(); }  continue; }   // range too wide → skip forward (don't livelock); else keep cursor, retry
      t.cursor = head;

      // GROUP BY TRANSACTION, and reduce each to the token that was BOUGHT.
      //
      // Three things go wrong reading the log list straight:
      //
      //  1. ERC-721 shares the ERC-20 Transfer signature hash and differs only
      //     in indexing the token id as a FOURTH topic. An NFT mint paid for in
      //     ETH is therefore a Transfer to the target in a transaction they
      //     signed and sent value with — indistinguishable from a token buy, and
      //     it would spend real money calling swap on an NFT contract. The old
      //     V2-pair test excluded these by accident (getPair on an NFT returns
      //     the zero address); nothing excluded them once that test went.
      //
      //  2. One transaction can deliver SEVERAL different tokens — the marketing
      //     or scam pattern where buying X also airdrops Y to the buyer. Mirrored
      //     blind, the bot buys Y too, on the strength of somebody else's token
      //     contract. When more than one non-money token arrives we cannot tell
      //     which was bought, so we buy neither.
      //
      //  3. Probing per LOG rather than per TRANSACTION meant a reflection token
      //     (several Transfers per swap) cost several getTransaction calls for
      //     one trade.
      const money = new Set([String(ch.weth || '').toLowerCase(), ...(STABLES[t.chain] || [])].filter(Boolean));
      const byTx = new Map();
      for (const log of logs) {
        if (!log.topics || log.topics.length !== 3 || log.topics[0] !== TRANSFER_TOPIC) continue;   // ERC-20 only
        const token = String(log.address || '').toLowerCase();
        const hash = log.transactionHash;
        if (!token || !hash || money.has(token)) continue;
        let set = byTx.get(hash); if (!set) { set = new Set(); byTx.set(hash, set); }
        set.add(token);
      }

      // WHEN THE CAPS BITE, DROP THE OLDEST — never the newest.
      //
      // t.cursor is already at head by this point, so anything the caps stop us
      // reaching is gone rather than deferred. Walking oldest-first therefore
      // spent the whole budget on the stalest candidates and discarded the
      // freshest: on a busy wallet the bot would mirror what it did four minutes
      // ago and silently miss what it did four seconds ago, which is the exact
      // inversion of what copy-trading is for.
      //
      // Deferring instead (rewinding the cursor) livelocks: an address spammed
      // with dust airdrops regenerates more candidates than the cap every cycle
      // and would pin the scan to the same stale window for ever.
      const entries = [...byTx.entries()];
      const room = COPY_MAX_PROBES_PER_CYCLE;
      if (entries.length > room) {
        // Never silently. A cap that drops work reads as "nothing happened".
        console.warn(`copy: ${entries.length - room} older candidate tx skipped for ${short(t.address)} on ${t.chain} (COPY_MAX_PROBES=${room})`);
      }
      // Newest FIRST, not merely newest-selected. Taking the last `room` entries
      // and then walking them in chronological order let the mirror cap (which
      // stops after 5 BUYS) consume the oldest of the survivors and drop the
      // rest — so the freshest trade was still the one lost.
      let mirrors = 0, probes = 0;
      for (const [hash, tokens] of entries.slice(-room).reverse()) {
        if (mirrors >= COPY_MAX_MIRRORS_PER_CYCLE) break;
        // Bound the RPC too, not only the buys. A wallet that collects dust
        // airdrops produces candidate transactions without limit, and every one
        // of them used to cost a getTransaction whether or not it could ever
        // become a trade.
        if (probes >= COPY_MAX_PROBES_PER_CYCLE) break;
        if (tokens.size !== 1) continue;                                   // ambiguous — see (2)
        const token = tokens.values().next().value;
        if (t.bought && t.bought[token]) continue;                         // already mirrored this token
        if (Number(t.spentEth) + Number(t.buyEth) > Number(t.maxEth) + 1e-12) continue;   // budget cap
        // Was this a BUY, or did the tokens simply arrive? Keyed on the target
        // having PAID — not on which pool the sender happens to be.
        probes++;
        if (!(await _targetPaid(t.chain, t.address, hash))) continue;
        // Skip anything GoPlus flags as DANGER (honeypot/pausable/owner-rug/high-tax…);
        // when GoPlus has no data we still mirror — worst-case loss stays bounded by maxEth.
        if (safety.supported(t.chain)) { const s = await safety.tokenSecurity(t.chain, token).catch(() => null); if (s && safety.verdict(t.chain, s).level === 'danger') continue; }
        // Commit budget + dedup BEFORE spending (crash-safe: no double-mirror, budget can't be exceeded on restart).
        t.bought = t.bought || {};
        const boughtKeys = Object.keys(t.bought);
        if (boughtKeys.length >= 2000) delete t.bought[boughtKeys[0]];   // hard cap the dedup map (drop oldest)
        t.bought[token] = true;
        t.spentEth = Number(t.spentEth) + Number(t.buyEth);
        core.saveStoreNow();
        mirrors++;
        // Decide the wallet HERE and pass it explicitly, so the exit can sell
        // from the same one. Left implicit, both the buy and the sell would
        // each land on whatever wallet happened to be active at that moment.
        const wid = (core.activeWallet(u) || {}).id || undefined;
        try {
          const r = await core.buy(u.chatId, token, t.buyEth, t.chain, wid);
          // Record what the TARGET holds now — the baseline the exit watcher
          // measures against. Only tokens entered through copy are ever exited
          // through copy; a bag the user bought themselves is not copy's to sell.
          core.copyHoldingAdd(t, token, await _targetBalance(t.chain, t.address, token), wid, r.gotRaw);
          _notify(u.chatId, `👥 <b>Copy-buy</b> $${esc(r.sym)} on ${ch.emoji} ${esc(ch.name)}\nFollowed <code>${short(t.address)}</code> · ${r.spentEth} ${r.native}${t.copySell ? ' · <i>exit mirrored</i>' : ''}\n<code>${token}</code>\n${txLink(t.chain, r.hash)}`, undefined, 'copy');
        } catch (err) {
          // Only give the budget/dedup back when the buy CLEARLY didn't spend. If the tx
          // was broadcast but couldn't be confirmed (err.broadcast), it may still land —
          // keep the commit so we never double-spend the budget on the next cycle.
          if (!err || !err.broadcast) {
            t.spentEth = Math.max(0, Number(t.spentEth) - Number(t.buyEth));   // buy didn't spend → give the budget back
            delete t.bought[token];                                            // and forget it (nothing bought → no dedup leak)
            core.saveStoreNow();
          } else {
            // Broadcast but unconfirmed: the budget stays committed because the
            // tx may still land — so the POSITION has to be tracked on the same
            // terms. Leaving it off the ledger made a fill we had already paid
            // for the one bag copy would never watch leave. If the tx never
            // lands, the exit cycle reads a clean zero across every wallet and
            // retires the entry by itself. The FILL is unknown here — the buy
            // threw, so there is no result to read it from.
            core.copyHoldingAdd(t, token, await _targetBalance(t.chain, t.address, token), wid);
          }
          const now = Date.now(), key = u.chatId + ':copy:' + token;
          if (now - (_snipeFailAt.get(key) || 0) > 300000) { _snipeFailAt.set(key, now); _notify(u.chatId, `⚠️ Copy-buy of ${short(token)} failed: ${esc(err.message || String(err))} (muted 5 min)`, undefined, 'copy'); }
        }
      }
    }
    core.saveStore();
  }
}

// ------------------------------------------------------------------ Solana copy-buy
// Mirror a followed SOLANA wallet's BUYS. We can't watch ERC20 logs, so we poll the
// target's recent signatures, parse each tx, and mirror when the target's SPL balance
// INCREASED while its SOL balance DROPPED (a real SOL-funded swap-buy, not an airdrop
// or a transfer-in). Same crash-safe budget/dedup commit as the EVM path; sells stay
// the user's job. Stablecoins + WSOL are ignored.
const COPY_SOL_SIG_LIMIT = Math.max(5, Number(process.env.COPY_SOL_SIG_LIMIT || 25));
// The target must have spent MORE SOL than mere fees + a new token-account rent
// (~0.00204 SOL) for a token increase to count as a real SOL-funded BUY. Below this we
// treat it as an airdrop / token→token swap / claim (target signed & paid only rent) and
// do NOT mirror. 0.005 SOL cleanly clears rent+priority-fees while still catching any
// meaningful buy. Override via COPY_SOL_MIN_SPEND_LAMPORTS.
const COPY_SOL_MIN_SPEND = BigInt(process.env.COPY_SOL_MIN_SPEND_LAMPORTS || 5000000);
// Minimum QUOTE-asset spend (USDC/USDT are 6-decimal, WSOL 9) for a token-funded
// buy to count. Without a floor, one raw unit ticking down anywhere was proof of
// payment — which is how an LP withdrawal read as a purchase.
const SOL_QUOTE_MIN_SPEND = BigInt(process.env.COPY_SOL_MIN_QUOTE || 1000000);
const _solStable = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',   // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KConky11Mc6mzwtQKPa',    // USDT
  solana.WSOL_MINT,
]);
// The mint the target BOUGHT in tx `sig` (largest SPL increase for the target owner),
// but only if the target also spent SOL. null when it's not a SOL-funded buy.
async function _solBuyMintFromTx(conn, sig, targetAddr) {
  const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (!tx || !tx.meta) return null;

  // DID THE TARGET SIGN THIS?
  //
  // getSignaturesForAddress returns every transaction that so much as MENTIONS
  // the address — including one a stranger built, which is enough to hand an
  // attacker the bot's wallet: airdrop a scam mint to a followed wallet, arrange
  // for something of theirs to tick down, and every follower buys it. The EVM
  // side has refused anything where tx.from is not the target since the rewrite;
  // Solana had no equivalent check at all.
  const keys = tx.transaction.message.accountKeys || [];
  const keyOf = (k) => (k && (k.pubkey ? k.pubkey.toString() : String(k))) || '';
  let idx = -1, signed = false;
  for (let i = 0; i < keys.length; i++) {
    if (keyOf(keys[i]) !== targetAddr) continue;
    idx = i;
    // A parsed account key carries `signer`. When the RPC omits it, index 0 is
    // the fee payer by construction — fail closed on anything else.
    signed = keys[i] && typeof keys[i].signer === 'boolean' ? keys[i].signer : i === 0;
    break;
  }
  if (!signed) return null;

  const pre = tx.meta.preTokenBalances || [], post = tx.meta.postTokenBalances || [];
  // Pre balances for the target owner, keyed by TOKEN ACCOUNT rather than mint:
  // a wallet can hold one mint in two accounts, and keying by mint let the last
  // entry overwrite the first while the post lookup found the other one — which
  // reads a flat balance as a spend.
  const acctKey = (b) => `${b.accountIndex != null ? b.accountIndex : keyOf(keys[b.accountIndex])}|${b.mint}`;
  const preAcct = new Map(), preByMint = new Map();
  for (const b of pre) {
    if (!b || b.owner !== targetAddr || !b.uiTokenAmount) continue;
    let v = 0n; try { v = BigInt(b.uiTokenAmount.amount); } catch (_) { continue; }
    preAcct.set(acctKey(b), v);
    preByMint.set(b.mint, (preByMint.get(b.mint) || 0n) + v);
  }
  const postByMint = new Map();
  for (const b of post) {
    if (!b || b.owner !== targetAddr || !b.uiTokenAmount) continue;
    let v = 0n; try { v = BigInt(b.uiTokenAmount.amount); } catch (_) { continue; }
    postByMint.set(b.mint, (postByMint.get(b.mint) || 0n) + v);
  }

  // Which mints GREW, net across every account the target holds them in.
  const decOf = new Map();
  for (const b of post.concat(pre)) { if (b && b.uiTokenAmount && !decOf.has(b.mint)) decOf.set(b.mint, Number(b.uiTokenAmount.decimals) || 0); }
  const gained = [];
  for (const [mint, now] of postByMint) {
    const delta = now - (preByMint.get(mint) || 0n);
    if (delta > 0n && !_solStable.has(mint)) gained.push({ mint, delta, dec: decOf.get(mint) || 0 });
  }
  if (!gained.length) return null;
  // MORE THAN ONE non-money mint arrived: the marketing and scam pattern where
  // buying X also drops Y on the buyer. Picking the largest was ranking by unit
  // COUNT, which is supply and not value — a scam mint issuing ten million units
  // outranks a real 1,200-unit acquisition every time. The EVM path refuses this
  // ambiguity outright; so does this one now.
  if (gained.length > 1) return null;
  const boughtMint = gained[0].mint;

  // Did they PAY? Two ways, and both have to be a real spend rather than any
  // balance ticking down.
  if (idx >= 0 && Array.isArray(tx.meta.preBalances) && Array.isArray(tx.meta.postBalances)) {
    let solDelta = 0n;
    try { solDelta = BigInt(tx.meta.postBalances[idx]) - BigInt(tx.meta.preBalances[idx]); } catch (_) { solDelta = 0n; }
    if (solDelta < -COPY_SOL_MIN_SPEND) return boughtMint;   // SOL-funded buy
  }
  // Token-funded — but ONLY in a quote asset. "Any token of theirs fell" turned
  // every position-REDUCING transaction into a buy: withdrawing an LP position
  // burns the receipt token and credits two mints, unstaking returns the staked
  // asset, and closing an ATA makes the mint vanish from postTokenBalances
  // entirely, which read as a decrease to zero. In each of those the target
  // acquired nothing — they exited — and the bot bought.
  for (const mint of _solStable) {
    const before = preByMint.get(mint) || 0n;
    if (before <= 0n) continue;
    const now = postByMint.get(mint) || 0n;
    if (before - now >= SOL_QUOTE_MIN_SPEND) return boughtMint;   // they paid, in money
  }
  // Nothing left them. FAIL CLOSED: tokens that merely arrived are an airdrop,
  // and mirroring one spends real money on something nobody bought.
  return null;
}
async function _copySolTarget(u, t) {
  const conn = core.providerFor(t.chain);
  const { PublicKey } = require('@solana/web3.js');
  let sigs;
  try { sigs = await conn.getSignaturesForAddress(new PublicKey(t.address), { limit: COPY_SOL_SIG_LIMIT }); } catch (_) { return; }
  if (!Array.isArray(sigs) || !sigs.length) return;
  if (!t.cursorSig) { t.cursorSig = sigs[0].signature; core.saveStore(); return; }   // pin near head first pass
  let fresh = [];
  for (const s of sigs) { if (s.signature === t.cursorSig) break; if (!s.err) fresh.push(s.signature); }
  t.cursorSig = sigs[0].signature; core.saveStore();   // advance to head regardless
  if (!fresh.length) return;
  // Same rule as the EVM side: cursorSig is already at head, so whatever the
  // mirror cap stops us reaching is gone. Keep the NEWEST, drop the oldest.
  if (fresh.length > COPY_MAX_MIRRORS_PER_CYCLE) {
    console.warn(`copysol: ${fresh.length - COPY_MAX_MIRRORS_PER_CYCLE} older signatures skipped for ${short(t.address)} (COPY_MAX_MIRRORS=${COPY_MAX_MIRRORS_PER_CYCLE})`);
    fresh = fresh.slice(0, COPY_MAX_MIRRORS_PER_CYCLE);   // fresh is newest-first here
  }
  fresh.reverse();   // oldest-first → mirror in the target's order
  let mirrors = 0;
  for (const sig of fresh) {
    if (mirrors >= COPY_MAX_MIRRORS_PER_CYCLE) break;
    let mint; try { mint = await _solBuyMintFromTx(conn, sig, t.address); } catch (_) { continue; }
    if (!mint || _solStable.has(mint)) continue;
    if (t.bought && t.bought[mint]) continue;
    if (Number(t.spentEth) + Number(t.buyEth) > Number(t.maxEth) + 1e-12) continue;   // budget cap
    if (safety.supported(t.chain)) { const s = await safety.tokenSecurity(t.chain, mint).catch(() => null); if (s && safety.verdict(t.chain, s).level === 'danger') continue; }
    // Commit budget + dedup BEFORE spending (crash-safe).
    t.bought = t.bought || {};
    const bk = Object.keys(t.bought); if (bk.length >= 2000) delete t.bought[bk[0]];
    t.bought[mint] = true;
    t.spentEth = Number(t.spentEth) + Number(t.buyEth);
    core.saveStoreNow();
    mirrors++;
    const swid = (core.activeWallet(u) || {}).id || undefined;
    try {
      const r = await core.buy(u.chatId, mint, t.buyEth, t.chain, swid);
      core.copyHoldingAdd(t, mint, await _targetBalance(t.chain, t.address, mint), swid, r.gotRaw);
      _notify(u.chatId, `👥 <b>Copy-buy</b> $${esc(r.sym)} on 🟣 Solana\nFollowed <code>${short(t.address)}</code> · ${r.spentEth} ${r.native}${t.copySell ? ' · <i>exit mirrored</i>' : ''}\n<code>${mint}</code>\n${txLink(t.chain, r.hash)}`, undefined, 'copy');
    } catch (err) {
      if (!err || !err.broadcast) { t.spentEth = Math.max(0, Number(t.spentEth) - Number(t.buyEth)); delete t.bought[mint]; core.saveStoreNow(); }
      else core.copyHoldingAdd(t, mint, await _targetBalance(t.chain, t.address, mint), swid);   // budget held → track it, but the FILL is unknown
      const now = Date.now(), key = u.chatId + ':copysol:' + mint;
      if (now - (_snipeFailAt.get(key) || 0) > 300000) { _snipeFailAt.set(key, now); _notify(u.chatId, `⚠️ Copy-buy of ${short(mint)} failed: ${esc(err.message || String(err))} (muted 5 min)`, undefined, 'copy'); }
    }
  }
}

// ------------------------------------------------------------------ Solana snipe (new pump.fun launches)
// New-launch auto-buy on Solana. Discovery is pump.fun's new-coins feed (the canonical
// launchpad); the actual buy goes through Jupiter, so a token that isn't routable yet
// (still on the raw bonding curve) is skipped quietly and retried while it's fresh.
// RugCheck DANGER-flagged tokens are skipped; brand-new ones usually aren't indexed yet
// (gate fails open, like the EVM snipe). Best-effort — first-second curve sniping would
// need a pump.fun program integration (future add-on).
let _solSnipeCursorTs = 0;
const _solSnipeSeen = new Set();
const SOL_SNIPE_MAX_AGE_MS = Math.max(60000, Number(process.env.SOL_SNIPE_MAX_AGE_MS || 600000));   // ignore launches older than 10 min
async function solSnipeCycle() {
  if (!core.chains.isEnabled('solana')) return;
  const armed = core.allUsers().filter((u) => u.snipe && u.snipe.chains && u.snipe.chains.solana && Number(u.snipe.ethAmount) > 0);
  const devFollowers = launchFollowers('solana');   // users sniping specific dev wallets on Solana
  if (!armed.length && !devFollowers.length) return;
  // A FEED THAT DID NOT ANSWER IS NOT A QUIET LAUNCHPAD.
  //
  // This used to be `pumpfunNew()`, which returned [] for both, and the early
  // `return` below counted as a SUCCESSFUL tick — so /health printed a green
  // solSnipe while discovery had been blind for days. The same rule the EVM
  // snipe loop has carried since it was written ("a loop that RAN is not a loop
  // that WORKS"), finally applied to its Solana twin.
  const feed = await solana.pumpfunNewX(50);
  _solSnipeStats.polls++;
  if (!feed.ok) { _solSnipeStats.lastErr = feed.why || 'feed unreachable'; _solSnipeStats.lastErrAt = Date.now(); throw new Error('pump.fun feed: ' + _solSnipeStats.lastErr); }
  _solSnipeStats.lastFeedOkAt = Date.now();
  const coins = feed.coins;
  if (coins.length) { _solSnipeStats.launchesSeen += coins.length; _solSnipeStats.lastLaunchAt = Date.now(); }
  if (!coins.length) return;
  const newestTs = Math.max(0, ...coins.map((c) => c.createdTs || 0));
  if (!_solSnipeCursorTs) { _solSnipeCursorTs = newestTs; return; }   // pin near head first pass (no startup flood)
  const now = Date.now();
  const fresh = coins
    .filter((c) => c.createdTs > _solSnipeCursorTs && (now - c.createdTs) < SOL_SNIPE_MAX_AGE_MS && !_solSnipeSeen.has(c.mint))
    .sort((a, b) => a.createdTs - b.createdTs);
  _solSnipeCursorTs = Math.max(_solSnipeCursorTs, newestTs);
  let processed = 0;
  for (const c of fresh) {
    if (processed >= DEX_SNIPE_MAX_TOKENS) break;
    _solSnipeSeen.add(c.mint);
    if (_solSnipeSeen.size > 4000) { const it = _solSnipeSeen.values().next().value; _solSnipeSeen.delete(it); }
    processed++;
    // ── Dev-wallet snipe: buy this launch for anyone following its creator (idempotent
    // via each target's own dedup map). Matched on the pump.fun feed's creator field.
    const devBoughtBy = new Set();
    if (devFollowers.length && c.creator) {
      const matches = [];
      for (const u of devFollowers) for (const t of u.copy.targets) if (t.mode === 'launches' && t.chain === 'solana' && t.address === c.creator) matches.push({ u, t });
      if (matches.length) await mapLimit(matches, SNIPE_CONCURRENCY, async ({ u, t }) => { if (await _followerBuy(u, t, c.mint, 'solana')) devBoughtBy.add(u.chatId); });
    }
    if (!armed.length) continue;   // dev-snipe-only followers: skip the snipe-all pass
    if (safety.supported('solana')) { const s = await safety.tokenSecurity('solana', c.mint).catch(() => null); if (s && safety.verdict('solana', s).level === 'danger') continue; }
    await mapLimit(armed, SNIPE_CONCURRENCY, async (u) => {
      if (devBoughtBy.has(u.chatId)) return;   // already dev-sniped this exact launch → don't also snipe-all it
      const w = core.activeWallet(u); if (!w) return;
      try {
        const bal = await core.ethBalance(core.walletAddress(w, 'solana'), 'solana');
        const need = solana.solToLamports(u.snipe.ethAmount) + solana.solToLamports(core.CFG.solGasBuffer);
        if (bal < need) return;   // can't afford → skip silently
      } catch (_) { return; }
      try {
        const r = await core.buy(u.chatId, c.mint, u.snipe.ethAmount, 'solana');
        _notify(u.chatId, `🎯 <b>Sniped $${esc(r.sym || c.symbol)}</b> on 🟣 Solana\nBought ${fmt(r.gotTokens)} for ${r.spentEth} ${r.native}\n<code>${c.mint}</code>\n${txLink('solana', r.hash)}`, undefined, 'snipe');
      } catch (err) {
        const msg = String((err && err.message) || err);
        if (/no route|no liquidity|not tradable/i.test(msg)) return;   // not yet on Jupiter → retry while fresh
        const now2 = Date.now(), key = u.chatId + ':solsnipe';
        if (now2 - (_snipeFailAt.get(key) || 0) > 300000) { _snipeFailAt.set(key, now2); _notify(u.chatId, `⚠️ A Solana snipe failed: ${esc(msg)} (muted 5 min)`, undefined, 'snipe'); }
      }
    });
  }
}

// ------------------------------------------------------------------ DCA (scheduled buys)
// A DCA plan buys `amount` of a token every `intervalMin` minutes for `rounds` rounds
// (and/or until an optional budget is spent), on the wallet it was created with. Each
// round advances the schedule + persists BEFORE the buy, so a crash can't double-buy.
let _did = 1;
const MAX_DCA_PER_USER = Math.max(1, Number(process.env.MAX_DCA_PER_USER || 10));
function addDca(chatId, plan, walletId) {
  const u = core.getUser(chatId); if (!u) throw new Error('no wallet');
  const w = (walletId && core.walletById(u, walletId)) || core.activeWallet(u); if (!w) throw new Error('no wallet');
  u.dca = Array.isArray(u.dca) ? u.dca : [];
  if (u.dca.length >= MAX_DCA_PER_USER) throw new Error(`DCA plan limit (${MAX_DCA_PER_USER}) reached — cancel one first`);
  const amount = Number(plan.amount), intervalMin = Math.max(1, Math.round(Number(plan.intervalMin) || 0)), rounds = Math.max(1, Math.round(Number(plan.rounds) || 0));
  if (!(amount > 0)) throw new Error('amount must be > 0');
  const p = {
    id: 'dca' + (_did++) + Date.now().toString(36),
    ca: plan.ca, sym: plan.sym || '', chain: plan.chain || core.userChain(u), walletId: w.id,
    amount: String(amount), intervalMin, roundsLeft: rounds, rounds,
    budget: Number(plan.budget) > 0 ? Number(plan.budget) : 0, spent: 0,
    nextAt: Date.now(), createdAt: Date.now(),   // first buy on the next cycle
  };
  u.dca.push(p); core.saveStoreNow();
  return p;
}
function cancelDca(chatId, id) {
  const u = core.getUser(chatId); if (!u || !Array.isArray(u.dca)) return false;
  const before = u.dca.length;
  u.dca = u.dca.filter((p) => p.id !== id);
  if (u.dca.length !== before) { core.saveStore(); return true; }
  return false;
}
async function dcaCycle() {
  const now = Date.now();
  const due = [];
  for (const u of core.allUsers()) for (const p of (u.dca || [])) if ((p.nextAt || 0) <= now) due.push({ u, p });
  if (!due.length) return;
  await mapLimit(due, SNIPE_CONCURRENCY, async ({ u, p }) => {
    if (!Array.isArray(u.dca) || !u.dca.some((x) => x.id === p.id)) return;   // cancelled since
    // Advance the schedule + decrement the round + persist BEFORE the buy (crash-safe:
    // a restart can't replay this round). Remove the plan when it's exhausted.
    p.roundsLeft = Math.max(0, (p.roundsLeft || 0) - 1);
    p.nextAt = Date.now() + p.intervalMin * 60000;
    // The budget is a CEILING, so the last round buys what is left of it, not a
    // full-size clip. This used to only decide whether the plan was finished
    // AFTER this buy — the round still went out at full size, so a 0.1 budget
    // with 0.03 clips spent 0.12. Over budget is not a rounding error on
    // somebody's money.
    let amount = Number(p.amount);
    if (p.budget > 0) {
      const left = p.budget - Number(p.spent || 0);
      if (left <= 1e-12) { u.dca = u.dca.filter((x) => x.id !== p.id); core.saveStoreNow(); return; }
      if (left < amount) amount = left;
    }
    const willFinish = p.roundsLeft <= 0 || (p.budget > 0 && (Number(p.spent) + amount) >= p.budget - 1e-12);
    if (willFinish) u.dca = u.dca.filter((x) => x.id !== p.id);
    core.saveStoreNow();
    try {
      const r = await core.buy(u.chatId, p.ca, amount, p.chain, p.walletId);
      p.spent = Number(p.spent) + Number(r.spentEth || amount);
      core.saveStoreNow();   // the money already moved — don't leave the tally in a debounce window
      const left = willFinish ? 'plan complete' : `${p.roundsLeft} round${p.roundsLeft === 1 ? '' : 's'} left`;
      _notify(u.chatId, `🔁 <b>DCA buy</b> $${esc(r.sym || p.sym || '')}\nBought ${fmt(r.gotTokens)} for ${r.spentEth} ${r.native} · ${left}\n${txLink(p.chain, r.hash)}`, undefined, 'copy');
    } catch (err) {
      const now2 = Date.now(), key = u.chatId + ':dca:' + p.id;
      if (now2 - (_snipeFailAt.get(key) || 0) > 300000) { _snipeFailAt.set(key, now2); _notify(u.chatId, `⚠️ A DCA buy of $${esc(p.sym || '')} failed: ${esc(err.message || String(err))} (round skipped; muted 5 min)`, undefined, 'copy'); }
    }
  });
}

// ------------------------------------------------------------------ referral auto-payout (opt-in)
const REF_PAYOUT_MIN = Math.max(0, Number(process.env.REF_PAYOUT_MIN_ETH || 0.005));   // min owed before paying (dust/gas guard)
async function payoutCycle() {
  if (!core.feePayoutEnabled()) return;
  const minWei = ethers.parseEther(String(REF_PAYOUT_MIN));
  for (const u of core.allUsers()) {
    const owed = u.refOwed; if (!owed || typeof owed !== 'object') continue;
    const dest = core.activeAddress(u); if (!dest) continue;
    for (const ck of Object.keys(owed)) {
      const ch = core.chainOf(ck); if (!ch) continue;
      // Auto-payout is an EVM hot-key feature (ethers). Solana referral debt accrues in
      // lamports and is settled MANUALLY — never try to pay it with an ethers wallet
      // (that would throw) and never compare lamports against a wei threshold.
      if (core.chains.isSvm(ck)) continue;
      let wei; try { wei = BigInt(owed[ck] || '0'); } catch (_) { continue; }
      if (wei < minWei) continue;
      // Deduct BEFORE paying so a crash can never overpay.
      owed[ck] = '0';
      core.saveStoreNow();
      try {
        const r = await core.payFromFeeWallet(ck, dest, wei);
        _notify(u.chatId, `💸 <b>Referral payout</b> — ${Number(ethers.formatEther(wei)).toFixed(5)} ${ch.native} sent to your wallet${r.confirmed ? '' : ' (confirming)'}.\n${txLink(ck, r.hash)}`);
      } catch (err) {
        if (err && err.ambiguous) {
          // The tx MAY have been accepted on-chain (broadcast errored after the node saw
          // it). Re-paying could double-send real funds, so we do NOT restore — the debt
          // stays cleared and we log it for manual review. Under-paying a small referral
          // credit is far safer than double-paying from a hot wallet.
          console.error('payout AMBIGUOUS (left cleared, verify manually)', ck, dest, wei.toString(), (err && err.message) || err);
        } else {
          // Nothing moved (pre-broadcast failure or clean revert) → give the debt back.
          // ADDITIVELY: a concurrent referral credit may have landed since we zeroed it.
          try { owed[ck] = (BigInt(owed[ck] || '0') + wei).toString(); } catch (_) { owed[ck] = wei.toString(); }
          core.saveStoreNow();
          console.error('payout', ck, (err && (err.message || err)) || 'unknown');
        }
      }
    }
  }
}

// ------------------------------------------------------------------ health / loop runner
// Each background loop records a heartbeat (last run + last success + last error) so a
// silently-dead loop is visible via /health (admin). `stale` flags a loop that hasn't
// run in > 3× its interval.
const _health = {};
function _beat(name, ok, err, ms) {
  const h = _health[name] || (_health[name] = { intervalMs: ms });
  h.at = Date.now(); h.intervalMs = ms;
  if (ok) { h.okAt = Date.now(); h.err = null; } else if (err) { h.err = String((err && (err.message || err)) || 'error').slice(0, 200); h.errAt = Date.now(); }
}
function runLoop(name, cycle, ms) {
  (async function loop() { for (;;) { try { await cycle(); _beat(name, true, null, ms); } catch (e) { _beat(name, false, e, ms); console.error(name, e.message); } await sleep(ms); } })();
}
function health() {
  const now = Date.now();
  const out = {};
  for (const [name, h] of Object.entries(_health)) {
    out[name] = { ageMs: h.at ? now - h.at : null, okAgeMs: h.okAt ? now - h.okAt : null, err: h.err || null, intervalMs: h.intervalMs, stale: h.at ? (now - h.at) > (h.intervalMs * 3 + 5000) : true };
  }
  // "Ran recently" is not the same as "working". The snipe loop can run every 6s
  // forever against a launchpad that emits nothing it recognises, so the loop's own
  // liveness says nothing about whether the feed is real. These two numbers do.
  if (out.snipe) {
    out.snipe.launchesSeen = _snipeStats.launchesSeen;
    out.snipe.sinceLastLaunchMs = _snipeStats.lastLaunchAt ? now - _snipeStats.lastLaunchAt : null;
    out.snipe.blocksScanned = _snipeStats.blocksScanned;
  }
  // The same two numbers for Solana. They were only ever wired to the EVM loop,
  // which is precisely why a dead pump.fun host could sit behind a green tick:
  // `lastFeedOkAt` is the only field that says the FEED answered, as opposed to
  // the loop having run.
  if (out.solSnipe) {
    out.solSnipe.launchesSeen = _solSnipeStats.launchesSeen;
    out.solSnipe.sinceFeedOkMs = _solSnipeStats.lastFeedOkAt ? now - _solSnipeStats.lastFeedOkAt : null;
    out.solSnipe.sinceLastLaunchMs = _solSnipeStats.lastLaunchAt ? now - _solSnipeStats.lastLaunchAt : null;
    out.solSnipe.feedErr = _solSnipeStats.lastErr || null;
  }
  // Third parties, as of the last watchdog sweep. `/health` answering "the loops
  // are running" while every Solana buy fails at Jupiter is the gap this closes.
  if (_lastUpstream) {
    out.upstreams = { ageMs: now - _lastUpstream.at, ok: _lastUpstream.ok, criticalOk: _lastUpstream.criticalOk,
      failing: _lastUpstream.results.filter((r) => !r.ok).map((r) => `${r.label}: ${r.detail}`) };
  }
  return out;
}
// ------------------------------------------------------------------ upstream watchdog
//
// Every outage in this bot's short history was found by a human typing
// `npm run preflight:solana` AFTER a user complained: Jupiter's retired host,
// pump.fun's move to v3, the swap-build failing while quotes worked. The check
// existed and named each one in a line. It just only ran when somebody already
// suspected something.
//
// This runs it on a timer and says so out loud. Two rules keep it worth reading:
//
//   • Alert on the TRANSITION, not the state. A broken upstream that posts every
//     sweep is a channel nobody reads by the second hour, and the alert that
//     matters is buried in its own repetitions.
//   • A RECOVERY is an alert too. "It is broken" with no matching "it is back"
//     leaves the operator unable to tell a fixed outage from a forgotten one,
//     and that is how a stale alarm becomes furniture.
let _lastUpstream = null;
const _upState = new Map();   // key -> ok, so only changes are announced
async function upstreamCycle() {
  const snap = await upstreams.checkAll();
  _lastUpstream = snap;
  const broke = [], fixed = [];
  for (const r of snap.results) {
    const was = _upState.get(r.key);
    _upState.set(r.key, r.ok);
    if (was === undefined) {
      // First sweep after a restart. Report a problem, because a bot that boots
      // into an outage must not wait for a transition that already happened —
      // but say nothing about the things that are simply fine.
      if (!r.ok) broke.push(r);
      continue;
    }
    if (was && !r.ok) broke.push(r);
    else if (!was && r.ok) fixed.push(r);
  }
  for (const r of broke) console.error(`[upstream] DOWN ${r.label} — ${r.detail}`);
  for (const r of fixed) console.log(`[upstream] recovered ${r.label} — ${r.detail}`);
  if (broke.length || fixed.length) report.upstreamChange(broke, fixed).catch(() => {});
}

function start() {
  // Default 10 minutes. Each sweep is four read-only calls; the cost of missing
  // an outage for hours is a user's money, so this is not the knob to save on.
  const upMs = Math.max(60000, Number(process.env.UPSTREAM_CHECK_MS || 600000));
  if (core.chains.isEnabled('solana') && String(process.env.UPSTREAM_CHECK || '1') !== '0') {
    runLoop('upstreams', upstreamCycle, upMs);
  }
  const snipeMs = Math.max(4000, Number(process.env.SNIPE_POLL_MS || 6000));
  const orderMs = Math.max(8000, Number(process.env.ORDER_POLL_MS || 15000));
  const alertMs = Math.max(8000, Number(process.env.ALERT_POLL_MS || 20000));
  const dexSnipeMs = Math.max(5000, Number(process.env.DEX_SNIPE_POLL_MS || 8000));
  runLoop('snipe', snipeCycle, snipeMs);
  runLoop('dexSnipe', dexSnipeCycle, dexSnipeMs);
  // Solana snipe runs only when the chain is enabled (its own cadence; pump.fun poll).
  if (core.chains.isEnabled('solana')) runLoop('solSnipe', solSnipeCycle, Math.max(5000, Number(process.env.SOL_SNIPE_POLL_MS || 8000)));
  runLoop('orders', ordersCycle, orderMs);
  runLoop('alerts', alertsCycle, alertMs);
  runLoop('positions', positionsCycle, Math.max(20000, Number(process.env.POS_POLL_MS || 60000)));
  runLoop('copy', copyCycle, Math.max(6000, Number(process.env.COPY_POLL_MS || 10000)));
  // Exits get their own loop: an exit that arrives late is worth more than an
  // entry that arrives late, so it must not queue behind the log scan.
  runLoop('copyExit', copyExitCycle, Math.max(5000, Number(process.env.COPY_EXIT_POLL_MS || 8000)));
  runLoop('dca', dcaCycle, Math.max(15000, Number(process.env.DCA_POLL_MS || 30000)));
  if (core.feePayoutEnabled()) {
    console.log('referral auto-payout ENABLED (fee wallet key present)');
    runLoop('payout', payoutCycle, Math.max(60000, Number(process.env.REF_PAYOUT_POLL_MS || 300000)));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmt = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'; return n.toFixed(n < 1 ? 4 : 2); };
const txLink = (chain, h) => { const c = core.chainOf(chain); return (h && c) ? `<a href="${c.explorer}/tx/${h}">tx ↗</a>` : ''; };

module.exports = { copyExitCycle, setNotifier, start, _targetPaid, addOrder, cancelOrder, addAlert, cancelAlert, addDca, cancelDca, health, snipeStats, orderSpeed, orderExec, ORDER_SPEED, ORDER_SPEED_DEFAULT, _test: { ordersCycleExec: orderExec, solSnipeCycle, snipeCycle, copyCycle, _copySolTarget, _solBuyMintFromTx, ordersCycle, dcaCycle, positionsCycle, _followerBuy, launchFollowers, _snipeMark, _snipeStats } };
