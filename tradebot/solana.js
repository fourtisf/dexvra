'use strict';
/*
 * solana.js — Solana (SVM) adapter for the Dexvra Trade Bot.
 *
 * The rest of the bot is 100% EVM (ethers). Solana is a different world — ed25519
 * keypairs, base58 addresses, lamports (9 decimals), SPL tokens, and swaps through
 * the Jupiter aggregator HTTP API instead of a Uniswap router. ALL of that lives
 * here so the EVM path in core.js/telegram.js stays untouched; callers branch on
 * `chain.kind === 'svm'` and delegate to these functions.
 *
 * This module is split into:
 *   - PURE helpers (derivation, validation, unit math, Jupiter request builders) —
 *     fully unit-testable offline;
 *   - LIVE helpers (Connection reads, swap execution) — thin wrappers over
 *     @solana/web3.js + fetch, exercised against a real RPC in production.
 */
const crypto = require('crypto');
const web3 = require('@solana/web3.js');
const { Keypair, PublicKey, Connection, VersionedTransaction, Transaction, SystemProgram, LAMPORTS_PER_SOL } = web3;
const _bs58 = require('bs58');
const bs58 = _bs58 && _bs58.encode ? _bs58 : (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const KIND = 'svm';
// Wrapped SOL — the "native" mint Jupiter routes through for SOL<->token swaps.
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
// Phantom / Solflare standard derivation path for the first account.
const SOL_PATH = "m/44'/501'/0'/0'";

// ---------------------------------------------------------------- Jupiter hosts
//
// Jupiter moved its public API off `quote-api.jup.ag/v6` and its token registry
// off `tokens.jup.ag`; the keyless tier now lives under `lite-api.jup.ag`. A
// host that has been withdrawn does NOT answer with a status you can read — DNS
// stops resolving and undici throws `TypeError: fetch failed`, whose message
// carries nothing. That string reached a user's buy card five times over
// ("buy failed on Solana: fetch failed"), where it is indistinguishable from
// the token having no route.
//
// So the base is RESOLVED, not assumed. `JUP_BASE` wins outright when set — the
// escape hatch AND a skip, the same contract `<CHAIN>_V4_POOLMANAGER` has in
// v4.js — otherwise the known bases are tried in order and the one that answers
// is remembered. Which host is live is a property of today's Jupiter, not of
// this code, so it gets measured rather than pinned. Both are kept so a
// rollover in either direction needs no deploy.
//
// The relative paths are identical under both bases (`/quote`, `/swap`), which
// is the only reason a plain base swap is enough.
//
// ⚠️ AND THE KEYLESS TIER IS METERED PER IP, WHICH IS WHAT FIVE WALLETS HIT.
// `lite-api.jup.ag` is the free tier and it is rate-limited by SOURCE ADDRESS —
// so a five-wallet buy, which fires five quotes, five swap-builds and five token
// reads at the same instant from one box, is a burst against a bucket sized for
// roughly one request a second. Jupiter answers the overflow with 429, `getQuote`
// threw `Jupiter quote failed (429)`, and i18n's `/quote/` rule rendered that as
// "Couldn't read live pricing for this token right now" on every wallet at once.
// That is a report about OUR request budget wearing the words of a fact about
// the token — see `_jupGate`, the in-flight coalescing in `getQuote`, and the
// retry in `_overBases`, which are the three halves of not spending it.
//
// `JUP_API_KEY` is the only thing that RAISES that ceiling rather than dividing
// it (the `GECKOTERMINAL_API_KEY` rule, one API over): it moves the base to the
// keyed host and sends `x-api-key`. Unset is the shipped behaviour and stays
// supported — this is headroom, never a prerequisite.
const JUP_API_KEY = (process.env.JUP_API_KEY || '').trim();
const JUP_BASE = (process.env.JUP_BASE || '').trim().replace(/\/+$/, '');
const JUP_BASES = JUP_BASE ? [JUP_BASE] : (JUP_API_KEY ? [
  'https://api.jup.ag/swap/v1',
  'https://lite-api.jup.ag/swap/v1',
] : [
  'https://lite-api.jup.ag/swap/v1',
  'https://quote-api.jup.ag/v6',
]);
const JUP_TOKEN_BASE = (process.env.JUP_TOKEN_BASE || '').trim().replace(/\/+$/, '');
const JUP_TOKEN_BASES = JUP_TOKEN_BASE ? [JUP_TOKEN_BASE] : (JUP_API_KEY ? [
  'https://api.jup.ag/tokens/v1/token',
  'https://lite-api.jup.ag/tokens/v1/token',
] : [
  'https://lite-api.jup.ag/tokens/v1/token',
  'https://tokens.jup.ag/token',
]);
// The key rides every Jupiter request and NOTHING ELSE — a header applied by
// host, so an operator's key is never posted to a base it does not belong to.
// It is deliberately absent from every log line and every error message: this
// module's own `netErr` had to learn that a URL can carry a secret.
function jupHeaders(url, extra) {
  const h = Object.assign({}, extra || {});
  if (JUP_API_KEY && /(^|\.)jup\.ag$/.test(hostOf(url))) h['x-api-key'] = JUP_API_KEY;
  return h;
}
function hostOf(url) { try { return new URL(url).host; } catch (_) { return ''; } }
// pump.fun moved the same way Jupiter did, and this bot was left on the old host
// while its SIBLING PROCESS in this very repo (bot/src/marketdata.js) already
// called the v3 one — one repo holding two answers to "which host is current",
// neither knowing about the other. Measured on the box: the legacy host does not
// answer, so Solana snipe discovery has been blind.
//
// THE LIST NOW HAS ONE OWNER. It lives in shared/launchpads, which both
// processes require, so the divergence above cannot happen again by editing one
// file and forgetting the other. `PUMPFUN_API` still wins outright — the
// registry honours it as an alias, so an operator's existing override is not
// silently outvoted by a second env var with a longer name.
//
// Read here rather than through the registry's enable flag on purpose:
// `LAUNCHPAD_PUMPFUN=0` turns off the metadata pad, and taking the snipe feed
// down with it would be a surprising second effect from a display setting.
const PUMPFUN_BASES = require('../shared/launchpads').basesOf('pumpfun');

// ---------------------------------------------------------------- validation

// A base58-encoded 32-byte ed25519 public key (a wallet address or an SPL mint).
// PublicKey validates the length + base58 alphabet; on-curve isn't required (mints
// and PDAs are valid addresses too).
function isSolAddress(s) {
  if (typeof s !== 'string') return false;
  s = s.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;   // base58, no 0/O/I/l
  try { const b = bs58.decode(s); return b.length === 32; } catch (_) { return false; }
}
// A Solana SECRET key the user might import: base58 of 64 bytes (~87–88 chars),
// or a JSON byte array "[12,34,...]" of length 64.
function isSolSecretKey(s) {
  if (typeof s !== 'string') return false;
  s = s.trim();
  if (/^\[\s*\d/.test(s)) { try { const a = JSON.parse(s); return Array.isArray(a) && a.length === 64; } catch (_) { return false; } }
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) { try { return bs58.decode(s).length === 64; } catch (_) { return false; } }
  return false;
}

// ---------------------------------------------------------------- keypair

// Build a Keypair from whatever the user has. Deterministic where it matters, so a
// user's existing generate/import flow yields a STABLE Solana address:
//   - a BIP39 mnemonic  → Phantom-compatible m/44'/501'/0'/0' derivation;
//   - a Solana secret   → the key itself (base58 64-byte or JSON array);
//   - an EVM 0x privkey → a domain-separated ed25519 seed (so an EVM-only wallet
//                          still maps to ONE fixed Solana address, distinct from EVM);
//   - nothing           → a fresh random keypair.
function deriveKeypair(secret) {
  secret = String(secret == null ? '' : secret).trim();
  if (!secret) return Keypair.generate();
  // Solana secret key (JSON array or base58 64-byte)
  if (isSolSecretKey(secret)) {
    const bytes = /^\[/.test(secret) ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret);
    return Keypair.fromSecretKey(bytes);
  }
  const words = secret.split(/\s+/).filter(Boolean);
  if ([12, 15, 18, 21, 24].includes(words.length) && bip39.validateMnemonic(words.join(' '))) {
    const seed = bip39.mnemonicToSeedSync(words.join(' '));                 // 64-byte BIP39 seed
    const { key } = derivePath(SOL_PATH, seed.toString('hex'));             // 32-byte ed25519 seed
    return Keypair.fromSeed(Uint8Array.from(key));
  }
  // EVM private key (64 hex, optional 0x): derive a SEPARATE, deterministic Solana
  // seed. Domain-separated so it can never collide with the EVM key's own bytes.
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(secret)) {
    const raw = Buffer.from(secret.replace(/^0x/, ''), 'hex');
    // Derivation domain tag is a wire-format constant: changing it would derive a
    // DIFFERENT Solana address for every existing wallet (stranding funds). It
    // keeps the original value on purpose (pre-rebrand).
    const seed = crypto.createHash('sha512').update(Buffer.concat([Buffer.from('robinfun:solana:v1'), raw])).digest().subarray(0, 32);
    return Keypair.fromSeed(Uint8Array.from(seed));
  }
  throw new Error('not a Solana key, EVM key, or seed phrase');
}
// The stored (encrypted) plaintext for a Solana wallet: base58 of the 64-byte secret
// key — exactly what Phantom/Solflare import. Round-trips via deriveKeypair.
function secretToBase58(keypair) { return bs58.encode(keypair.secretKey); }
function keypairFromStored(plain) {
  const bytes = /^\[/.test(String(plain).trim()) ? Uint8Array.from(JSON.parse(plain)) : bs58.decode(String(plain).trim());
  return Keypair.fromSecretKey(bytes);
}
// New Solana wallet material (encryption is core.js's job). `plain` is what gets
// stored (encrypted); `address` is the public base58.
function newWallet(secret) {
  const kp = deriveKeypair(secret);
  return { kind: KIND, address: kp.publicKey.toBase58(), plain: secretToBase58(kp) };
}

// ---------------------------------------------------------------- unit math

const solToLamports = (sol) => BigInt(Math.round(Number(sol) * LAMPORTS_PER_SOL));
const lamportsToSol = (lamports) => Number(lamports) / LAMPORTS_PER_SOL;
// Format a raw u64 token amount with its mint decimals (SPL mints are 6 or 9, never
// assume 18). Returns a JS number for display.
function fmtUnits(raw, decimals) {
  const d = Number.isFinite(decimals) ? decimals : 9;
  return Number(BigInt(raw)) / Math.pow(10, d);
}
function toRaw(amount, decimals) {
  const d = Number.isFinite(decimals) ? decimals : 9;
  return BigInt(Math.round(Number(amount) * Math.pow(10, d)));
}

// ---------------------------------------------------------------- Jupiter (pure builders)

// GET .../quote URL. amountRaw is the input amount in the input mint's base units
// (lamports for WSOL). platformFeeBps (optional) is the bot's cut Jupiter withholds.
// The PATH is what the live caller needs, because the base is chosen per request
// (see jupFetch) — a builder that baked one in could only ever address the host
// that happened to be up at require() time.
function quotePath({ inputMint, outputMint, amountRaw, slippageBps = 100, platformFeeBps }) {
  const p = new URLSearchParams({
    inputMint, outputMint, amount: String(amountRaw),
    slippageBps: String(slippageBps), swapMode: 'ExactIn',
    onlyDirectRoutes: 'false', asLegacyTransaction: 'false',
  });
  if (platformFeeBps > 0) p.set('platformFeeBps', String(platformFeeBps));
  return `/quote?${p.toString()}`;
}
function quoteUrl(opts, base) {
  return (base || JUP_BASES[0]) + quotePath(opts);
}
// POST .../swap body. `quoteResponse` is the JSON object returned by /quote.
function swapBody(quoteResponse, userPublicKey, { feeAccount, priorityLamports } = {}) {
  const body = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: false,
  };
  if (feeAccount) body.feeAccount = feeAccount;                                   // ATA that receives the platform fee
  // A NUMBER, or the field is left out entirely.
  //
  // This used to send the string 'auto' whenever no explicit priority was set —
  // which is every trade on a stock box, because SOL_PRIORITY_LAMPORTS defaults
  // to 0. 'auto' was v6's spelling; the current /swap/v1 endpoint rejects it and
  // the preflight caught it as "Jupiter swap-build failed (500)" while /quote on
  // the very same base answered fine. Omitting the field lets Jupiter choose,
  // which is what 'auto' was asking for, and is accepted by both APIs.
  //
  // The lesson the host failover did not carry: moving a base is not the same as
  // moving an API. The query path happened to be identical; the POST body was not.
  if (priorityLamports > 0) body.prioritizationFeeLamports = Math.floor(priorityLamports);
  return body;
}
// Pull the headline numbers out of a /quote response (defensive).
function parseQuote(q) {
  if (!q || q.error) return null;
  return {
    inAmount: BigInt(q.inAmount || 0),
    outAmount: BigInt(q.outAmount || 0),
    minOut: BigInt(q.otherAmountThreshold || 0),        // after slippage
    priceImpactPct: Number(q.priceImpactPct || 0),
    raw: q,
  };
}
// Bot fee in bps applied to an ETH/SOL-denominated notional (mirrors EVM BOT_FEE_BPS).
function feeLamports(notionalLamports, feeBps) {
  return (BigInt(notionalLamports) * BigInt(Math.max(0, Math.round(feeBps || 0)))) / 10000n;
}

