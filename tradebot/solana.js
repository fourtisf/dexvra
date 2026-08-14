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
const JUP_BASE = (process.env.JUP_BASE || '').trim().replace(/\/+$/, '');
const JUP_BASES = JUP_BASE ? [JUP_BASE] : [
  'https://lite-api.jup.ag/swap/v1',
  'https://quote-api.jup.ag/v6',
];
const JUP_TOKEN_BASE = (process.env.JUP_TOKEN_BASE || '').trim().replace(/\/+$/, '');
const JUP_TOKEN_BASES = JUP_TOKEN_BASE ? [JUP_TOKEN_BASE] : [
  'https://lite-api.jup.ag/tokens/v1/token',
  'https://tokens.jup.ag/token',
];

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
  if (priorityLamports > 0) body.prioritizationFeeLamports = Math.floor(priorityLamports);
  else body.prioritizationFeeLamports = 'auto';
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
  try { return BigInt(await conn.getBalance(new PublicKey(address), 'confirmed')); } catch (_) { return 0n; }
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
      const r = await conn.getSignatureStatuses([sig]);
      const st = r && r.value && r.value[0];
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
async function sendJupiterSwap(conn, keypair, swapTransactionB64, onSent) {
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransactionB64, 'base64'));
  tx.sign([keypair]);
  const raw = tx.serialize();
  // The blockhash for the confirmation strategy is fetched CONCURRENTLY with the
  // broadcast. It used to be fetched only after sendRawTransaction had resolved, so
  // every swap sat through a full extra RPC round trip — with the transaction already
  // in flight — before confirmation could even start.
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: SKIP_PREFLIGHT, maxRetries: 3 });
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

// The base that last answered, so the healthy host is tried first rather than
// paying the dead one's connect timeout on every single trade.
let _jupBase = null;

// One Jupiter request, across the known bases. Failover happens ONLY on a
// transport error: an HTTP status means the host is there and answered, and a
// 400 from the right host would be a 400 from every other one too — retrying it
// elsewhere just doubles the latency of a request that was always going to fail.
async function jupFetch(path, init) {
  const bases = _jupBase ? [_jupBase, ...JUP_BASES.filter((b) => b !== _jupBase)] : JUP_BASES;
  let last = null;
  for (const base of bases) {
    const url = base + path;
    try {
      const r = await _fetch(url, init);
      _jupBase = base;
      return r;
    } catch (e) {
      if (_jupBase === base) _jupBase = null;
      last = netErr(e, url);
    }
  }
  throw last || new Error('no Jupiter base configured');
}

// The token registry is a different host family with the same failover story.
let _tokBase = null;
async function tokenFetch(path, init) {
  const bases = _tokBase ? [_tokBase, ...JUP_TOKEN_BASES.filter((b) => b !== _tokBase)] : JUP_TOKEN_BASES;
  let last = null;
  for (const base of bases) {
    const url = base + path;
    try { const r = await _fetch(url, init); _tokBase = base; return r; }
    catch (e) { if (_tokBase === base) _tokBase = null; last = netErr(e, url); }
  }
  throw last || new Error('no Jupiter token base configured');
}

