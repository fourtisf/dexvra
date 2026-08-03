'use strict';
/*
 * Execution-latency regressions.
 *
 * Every assertion here guards a change that was worth WALL-CLOCK SECONDS on a
 * trade, and every one of them is the kind of thing a later refactor removes
 * without noticing — a default that looks harmless, an `await` that reads more
 * naturally on its own line. The point of this file is that the next person to
 * put the slow version back gets a red test instead of a slow bot.
 */
const test = require('node:test');
const assert = require('node:assert');

const chains = require('./chains');
const solana = require('./solana');

// ---------------------------------------------------------------- RPC provider
test('receipt polling is tuned per chain, never left at ethers 4000ms default', () => {
  // ethers polls for new blocks every 4s by default, and that interval is what
  // decides how late tx.wait() notices a receipt. A buy waits on two receipts,
  // so the default cost up to ~8s per fill on chains with sub-second blocks.
  for (const key of ['robinhood', 'ethereum', 'base', 'bsc', 'arbitrum']) {
    const p = chains.providerFor(key);
    assert.ok(p.pollingInterval < 4000, `${key} still polls at the ethers default (${p.pollingInterval}ms)`);
    assert.ok(p.pollingInterval >= 100, `${key} polls too aggressively (${p.pollingInterval}ms)`);
  }
});

test('fast L2s poll faster than Ethereum — the interval tracks block time', () => {
  // Polling Ethereum (12s blocks) at 250ms is wasted requests; polling an Orbit
  // L2 at 1s is wasted time. The defaults must not collapse to one number.
  assert.ok(chains.pollMsFor('robinhood') < chains.pollMsFor('ethereum'));
  assert.ok(chains.pollMsFor('arbitrum') < chains.pollMsFor('ethereum'));
});

test('JSON-RPC batching is on everywhere except the quirky Robinhood node', () => {
  // batchMaxCount:1 turns every Promise.all of reads into N HTTP round trips.
  for (const key of ['ethereum', 'base', 'bsc', 'arbitrum']) {
    assert.ok(chains.batchFor(key) > 1, `${key} is not batching JSON-RPC calls`);
  }
  // The Robinhood node already mis-frames single-call error envelopes (see
  // rawSend in core.js) — it is deliberately not handed an array.
  assert.equal(chains.batchFor('robinhood'), 1);
});

// ---------------------------------------------------------------- Solana swap
test('swap skips preflight by default — Jupiter already simulated the route', async () => {
  // Preflight is a second full simulation round trip on the hot path, for a
  // transaction Jupiter built and simulated itself.
  let sawOpts = null;
  const conn = fakeConn({ onSend: (raw, opts) => { sawOpts = opts; } });
  await solana.sendJupiterSwap(conn, fakeKeypair(), fakeSwapTxB64());
  assert.equal(sawOpts.skipPreflight, true);
});

test('swap fetches its confirmation blockhash CONCURRENTLY with the broadcast', async () => {
  // It used to be fetched only after sendRawTransaction resolved: a full extra
  // round trip with the transaction already in flight, before confirmation
  // could even start. Concurrent means the blockhash call is issued before the
  // send has come back.
  const order = [];
  const conn = fakeConn({
    onBlockhash: () => order.push('blockhash-requested'),
    onSend: () => order.push('send-returned'),
    sendDelayMs: 20,
  });
  await solana.sendJupiterSwap(conn, fakeKeypair(), fakeSwapTxB64());
  assert.deepEqual(order, ['blockhash-requested', 'send-returned']);
});

test('a swap that broadcasts but cannot confirm is tagged, not reported as failed', async () => {
  // Unchanged safety property: the tx may still land, so callers must not roll
  // back committed budget. Guarded here because the confirm path was rewritten.
  const conn = fakeConn({ confirmThrows: true });
  await assert.rejects(
    () => solana.sendJupiterSwap(conn, fakeKeypair(), fakeSwapTxB64()),
    (e) => e.broadcast === true && typeof e.sig === 'string',
  );
});