// ---------------------------------------------------------------- live RPC (production)

const _conns = {};
function getConnection(rpc) {
  const url = rpc || (process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com');
  if (!_conns[url]) _conns[url] = new Connection(url, { commitment: 'confirmed' });
  return _conns[url];
}
async function solBalance(conn, address) {
  const v = await solBalanceOrNull(conn, address);
  return v == null ? 0n : v;
}
/**
 * The same read, but a FAILED one is distinguishable from a genuine zero.
 *
 * `solBalance` answers 0n for a dead RPC, a 429 and an empty wallet alike — and
 * every caller that has to decide something on the answer needs those apart.
 * The wallet-removal guard is the one that made it matter: an unreadable Solana
 * balance rendered as "empty of native on every chain I could read", under a
 * one-tap ✅ Remove, on a wallet holding 2.15 SOL. Same rule and same shape as
 * `splBalanceOrNull` one function down.
 */
async function solBalanceOrNull(conn, address) {
  try { return BigInt(await conn.getBalance(new PublicKey(address), 'confirmed')); } catch (_) { return null; }
}
// SPL balance of `mint` held by `owner`. Sums all token accounts (usually one ATA).
async function splBalance(conn, owner, mint) {
  try {
    const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed');
    let raw = 0n, decimals = 9;
    for (const it of (res.value || [])) {
      const info = it.account.data.parsed.info.tokenAmount;
      raw += BigInt(info.amount); decimals = info.decimals;
    }
    return { raw, decimals };
  } catch (_) { return { raw: 0n, decimals: 9 }; }
}
/**
 * The same read, but a FAILED one is distinguishable from a genuine zero.
 *
 * `splBalance` swallows its own errors and answers `0n`, which made
 * core.tokenBalanceOrNull — the function that exists precisely so a caller can
 * tell "no bag" from "the RPC did not answer" — unable to do that on Solana at
 * all. The live monitor reads a null as "keep watching" and a zero as "position
 * closed", so one RPC blip retired a pinned card on a position that was still
 * open. Null means the read failed; a real empty wallet still returns 0n.
 */
async function splBalanceOrNull(conn, owner, mint) {
  try {
    const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed');
    let raw = 0n;
    for (const it of (res.value || [])) raw += BigInt(it.account.data.parsed.info.tokenAmount.amount);
    return raw;
  } catch (_) { return null; }
}
// Preflight makes the RPC SIMULATE a transaction before it will accept it — an extra
// round trip plus simulation time on every swap, paid on the hot path while the price
// moves. Jupiter has ALREADY simulated the route when it built this transaction, so the
// second simulation buys almost nothing and costs the race; skipping it is the standard
// configuration for latency-sensitive Solana trading. A swap that would have been
// rejected now lands on-chain and reverts instead, costing the signature fee
// (~0.000005 SOL) — the slippage floor in the route still protects the funds. Set
// SOL_PREFLIGHT=1 to restore it. Plain transfers (bot fee, withdraw) keep preflight:
// they are not races, so there is nothing to buy by skipping it.
const SKIP_PREFLIGHT = String(process.env.SOL_PREFLIGHT || '') !== '1';

// How we learn a Solana transaction landed. See confirmSignature below for why this
// is ours and not web3.js's.
// 200ms: Solana reaches 'confirmed' in roughly 400-800ms, so this is the granularity
// at which we notice — the average lag it adds is half of it. Tighter costs requests
// for little gain, looser starts giving back the very latency this exists to remove.
// A confirmation window of about a second means ~5 status reads per trade.
const CONFIRM_POLL_MS = Math.max(50, Number(process.env.SOL_CONFIRM_POLL_MS || 200));
const CONFIRM_TIMEOUT_MS = Math.max(5000, Number(process.env.SOL_CONFIRM_TIMEOUT_MS || 60000));
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ONE STATUS READ FOR EVERY SIGNATURE BEING WATCHED RIGHT NOW.
 *
 * The "~5 status reads per trade" above is per TRADE, and a multi-wallet buy is
 * five trades at once. Five confirmations each polling on their own 200ms timer
 * is ~25 requests a second at the exact moment five sends and fifteen balance
 * reads have just gone out — comfortably past what Solana's public endpoint
 * serves one IP, and the throttling lands on the confirmations because they are
 * what is still running.
 *
 * Measured on the box, five wallets into one token on one block:
 *
 *     swap=541ms  swap=527ms  swap=522ms  swap=1297ms  swap=2289ms
 *
 * Same route, same quote, same slot — a 4.4x spread that is not the trade.
 *
 * `getSignatureStatuses` takes an ARRAY, and always could. Coalescing the polls
 * that fall in the same short window turns N concurrent confirmations into one
 * request per tick, so the fifth wallet stops paying for the other four.
 *
 * An RPC failure RESOLVES NULL rather than rejecting: confirmSignature treats a
 * transient failure as "keep polling", and a batch that rejected would turn one
 * blip into five failed confirmations.
 */
const STATUS_BATCH_MS = Math.max(0, Number(process.env.SOL_STATUS_BATCH_MS || 25));
const _statusQ = new Map();   // conn -> { sigs: Map<sig, resolve[]>, timer }

function signatureStatus(conn, sig) {
  if (!(STATUS_BATCH_MS > 0)) {
    return conn.getSignatureStatuses([sig]).then((r) => (r && r.value && r.value[0]) || null, () => null);
  }
  return new Promise((resolve) => {
    let q = _statusQ.get(conn);
    if (!q) { q = { sigs: new Map(), timer: null }; _statusQ.set(conn, q); }
    const waiting = q.sigs.get(sig);
    if (waiting) waiting.push(resolve); else q.sigs.set(sig, [resolve]);
    if (q.timer) return;
    q.timer = setTimeout(async () => {
      // Swap the map out FIRST: anything that arrives while the request is in
      // flight belongs to the next batch, not this one, or a late arrival is
      // resolved with a status read before it started waiting.
      const batch = q.sigs; q.sigs = new Map(); q.timer = null;
      const list = [...batch.keys()];
      let vals = [];
      try { const r = await conn.getSignatureStatuses(list); vals = (r && r.value) || []; } catch (_) { vals = []; }
      list.forEach((s, i) => { for (const fn of batch.get(s)) fn(vals[i] || null); });
      // Drop the per-connection entry once nothing is waiting on it. The first
      // cut of this tested `q.sigs` immediately after replacing it with an empty
      // Map, so the condition was always true on one side and never on the
      // other: the cleanup could not fire at all. One connection is the normal
      // case, so nothing leaked — but a line that cannot run is worse than no
      // line, because the next reader believes it does.
      if (!q.sigs.size && !q.timer && _statusQ.get(conn) === q) _statusQ.delete(conn);
    }, STATUS_BATCH_MS);
  });
}

/** Wait for `sig` to reach `confirmed`, by POLLING getSignatureStatuses over HTTP.
 *
 *  web3.js's own connection.confirmTransaction() cannot be used here. With the
 *  blockhash strategy it races a WEBSOCKET `signatureSubscribe` against a
 *  blockheight-expiry timer, and it makes exactly ONE http getSignatureStatus check
 *  — issued the instant the subscription is set up, i.e. before the transaction can
 *  possibly have landed. That check finds nothing and is never repeated. From then
 *  on the websocket is the only thing that can report success.
 *
 *  The default RPC for this bot is api.mainnet-beta.solana.com, whose websocket is
 *  aggressively throttled. When that subscription is dropped or never establishes, a
 *  swap that actually confirmed on-chain in half a second is simply not noticed: the
 *  call sits until the blockhash expires roughly a minute later and then throws
 *  TransactionExpiredBlockheightExceededError — so a SUCCESSFUL buy is reported to
 *  the user as "broadcast but not confirmed", a minute late, with their tokens
 *  already bought. Polling http is marginally chattier and completely immune to it.
 *
 *  Resolves with the signature. Throws on an on-chain error, or `{ timedOut: true }`
 *  if the deadline passes — callers treat that as broadcast-but-unconfirmed, never
 *  as a clean failure. */
async function confirmSignature(conn, sig, opts = {}) {
  const pollMs = opts.pollMs || CONFIRM_POLL_MS;
  const timeoutMs = opts.timeoutMs || CONFIRM_TIMEOUT_MS;
  const started = Date.now();
  for (;;) {
    try {
      // Batched across every confirmation in flight — see signatureStatus.
      const st = await signatureStatus(conn, sig);
      if (st) {
        if (st.err) throw Object.assign(new Error('transaction failed on-chain: ' + JSON.stringify(st.err)), { onChainError: st.err });
        const cs = st.confirmationStatus;
        if (cs === 'confirmed' || cs === 'finalized') return sig;
      }
    } catch (e) {
      if (e && e.onChainError) throw e;   // a real revert is an answer, not a hiccup
      /* transient RPC failure → keep polling */
    }
    if (Date.now() - started >= timeoutMs) throw Object.assign(new Error('not confirmed within ' + timeoutMs + 'ms: ' + sig), { timedOut: true });
    await _sleep(pollMs);
  }
}

// Execute a Jupiter swap: deserialize the base64 tx, sign with the keypair, send,
// confirm. Returns the base58 signature. Throws with a readable reason on failure.
async function sendJupiterSwap(conn, keypair, swapTransactionB64, onSent, timings) {
  const T = timings || {};
  let t = Date.now();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransactionB64, 'base64'));
  tx.sign([keypair]);
  const raw = tx.serialize();
  // The blockhash for the confirmation strategy is fetched CONCURRENTLY with the
  // broadcast. It used to be fetched only after sendRawTransaction had resolved, so
  // every swap sat through a full extra RPC round trip — with the transaction already
  // in flight — before confirmation could even start.
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: SKIP_PREFLIGHT, maxRetries: 3 });
  T.send = Date.now() - t; t = Date.now();
  // Past this point the tx is BROADCAST, and the caller is told so immediately —
  // waiting for 'confirmed' is another round the user does not need to spend
  // staring at a message with nothing in it.
  try { if (onSent) onSent(sig); } catch (_) {}
  // A swap that REVERTS is atomic (Jupiter swaps don't half-execute) → safe to treat
  // as "didn't spend", so that error propagates as a clean failure. A confirmation
  // we merely couldn't OBSERVE (timeout) is ambiguous — the tx may well have landed —
  // so it is tagged `.broadcast` + `.sig` and callers must NOT roll back budget/dedup.
  try {
    return await confirmSignature(conn, sig);
  } catch (e) {
    if (e && e.onChainError) throw new Error('swap reverted on-chain: ' + JSON.stringify(e.onChainError));
    throw Object.assign(new Error('swap broadcast but not confirmed yet: ' + sig), { broadcast: true, sig });
  } finally {
    // In a finally, so a trade that TIMED OUT still reports how long it waited —
    // that is precisely the case worth knowing the number for.
    T.confirm = Date.now() - t;
  }
}