// GET a Jupiter quote and return the parsed headline numbers + the raw object (which
// the /swap endpoint requires verbatim). Throws a readable reason when there's no route.
async function getQuote({ inputMint, outputMint, amountRaw, slippageBps = 100, platformFeeBps }) {
  const qs = quotePath({ inputMint, outputMint, amountRaw, slippageBps, platformFeeBps });
  const r = await jupFetch(qs, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('Jupiter quote failed (' + r.status + ')');
  const j = await r.json();
  const q = parseQuote(j);
  if (!q || q.outAmount <= 0n) throw new Error('no route / no liquidity for this token on Jupiter');
  return q;   // { inAmount, outAmount, minOut, priceImpactPct, raw }
}
// POST the quote back to /swap and get the base64 VersionedTransaction to sign.
async function getSwapTx(quoteRaw, userPublicKey, { feeAccount, priorityLamports } = {}) {
  const body = swapBody(quoteRaw, userPublicKey, { feeAccount, priorityLamports });
  const r = await jupFetch('/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('Jupiter swap-build failed (' + r.status + ')');
  const j = await r.json();
  if (!j || !j.swapTransaction) throw new Error('Jupiter returned no swap transaction');
  return j.swapTransaction;   // base64
}
// One-shot: quote → build → sign → send → confirm. Returns { sig, quote }.
async function swap(conn, keypair, { inputMint, outputMint, amountRaw, slippageBps, priorityLamports, onSent }) {
  const quote = await getQuote({ inputMint, outputMint, amountRaw, slippageBps });
  const txB64 = await getSwapTx(quote.raw, keypair.publicKey.toBase58(), { priorityLamports });
  const sig = await sendJupiterSwap(conn, keypair, txB64, onSent);
  return { sig, quote };
}

// ---------------------------------------------------------------- native SOL transfer

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
  try { const s = await conn.getTokenSupply(new PublicKey(mint)); return Number(s.value.decimals); } catch (_) { return 9; }
}
// Best-effort token identity from Jupiter's token registry (name/symbol/decimals).
// Returns null on any failure — callers fall back to a shortened mint. Never throws.
async function jupTokenMeta(mint) {
  try {
    // Same host migration as the swap API, same failover, same reason to keep
    // both: the registry moved off tokens.jup.ag to lite-api.jup.ag/tokens/v1.
    const r = await tokenFetch('/' + mint, { signal: AbortSignal.timeout(8000) });
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
  const [dec, j] = await Promise.all([splDecimals(conn, mint), jupTokenMeta(mint)]);
  const shortMint = mint.slice(0, 4) + '…' + mint.slice(-4);
  return { name: (j && j.name) || shortMint, sym: (j && j.sym) || shortMint, decimals: (j && Number.isFinite(j.decimals)) ? j.decimals : dec };
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
  const base = (process.env.PUMPFUN_API || 'https://frontend-api.pump.fun/coins').replace(/\/+$/, '');
  try {
    const n = Math.max(1, Math.min(100, limit));
    const url = `${base}?offset=0&limit=${n}&sort=created_timestamp&order=DESC&includeNsfw=true`;
    const r = await _fetch(url, { signal: AbortSignal.timeout(9000), headers: { accept: 'application/json' } });
    if (!r.ok) return [];
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (Array.isArray(j && j.coins) ? j.coins : []);
    return arr.map((c) => ({
      mint: String((c && (c.mint || c.address)) || ''),
      name: String((c && c.name) || '').slice(0, 40),
      symbol: String((c && c.symbol) || '').slice(0, 20),
      createdTs: Number(c && c.created_timestamp) || 0,
      mcapUsd: Number(c && c.usd_market_cap) || 0,
      complete: !!(c && c.complete),
      // The launch's creator/dev wallet (base58) — used by dev-wallet snipe to match a
      // followed dev. Absent/renamed field → '' → simply never matches (fails safe).
      creator: String((c && (c.creator || c.creator_address || c.dev)) || ''),
    })).filter((c) => isSolAddress(c.mint));
  } catch (_) { return []; }
}

module.exports = {
  KIND, WSOL_MINT, SOL_PATH, LAMPORTS_PER_SOL, JUP_BASE, JUP_BASES, JUP_TOKEN_BASES,
  isSolAddress, isSolSecretKey,
  deriveKeypair, secretToBase58, keypairFromStored, newWallet,
  solToLamports, lamportsToSol, fmtUnits, toRaw,
  quoteUrl, quotePath, swapBody, parseQuote, feeLamports, netErr,
  jupBase: () => _jupBase,   // which host actually answered — for the preflight
  getConnection, solBalance, splBalance, sendJupiterSwap, sendSplToken, confirmSignature,
  getQuote, getSwapTx, swap, sendSol, splDecimals, jupTokenMeta, splMeta, dexScreener, pumpfunNew,
};