// ---------------------------------------------------------------- bot fee transfer
test('sendSol confirm:false returns as soon as it is broadcast', async () => {
  // This is what takes the bot's own 1% fee transfer off the trade's critical
  // path. Resolving before confirmation is the entire point.
  let released = null;
  const conn = fakeConn({ confirmGate: new Promise((r) => { released = r; }) });
  const out = await solana.sendSol(conn, fakeKeypair(), BASE58_ADDR, 1000n, { confirm: false });
  assert.ok(out.sig, 'no signature returned on broadcast');
  assert.ok(out.confirmed instanceof Promise, 'no confirmation handle returned');
  released({ value: { err: null } });
  assert.equal(await out.confirmed, out.sig);
});

test('sendSol still waits for confirmation by default (withdrawals must not lie)', async () => {
  // A withdrawal tells the user their funds have moved — it may only say so
  // once that is true. The deferral is opt-in, never the default.
  let confirmed = false;
  const conn = fakeConn({ onConfirm: () => { confirmed = true; } });
  const sig = await solana.sendSol(conn, fakeKeypair(), BASE58_ADDR, 1000n);
  assert.equal(typeof sig, 'string');
  assert.equal(confirmed, true);
});

test('a deferred transfer that reverts rejects its handle — the referral is not credited', async () => {
  // The money invariant: the referral share is gated on the fee actually
  // landing. Deferring the wait must not turn a revert into a silent success.
  const conn = fakeConn({ confirmErr: { InstructionError: 1 } });
  const out = await solana.sendSol(conn, fakeKeypair(), BASE58_ADDR, 1000n, { confirm: false });
  await assert.rejects(() => out.confirmed);
});

// ---------------------------------------------------------------- SPL metadata
test('splMeta runs its two independent lookups concurrently', async () => {
  // decimals (RPC) and name/symbol (Jupiter registry) know nothing about each
  // other. In series a mint cost the SUM of both; concurrently it costs the
  // slower one. This runs on the buy path.
  const gate = { decimals: false, registry: false };
  let bothInFlight = false;
  const conn = {
    getTokenSupply: async () => {
      gate.decimals = true; bothInFlight = bothInFlight || gate.registry;
      await tick(10);
      bothInFlight = bothInFlight || gate.registry;
      return { value: { decimals: 6, amount: '1' } };
    },
  };
  const realFetch = global.fetch;
  global.fetch = async () => {
    gate.registry = true; bothInFlight = bothInFlight || gate.decimals;
    await tick(10);
    return { ok: true, json: async () => ({ name: 'Tok', symbol: 'TOK', decimals: 6 }) };
  };
  try {
    const m = await solana.splMeta(conn, BASE58_ADDR);
    assert.equal(m.sym, 'TOK');
    assert.ok(bothInFlight, 'splMeta still awaits its two lookups one after the other');
  } finally { global.fetch = realFetch; }
});

// ---------------------------------------------------------------- helpers
const BASE58_ADDR = 'So11111111111111111111111111111111111111112';
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeKeypair() {
  // A real keypair: sendJupiterSwap actually signs, so this cannot be a stub.
  return solana.deriveKeypair('0x' + '11'.repeat(32));
}

// A minimal signed VersionedTransaction, base64 — the shape sendJupiterSwap
// deserializes. Built from web3.js so it stays valid if the wire format moves.
function fakeSwapTxB64() {
  const web3 = require('@solana/web3.js');
  const kp = fakeKeypair();
  const msg = new web3.TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: BASE58_ADDR,   // any base58 32-byte value is a valid blockhash here
    instructions: [web3.SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })],
  }).compileToV0Message();
  return Buffer.from(new web3.VersionedTransaction(msg).serialize()).toString('base64');
}

function fakeConn(o = {}) {
  return {
    getLatestBlockhash: async () => {
      if (o.onBlockhash) o.onBlockhash();
      return { blockhash: BASE58_ADDR, lastValidBlockHeight: 1 };
    },
    sendRawTransaction: async (raw, opts) => {
      if (o.sendDelayMs) await tick(o.sendDelayMs);
      if (o.onSend) o.onSend(raw, opts);
      return 'SIG_' + (o.sig || 'test');
    },
    confirmTransaction: async () => {
      if (o.onConfirm) o.onConfirm();
      if (o.confirmThrows) throw new Error('blockheight exceeded');
      if (o.confirmGate) return await o.confirmGate;
      return { value: { err: o.confirmErr || null } };
    },
  };
}