// ---------------------------------------------------------------- Jupiter (live HTTP)

const _fetch = (...a) => (global.fetch ? global.fetch(...a) : Promise.reject(new Error('fetch unavailable')));

// undici throws `TypeError: fetch failed` for EVERY transport failure and puts the
// only useful part — the syscall code — in `err.cause`. Reading `e.message` and
// stopping there is what put the bare words "fetch failed" on a buy card: it
// cannot be told apart from a dead RPC, a blocked egress, a withdrawn host or a
// TLS failure, and all four need different answers from the operator.
//
// The returned error carries `.offline` so callers classify on the flag rather
// than by matching this text again somewhere else.
function netErr(e, url) {
  let host = url;
  try { host = new URL(url).host; } catch (_) {}
  const c = (e && e.cause) || {};
  const code = c.code || c.errno || (e && e.code) || '';
  const why = (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? 'no answer before the timeout'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'the name does not resolve from this server'
    : code === 'ECONNREFUSED' ? 'connection refused'
    : code === 'ECONNRESET' ? 'connection reset'
    : code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' ? 'connection timed out'
    : /CERT|SSL|TLS/i.test(String(code)) ? 'TLS failed (' + code + ')'
    : code || (c.message || (e && e.message) || 'unknown');
  const err = new Error(`can't reach ${host} — ${why}`);
  err.offline = true;
  err.host = host;
  err.code = code || undefined;
  return err;
}

// ------------------------------------------------ the per-IP request budget
//
// EVERY RULE BELOW IS ONE WAY FIVE WALLETS SPENT ONE WALLET'S ALLOWANCE.
//
// A five-wallet buy used to fire, in the same millisecond: five `/quote` GETs
// (byte-identical — same mints, same amount, same slippage), five `/tokens`
// reads for the same mint, and five `/swap` builds. Fifteen requests at once
// into a bucket metered per SOURCE ADDRESS. Jupiter answered the overflow with
// 429, and every wallet reported it as "Couldn't read live pricing for this
// token right now" — the whole batch, in one second, on a token that was
// perfectly tradable.
//
// Three rules, and each one closes a hole the others cannot:
//
//   1. IDENTICAL REQUESTS THAT ARE STILL IN THE AIR ARE ONE REQUEST (getQuote).
//      Five wallets buying the same amount of the same token ask one question.
//   2. THE BURST IS PACED, per HOST, so what is left arrives as a queue rather
//      than as a spike. `lite-api.jup.ag` serves the quote, the swap-build AND
//      the token registry, so keying the pacer on the host is what makes those
//      three share one budget without any caller having to know they do.
//   3. A 429 IS WAITED OUT ONCE, NOT PAID N TIMES. `Retry-After` is honoured and
//      recorded process-wide, so the four requests queued behind the one that
//      hit the limit wait for it instead of each spending their own 429. That is
//      this repo's `benched` rule, adapted: for a USER'S TRADE the answer is a
//      pace, never a refusal — a fill a second late beats a red cross.
//
// ⚠️ RETRYING IS SAFE HERE AND NOWHERE NEAR THE CHAIN. `/quote` is a GET and
// `/swap` returns an UNSIGNED transaction; neither moves a lamport, so a second
// attempt cannot double-spend. The broadcast (`sendRawTransaction`) is not on
// this path and is never retried by anything here.
//
// This is NOT the base failover being weakened. That rule — "fail over on a
// TRANSPORT error only, because a status means the host answered and the same
// request gets the same status everywhere else" — still holds and is why a 400
// is never retried at all. A 429 is the one status that explicitly means "ask me
// again later", and a 5xx is not deterministic; those two are retried ON THE
// SAME BASE, which is a different rule from moving to another host.
const JUP_MIN_GAP_MS = _envInt('JUP_MIN_GAP_MS', 90, 0, 5000);
const JUP_RETRIES = _envInt('JUP_RETRIES', 2, 0, 5);
const JUP_HTTP_TIMEOUT_MS = _envInt('JUP_HTTP_TIMEOUT_MS', 12000, 2000, 60000);
// The longest a request will sit waiting for a 429 to lift before giving up. A
// trade held for a minute is not a trade; past this the honest answer is the
// rate limit, named, so the user can decide.
const JUP_MAX_WAIT_MS = _envInt('JUP_MAX_WAIT_MS', 8000, 0, 60000);

// ⚠️ `Number('')` IS 0, AND 0 IS FINITE — a bare `JUP_MIN_GAP_MS=` in .env would
// silently mean "no pacing at all", and a bare `JUP_RETRIES=` "never retry",
// which is the state this whole section exists to end. Blank is ABSENT; an
// explicit 0 is still a real, honoured 0 (it is how an operator turns the pacer
// off). Third time this repo has been bitten by a falsy-but-valid number.
function _envInt(name, dflt, lo, hi) {
  const raw = String(process.env[name] == null ? '' : process.env[name]).trim();
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

// One budget per HOST — see rule 2 above. Never per module and never per
// endpoint: two callers with their own idea of one bucket is how a 429 one of
// them has already noticed gets hammered through by the other, which is the
// defect `gtPairs.js` names in its own header.
const _budgets = new Map();
function _budget(host) {
  let b = _budgets.get(host);
  if (!b) { b = { nextAt: 0, holdUntil: 0, why: '' }; _budgets.set(host, b); }
  return b;
}
/** Wait for this host's turn, or say why we will not. Returns null when the wait
 *  is over, or an Error when the budget cannot be honoured inside `deadline` —
 *  which is a real answer ("we are rate limited"), not a transport failure. */
async function _gate(host, deadline) {
  const b = _budget(host);
  for (;;) {
    const now = Date.now();
    const until = Math.max(b.nextAt, b.holdUntil);
    if (until <= now) { b.nextAt = now + JUP_MIN_GAP_MS; return null; }
    // The hold is reported as itself. "can't reach lite-api.jup.ag" would be a
    // false statement about a host that is answering perfectly well, and would
    // send an operator to check their egress for a problem in our own budget.
    if (until - now > Math.max(0, Math.min(JUP_MAX_WAIT_MS, deadline - now))) {
      // The number is how much longer the hold has to RUN, not how long we
      // waited — saying "waited 28s" about a request that returned instantly is
      // a small lie on the one line an operator reads to size the problem.
      const e = new Error(`Jupiter is rate-limiting this server — ${b.why || 'over the per-IP request budget'} (${Math.round((until - now) / 100) / 10}s left on the limit)`);
      e.rateLimited = true; e.status = 429;
      return e;
    }
    await _sleep(Math.min(250, until - now));
  }
}
/** A 429/503 that named when to come back. Seconds per RFC 7231; some hosts send
 *  a date, which parses to a real instant. Anything unreadable is not a reason to
 *  invent a long wait, so it falls back to the caller's own backoff. */
function _retryAfterMs(r) {
  let v = '';
  try { v = (r.headers && r.headers.get && r.headers.get('retry-after')) || ''; } catch (_) {}
  v = String(v || '').trim();
  if (!v) return 0;
  if (/^\d+$/.test(v)) return Math.min(60000, Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.min(60000, Math.max(0, at - Date.now())) : 0;
}
/** Record what a 429 said, for every request queued behind this one. */
function _holdHost(host, ms, why) {
  const b = _budget(host);
  b.holdUntil = Math.max(b.holdUntil, Date.now() + ms);
  b.why = why || b.why;
}
// A status that means "ask again": 429 is the host telling us to, and a 5xx is
// not a deterministic answer about the request. Everything else — a 400 above
// all — gets the same answer on every attempt and from every base, so retrying
// one only doubles the latency of a request that was always going to fail.
function _retryable(status) { return status === 429 || (status >= 500 && status < 600); }

// The base that last answered, so the healthy host is tried first rather than
// paying the dead one's connect timeout on every single trade.
let _jupBase = null;

// One Jupiter request, across the known bases. Failover happens ONLY on a
// transport error: an HTTP status means the host is there and answered, and a
// 400 from the right host would be a 400 from every other one too — retrying it
// elsewhere just doubles the latency of a request that was always going to fail.
async function jupFetch(path, init) {
  return _overBases(JUP_BASES, () => _jupBase, (b) => { _jupBase = b; }, path, init, 'Jupiter');
}

// The token registry is a different host family with the same failover story.
let _tokBase = null;
async function tokenFetch(path, init) {
  return _overBases(JUP_TOKEN_BASES, () => _tokBase, (b) => { _tokBase = b; }, path, init, 'Jupiter token');
}
// …and so is the launchpad feed. Three hosts families, one failover, because the
// next one to be retired should cost a config line and not an outage.
let _pumpBase = null;
async function pumpFetch(path, init) {
  return _overBases(PUMPFUN_BASES, () => _pumpBase, (b) => { _pumpBase = b; }, path, init, 'pump.fun');
}
// Try each base in turn, sticking to the one that answered. Fails over ONLY on a
// transport error: an HTTP status means the host is there and answered, and the
// same request would get the same status from every other base. A RETRYABLE
// status (429/5xx) is re-asked on the SAME base instead, inside the budget — see
// the long note above for why those two rules are not in conflict.
//
// `timeoutMs` is per ATTEMPT and `deadline` bounds the whole call, so a retry can
// never turn a 12s request into a minute. A caller that supplies its own `signal`
// keeps full control and gets no retry — it has said it owns the lifetime.
async function _overBases(bases, get, set, path, init, what) {
  const opt = init || {};
  const perTry = Number(opt.timeoutMs) > 0 ? Number(opt.timeoutMs) : JUP_HTTP_TIMEOUT_MS;
  // ⚠️ ONE BUDGET FOR THE WHOLE CALL, NOT ONE PER ATTEMPT. The first cut let the
  // deadline grow with the number of attempts, so a `Retry-After: 30` was
  // OBEYED — a buy sat there for thirty seconds and then filled at a price
  // half a minute old, which is worse than the red cross it replaced. A trade
  // held that long is not a trade. Past `JUP_MAX_WAIT_MS` the honest answer is
  // the rate limit itself, named, with the hold still recorded so nothing else
  // pays for it.
  const deadline = Date.now() + (Number(opt.deadlineMs) > 0 ? Number(opt.deadlineMs) : perTry + JUP_MAX_WAIT_MS);
  const tries = opt.signal ? 0 : JUP_RETRIES;
  const cur = get();
  const order = cur ? [cur, ...bases.filter((b) => b !== cur)] : bases;
  let last = null;
  for (const base of order) {
    const url = base + path;
    const host = hostOf(url);
    for (let attempt = 0; ; attempt++) {
      const held = await _gate(host, deadline);
      // ⚠️ THE REPORTED REASON IS THE FIRST ONE, NOT THE LAST. A hold still lets
      // the OTHER bases be tried — a different host is a different bucket, which
      // is the whole point of a keyed base sitting above the lite one — but the
      // legacy fallback is retired, so it fails at the transport and its
      // "can't reach quote-api.jup.ag" would then overwrite the rate limit that
      // actually stopped the trade. An operator sent to check their egress for a
      // problem in our own request budget is the misdiagnosis this section
      // exists to end. Same rule the web app's GT client states for its chunks.
      if (held) { last = last || held; break; }
      let r;
      try {
        r = await _fetch(url, Object.assign({}, opt, {
          headers: jupHeaders(url, opt.headers),
          signal: opt.signal || AbortSignal.timeout(Math.max(1000, Math.min(perTry, deadline - Date.now()))),
        }));
      } catch (e) {
        if (get() === base) set(null);
        last = last || netErr(e, url);
        break;                                     // transport → the NEXT BASE, the standing rule
      }
      set(base);
      if (r.ok || !_retryable(r.status) || attempt >= tries) return r;
      // A 429 is recorded for everything queued behind this request, so the
      // other four wallets wait it out instead of each buying their own.
      const asked = _retryAfterMs(r);
      const wait = asked || (Math.min(4000, 250 * Math.pow(2, attempt)) + Math.floor(Math.random() * 120));
      // The hold is recorded with what the host ACTUALLY asked for, even when
      // that is longer than we are prepared to wait here — the four requests
      // queued behind this one must know the real number, or they each spend
      // their own 429 discovering it.
      if (r.status === 429) _holdHost(host, wait, `${what} returned 429`);
      // …and this request waits only as long as a TRADE can afford to.
      if (wait > JUP_MAX_WAIT_MS || Date.now() + wait > deadline) return r;
      try { if (r.body && typeof r.body.cancel === 'function') r.body.cancel(); } catch (_) {}
      await _sleep(wait);
    }
  }
  throw last || new Error(`no ${what} base configured`);
}

// GET a Jupiter quote and return the parsed headline numbers + the raw object (which
// the /swap endpoint requires verbatim). Throws a readable reason when there's no route.
// What Jupiter actually SAID when it refused. A bare status is the same defect as
// undici's bare "fetch failed": "Jupiter swap-build failed (500)" was true, useless,
// and cost a round of guessing about which field the newer API disliked — while
// the answer was in the response body all along, being discarded one line later.
async function jupWhy(r) {
  try {
    const t = (await r.text()).slice(0, 300).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    try { const j = JSON.parse(t); return ' — ' + (j.error || j.message || j.errorCode || t); }
    catch (_) { return ' — ' + t; }
  } catch (_) { return ''; }
}
// A NON-OK STATUS IS THREE DIFFERENT FACTS, AND THEY WERE ONE SENTENCE.
//
// `Jupiter quote failed (<status>)` matched i18n's `/quote/` rule and came out
// as "Couldn't read live pricing for this token right now. Please try again in
// a moment." — under a 🔄 Try again button — for all of:
//
//   429  our own request budget, spent by the other four wallets. Waiting helps.
//   400  Jupiter has no route for this mint (COULD_NOT_FIND_ANY_ROUTE, or a
//        token it will not trade). Retrying changes NOTHING until the token
//        migrates or its pool opens, and telling somebody to keep tapping is the
//        exact defect this repo already fixed for the parsed-empty-quote door —
//        it simply had a second door, through the HTTP status, that nobody shut.
//   5xx  Jupiter is down. Not our budget and not the token.
//
// So the status travels on the error and the body travels with it. `jupWhy`
// already had the explanation and was only ever pasted into a sentence nothing
// could classify; `errorKey` reads `.status`/the named codes now.
function jupErr(status, what, why) {
  const tail = why || '';
  const e = new Error(
    status === 429 ? `Jupiter is rate-limiting this server (429)${tail}`
      : status >= 500 ? `Jupiter ${what} is unavailable (${status})${tail}`
      : `Jupiter ${what} failed (${status})${tail}`);
  e.status = status;
  if (status === 429) e.rateLimited = true;
  return e;
}

// FIVE WALLETS ASK ONE QUESTION.
//
// `quotePath` is built from the two mints, the amount and the slippage — nothing
// about WHO is buying — so a fan-out across wallets produces N byte-identical
// GETs in the same millisecond. They are one request now: a caller arriving
// while an identical one is still in the air joins it.
//
// ⚠️ IT IS NOT A CACHE, and the difference is the whole safety argument. Only a
// request that has NOT YET ANSWERED is shared; the entry is dropped the instant
// it settles, so the next buy always pays for a fresh price. A remembered quote
// would be a stale price authorising a trade, which is the one thing a quote may
// never be — it is the only executable price on this path (see `swap`).
const _quoteInflight = new Map();

async function getQuote({ inputMint, outputMint, amountRaw, slippageBps = 100, platformFeeBps }) {
  const qs = quotePath({ inputMint, outputMint, amountRaw, slippageBps, platformFeeBps });
  const joined = _quoteInflight.get(qs);
  // A shallow copy per caller. `raw` is shared deliberately — /swap needs that
  // object verbatim and copying it per wallet would be waste — but the headline
  // numbers are the caller's own, so a future caller that annotates its quote
  // cannot silently rewrite the other four wallets' trade.
  if (joined) return joined.then((q) => Object.assign({}, q));
  const p = _getQuote(qs);
  _quoteInflight.set(qs, p);
  p.catch(() => {}).then(() => { if (_quoteInflight.get(qs) === p) _quoteInflight.delete(qs); });
  return p.then((q) => Object.assign({}, q));
}

async function _getQuote(qs) {
  const r = await jupFetch(qs, {});
  if (!r.ok) throw jupErr(r.status, 'quote', await jupWhy(r));
  const j = await r.json();
  const q = parseQuote(j);
  if (!q || q.outAmount <= 0n) throw new Error('no route / no liquidity for this token on Jupiter');
  return q;   // { inAmount, outAmount, minOut, priceImpactPct, raw }
}
// POST the quote back to /swap and get the base64 VersionedTransaction to sign.
async function getSwapTx(quoteRaw, userPublicKey, { feeAccount, priorityLamports } = {}) {
  const body = swapBody(quoteRaw, userPublicKey, { feeAccount, priorityLamports });
  const r = await jupFetch('/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw jupErr(r.status, 'swap-build', await jupWhy(r));
  const j = await r.json();
  if (!j || !j.swapTransaction) throw new Error('Jupiter returned no swap transaction');
  return j.swapTransaction;   // base64
}
// One-shot: quote → build → sign → send → confirm. Returns { sig, quote }.
// `onQuote` is the LAST point at which a trade can still be called off for free:
// Jupiter has priced it, nothing is signed, nothing is broadcast. It may throw to
// abort. This hook exists because the quote is the only executable price in the
// system, and the price the user tapped came from somewhere else entirely — see
// the divergence guard in core.js _buySol.
async function swap(conn, keypair, { inputMint, outputMint, amountRaw, slippageBps, priorityLamports, onSent, onQuote, quoteP, timings }) {
  // `timings` is filled in as each phase completes. A single opaque "swap=2289ms"
  // cannot tell a slow router from a throttled RPC from a transaction that took
  // ten slots to land, and those need three different answers — one of which is
  // not a code change at all.
  const T = timings || {};
  let t = Date.now();
  // `quoteP` lets a caller start the quote EARLIER than this function is reached.
  // Nothing in a quote comes from the chain — two mints, an amount, a slippage —
  // so _buySol issues it alongside its balance and metadata reads instead of
  // stacking Jupiter's round trip on top of an RPC round trip it does not depend
  // on. Absent, the behaviour is exactly as before.
  const quote = await (quoteP || getQuote({ inputMint, outputMint, amountRaw, slippageBps }));
  T.quote = Date.now() - t; t = Date.now();
  if (onQuote) await onQuote(quote);
  T.guard = Date.now() - t; t = Date.now();
  const txB64 = await getSwapTx(quote.raw, keypair.publicKey.toBase58(), { priorityLamports });
  T.build = Date.now() - t;
  const sig = await sendJupiterSwap(conn, keypair, txB64, onSent, T);
  return { sig, quote };
}

// ---------------------------------------------------------------- native SOL transfer

// ---------------------------------------------------------------- native transfer cost

/**
 * The rent-exempt minimum for a plain (0-byte) system account, in lamports.
 *
 * IT IS NOT A CONSTANT AND MUST NOT BE GUESSED FROM ONE SIDE OF A WITHDRAWAL.
 * Solana refuses any transaction that leaves an account holding MORE than zero
 * and LESS than this — the account would be "rent-paying", a state the runtime
 * stopped allowing new accounts to enter. Zero is fine (the account is simply
 * purged and comes back the moment somebody sends to it); a dust remainder is
 * not. That single rule is what made every `max` withdrawal this bot has ever
 * offered fail with
 *
 *     Transaction results in an account (0) with insufficient funds for rent
 *
 * because the sweep deliberately kept a 10,000-lamport "fee reserve" behind —
 * which is above the fee and far below this floor, i.e. in the one band the
 * chain rejects. Cached per connection: it changes only with a cluster-wide
 * rent parameter change, and a withdrawal must not pay a round trip for it.
 */
const _rentMin = new WeakMap();
async function rentExemptMin(conn) {
  const hit = _rentMin.get(conn);
  if (hit != null) return hit;
  try {
    const v = BigInt(await conn.getMinimumBalanceForRentExemption(0));
    if (v > 0n) { _rentMin.set(conn, v); return v; }
  } catch (_) { /* fall through to the documented default */ }
  return 890880n;   // 0-byte account at the standard rent parameters
}

/**
 * The fee THIS transfer will be charged, measured against the message that will
 * actually be signed rather than assumed from a per-signature constant.
 *
 * A sweep has to land on the balance exactly: one lamport short of the fee and
 * the transaction is rejected for insufficient funds, one lamport over and the
 * account is left rent-paying and rejected for that instead. Both failures are
 * the same cryptic simulation error, so the number cannot be a guess. The 5,000
 * fallback is the base fee for a single signature — right today, and only ever
 * reached when the node will not answer `getFeeForMessage`.
 */
async function transferFee(conn, fromPubkey, toBase58, lamports, blockhash) {
  try {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey, toPubkey: new PublicKey(toBase58), lamports: BigInt(lamports > 0n ? lamports : 1n),
    }));
    tx.feePayer = fromPubkey;
    tx.recentBlockhash = blockhash || (await conn.getLatestBlockhash('confirmed')).blockhash;
    const r = await conn.getFeeForMessage(tx.compileMessage(), 'confirmed');
    const f = r && r.value != null ? BigInt(r.value) : 0n;
    if (f > 0n) return f;
  } catch (_) { /* fall through */ }
  return 5000n;
}

// Send `lamports` SOL from `keypair` to `toBase58`. Used for the bot fee and for
// withdrawals.
//
// Default: confirms, then resolves with the base58 signature (what a withdrawal
// wants — the user is told it is done only once it is done).
//
// `opts.confirm === false`: resolves as soon as the transfer is BROADCAST, with
// `{ sig, confirmed }` where `confirmed` is a promise that settles when it lands.
// The bot-fee path uses this so a trade's receipt is not held behind the bot
// collecting its own cut (see _chargeFeeSol in core.js).
async function sendSol(conn, keypair, toBase58, lamports, opts) {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: keypair.publicKey, toPubkey: new PublicKey(toBase58), lamports: BigInt(lamports),
  }));
  const bh = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = bh.blockhash; tx.feePayer = keypair.publicKey;
  tx.sign(keypair);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  // Polled over http, not watched over a websocket — see confirmSignature.
  const confirmed = confirmSignature(conn, sig).catch((e) => {
    if (e && e.onChainError) throw new Error('SOL transfer failed: ' + JSON.stringify(e.onChainError));
    throw e;
  });
  if (opts && opts.confirm === false) { confirmed.catch(() => {}); return { sig, confirmed }; }
  return await confirmed;
}

// ---------------------------------------------------------------- SPL transfer (withdraw)

// Transfer `rawAmount` (base units) of SPL `mint` from the keypair to `toBase58`.
// Creates the recipient's associated token account if missing (sender pays ~0.002 SOL
// rent). Uses transferChecked (decimals-verified). Returns the signature. Lazy-requires
// @solana/spl-token so the EVM path never loads it.
async function sendSplToken(conn, keypair, mint, toBase58, rawAmount, decimals) {
  const spl = require('@solana/spl-token');
  const owner = keypair.publicKey;
  const mintPk = new PublicKey(mint);
  const dest = new PublicKey(toBase58);
  const srcAta = await spl.getAssociatedTokenAddress(mintPk, owner);
  const dstAta = await spl.getAssociatedTokenAddress(mintPk, dest);
  const tx = new Transaction();
  let needAta = false;
  try { await spl.getAccount(conn, dstAta); } catch (_) { needAta = true; }
  if (needAta) tx.add(spl.createAssociatedTokenAccountInstruction(owner, dstAta, dest, mintPk));
  tx.add(spl.createTransferCheckedInstruction(srcAta, mintPk, dstAta, owner, BigInt(rawAmount), Number(decimals)));
  const bh = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = bh.blockhash; tx.feePayer = owner;
  tx.sign(keypair);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  try { return await confirmSignature(conn, sig); }
  catch (e) {
    if (e && e.onChainError) throw new Error('SPL transfer failed: ' + JSON.stringify(e.onChainError));
    throw e;
  }
}

// ---------------------------------------------------------------- SPL metadata

// Mint decimals straight from the mint account (authoritative; name/symbol live in
// Metaplex metadata, fetched best-effort below).
async function splDecimals(conn, mint) {
  const d = await splDecimalsOrNull(conn, mint);
  return d == null ? 9 : d;
}
/**
 * The mint's decimals, or NULL when they could not be read.
 *
 * The difference matters more than it looks. `splDecimals` answers 9 for a
 * failed read, which is a guess wearing the clothes of a fact — and on a
 * 6-decimal mint (every pump.fun token) a guess of 9 divides the holding by a
 * thousand. A caller that would rather show nothing than show a number that is
 * out by 1000× needs to be able to tell the two apart.
 */
async function splDecimalsOrNull(conn, mint) {
  try {
    const s = await conn.getTokenSupply(new PublicKey(mint));
    const d = Number(s.value.decimals);
    return Number.isFinite(d) ? d : null;
  } catch (_) { return null; }
}
// Best-effort token identity from Jupiter's token registry (name/symbol/decimals).
// Returns null on any failure — callers fall back to a shortened mint. Never throws.
async function jupTokenMeta(mint) {
  try {
    // Same host migration as the swap API, same failover, same reason to keep
    // both: the registry moved off tokens.jup.ag to lite-api.jup.ag/tokens/v1.
    const r = await tokenFetch('/' + mint, { timeoutMs: 8000 });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || (!j.symbol && !j.name)) return null;
    return { name: String(j.name || j.symbol || 'Token').slice(0, 40), sym: String(j.symbol || 'TOKEN').slice(0, 20), decimals: Number.isFinite(j.decimals) ? Number(j.decimals) : undefined };
  } catch (_) { return null; }
}
// Combined SPL meta: decimals from the chain (authoritative), name/symbol from Jupiter
// (best-effort). Always resolves to a usable object so a trade can be recorded.
async function splMeta(conn, mint) {
  // One RPC call and one HTTP call that know nothing about each other — they used
  // to be awaited in series, so identifying a mint took the sum of both timeouts
  // instead of the slower one. On the buy path that was pure dead time.
  const [dec, j] = await Promise.all([splDecimalsOrNull(conn, mint), jupTokenMeta(mint)]);
  const shortMint = mint.slice(0, 4) + '…' + mint.slice(-4);
  // THE MINT WINS. This preferred the registry's `decimals` over the mint
  // account's, which inverts the only thing that is not a matter of opinion
  // here: the mint account's `decimals` field IS the definition of the token's
  // units, and a registry disagreeing with it is a registry that is wrong. Name
  // and symbol are metadata and the registry is the better source for those;
  // decimals are arithmetic, and getting them from a third party is how a
  // balance comes out a thousand times too large or too small.
  return {
    name: (j && j.name) || shortMint,
    sym: (j && j.sym) || shortMint,
    decimals: Number.isFinite(dec) ? dec : ((j && Number.isFinite(j.decimals)) ? j.decimals : 9),
  };
}

// ---------------------------------------------------------------- market data (DexScreener)

// Best Solana market for `mint` from DexScreener (the deepest-liquidity pair). Gives
// price (USD + native), liquidity, 24h volume, market cap, and token identity — all a
// card needs. null when the token isn't indexed / has no pool. Never throws.
async function dexScreener(mint) {
  try {
    const r = await _fetch('https://api.dexscreener.com/latest/dex/tokens/' + mint, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const pairs = ((j && j.pairs) || []).filter((p) => p && p.chainId === 'solana' && Number(p.priceUsd) > 0);
    if (!pairs.length) return null;
    pairs.sort((a, b) => (Number(b.liquidity && b.liquidity.usd) || 0) - (Number(a.liquidity && a.liquidity.usd) || 0));
    const p = pairs[0], base = p.baseToken || {};
    return {
      priceUsd: Number(p.priceUsd) || 0,
      priceNative: Number(p.priceNative) || 0,               // price in the quote token (SOL for SOL-quoted pairs)
      quoteSym: (p.quoteToken && p.quoteToken.symbol) || '',
      liquidityUsd: Number(p.liquidity && p.liquidity.usd) || 0,
      volH24Usd: Number(p.volume && p.volume.h24) || 0,
      mcapUsd: Number(p.marketCap) || Number(p.fdv) || 0,
      fdvUsd: Number(p.fdv) || 0,
      name: String(base.name || '').slice(0, 40),
      symbol: String(base.symbol || '').slice(0, 20),
      dexId: p.dexId || '',
    };
  } catch (_) { return null; }
}

// ---------------------------------------------------------------- new launches (pump.fun)

// Recently-created pump.fun coins, newest first. The canonical Solana launchpad feed —
// used by the snipe watcher for discovery (the buy itself routes through Jupiter). Best-
// effort: returns [] on any failure / unsupported response. Override the host via
// PUMPFUN_API (e.g. a proxy) if the public frontend API is unreachable.
async function pumpfunNew(limit = 50) {
  const r = await pumpfunNewX(limit);
  return r.coins;
}
// The same call, but honest about WHY it is empty.
//
// `ok` is whether the feed ANSWERED, kept apart from whether it had anything —
// the distinction core.js dsPairsX already makes for the same reason. A 403
// (pump.fun blocking a datacenter IP), a 429, a 500 and a dead host all used to
// arrive as the same empty array as a genuinely quiet minute on the launchpad,
// so no caller could classify it and none could warn. The snipe loop's early
// `if (!coins.length) return` then counted as a SUCCESSFUL tick, and /health
// printed a green solSnipe while discovery had been blind for days.
async function pumpfunNewX(limit = 50) {
  try {
    const n = Math.max(1, Math.min(100, limit));
    const r = await pumpFetch(`?offset=0&limit=${n}&sort=created_timestamp&order=DESC&includeNsfw=true`,
      { timeoutMs: 9000, headers: { accept: 'application/json' } });
    if (!r.ok) return { coins: [], ok: false, why: `pump.fun answered ${r.status}` };
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (Array.isArray(j && j.coins) ? j.coins : []);
    return { ok: true, why: '', coins: arr.map((c) => ({
      mint: String((c && (c.mint || c.address)) || ''),
      name: String((c && c.name) || '').slice(0, 40),
      symbol: String((c && c.symbol) || '').slice(0, 20),
      createdTs: Number(c && c.created_timestamp) || 0,
      mcapUsd: Number(c && c.usd_market_cap) || 0,
      complete: !!(c && c.complete),
      // The launch's creator/dev wallet (base58) — used by dev-wallet snipe to match a
      // followed dev. Absent/renamed field → '' → simply never matches (fails safe).
      creator: String((c && (c.creator || c.creator_address || c.dev)) || ''),
    })).filter((c) => isSolAddress(c.mint)) };
  } catch (e) { return { coins: [], ok: false, why: (e && e.message) || 'pump.fun unreachable' }; }
}

module.exports = {
  KIND, WSOL_MINT, SOL_PATH, LAMPORTS_PER_SOL, JUP_BASE, JUP_BASES, JUP_TOKEN_BASES, PUMPFUN_BASES,
  pumpfunNewX, pumpBase: () => _pumpBase,
  isSolAddress, isSolSecretKey,
  deriveKeypair, secretToBase58, keypairFromStored, newWallet,
  solToLamports, lamportsToSol, fmtUnits, toRaw,
  quoteUrl, quotePath, swapBody, parseQuote, feeLamports, netErr,
  jupBase: () => _jupBase,   // which host actually answered — for the preflight
  getConnection, solBalance, solBalanceOrNull, splDecimalsOrNull, splBalance, splBalanceOrNull, sendJupiterSwap, sendSplToken, confirmSignature,
  rentExemptMin, transferFee,
  getQuote, getSwapTx, swap, sendSol, splDecimals, jupTokenMeta, splMeta, dexScreener, pumpfunNew,
  jupErr, jupKeyed: () => !!JUP_API_KEY, jupHeaders,
  JUP_MIN_GAP_MS, JUP_RETRIES,
  // ⚠️ THE REQUEST BUDGET IS PROCESS STATE, so a test that trips a 429 leaves a
  // hold behind and the next test reads a rate limit it never caused — which
  // looks exactly like a regression in the code under test. Stated, never
  // inherited: the rule this repo's auto-trend panel helper had to learn.
  _resetBudget: () => { _budgets.clear(); _jupBase = null; _tokBase = null; _pumpBase = null; _quoteInflight.clear(); },
  _budgets,   // test-only: proves a 429 was recorded once and not paid five times
  _statusQ,   // test-only: proves the batch queue is emptied, not just drained
};
