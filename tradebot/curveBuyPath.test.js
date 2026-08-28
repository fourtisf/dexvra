'use strict';
/*
 * A BONDING-CURVE TOKEN CAN NOW ACTUALLY BE BOUGHT — driven through the REAL
 * core.buy, against a stubbed chain.
 *
 * WHY THIS FILE HAS TO ASSERT A POSITIVE
 * Every other test on this path asserts a refusal, and refusals are the easy
 * half: a wiring that does nothing refuses beautifully. The two ways this
 * feature ships INERT both pass a refusal-only suite —
 *
 *   · `curveTrade.prepareBuy(chain, …)` handed core's `chain` (the config
 *     record from `chainOf`) instead of `providerFor(chainKey)`. It does not
 *     throw. It answers "could not read the chain head
 *     (chain.getBlockNumber is not a function)" and the buy falls back to the
 *     old dead-end sentence, with no error anywhere;
 *   · `sane()` handed an `expectedTokens` that is null for exactly the tokens
 *     this exists to trade, so every buy refuses at the last gate after paying
 *     a dozen RPC reads.
 *
 * Both look like a careful bot from Telegram. This repo treats an inert feature
 * as costing what a wrong fill costs, because they are indistinguishable to the
 * person pressing Buy — so the assertion that matters is that a transaction was
 * SIGNED, that it carried OUR calldata, and that the position was booked.
 *
 * It runs `SKIP_DOTENV=1` like the rest of the suite; every knob is set before
 * core is required, because core reads env at module-eval time.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { ethers } = require('ethers');

const TOKEN = '0x3f8c5ac4c9b9391c99f4796e56228852a6796ddf';
const CURVE = '0xc0000000000000000000000000000000000000c0';
const E17 = 10n ** 17n;
const E18 = 10n ** 18n;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SENT_HASH = '0x' + 'ab'.repeat(32);

const w64 = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const num = (n) => w64(BigInt(n).toString(16));
const addrWord = (a) => w64(String(a).slice(2));
const topic = (a) => '0x' + addrWord(a);

process.env.SKIP_DOTENV = '1';
process.env.WALLET_SECRET = 'c'.repeat(48);
process.env.DATA_DIR = path.join(os.tmpdir(), 'dexvra-curvebuy-' + process.pid);
process.env.TRADEBOT_TOKEN = 'x';
process.env.ENABLED_CHAINS = 'base';
process.env.BOT_FEE_BPS = '0';          // so `spend` is exactly what was asked for
process.env.BASE_RPC = 'http://127.0.0.1:1';
const core = require('./core');

// ── the wallet the engine will sign with ──────────────────────────────────
const CHAT = 991001;
let WALLET;
test.before(async () => {
  await core.ensureUser(CHAT);
  WALLET = core.getUser(CHAT).wallets[0].address;
});

/*
 * A chain that has: no V2 pair, no V3 pool, no v4 pool — and two real buys
 * through a curve. The ONLY market this token has is its launchpad curve, which
 * is the whole case under test.
 *
 * The observed buy is `0xaabbccdd(token, recipient, minTokensOut)`:
 *   0.1 native → 1000 tokens        (ratio 10,000 tokens per native)
 *   0.2 native → 2000 tokens
 */
function stubChain(over = {}) {
  const logs = [
    { transactionHash: '0xb1', blockNumber: 10, topics: [TRANSFER, topic(CURVE), topic(WALLET)], data: '0x' + num(1000n * E18) },
    { transactionHash: '0xb2', blockNumber: 11, topics: [TRANSFER, topic(CURVE), topic(WALLET)], data: '0x' + num(2000n * E18) },
  ];
  const txs = {
    '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + addrWord(TOKEN) + addrWord(WALLET) + num(1000n * E18) },
    '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + addrWord(TOKEN) + addrWord(WALLET) + num(2000n * E18) },
  };
  const state = { balanceOf: 0n, calls: [], sent: [] };
  const answer = (tx) => {
    const sel = String(tx.data || '').slice(0, 10);
    state.calls.push(sel);
    if (sel === '0x70a08231') return '0x' + num(state.balanceOf);          // balanceOf
    if (sel === '0x313ce567') return '0x' + num(18n);                       // decimals
    if (sel === '0x18160ddd') return '0x' + num(1_000_000_000n * E18);      // totalSupply
    if (sel === '0xe6a43905') return '0x' + addrWord(ethers.ZeroAddress);   // getPair → none
    if (String(tx.to).toLowerCase() === CURVE.toLowerCase()) return '0x' + num(1000n * E18);  // the curve executes
    throw new Error('no data');                                            // name/symbol etc.
  };
  return {
    state,
    async getBlockNumber() { return 5000; },
    async getLogs(f) { return String(f && f.address).toLowerCase() === TOKEN.toLowerCase() ? logs : []; },
    async getTransaction(h) { return txs[h] || null; },
    async call(tx) { return answer(tx); },
    async estimateGas() { return 210000n; },
    async getBalance() { return 5n * E18; },
    async getFeeData() { return { gasPrice: ethers.parseUnits('0.02', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null }; },
    async getTransactionCount() { return 3; },
    async waitForTransaction() { return { status: 1, hash: SENT_HASH }; },
    // gasOverrides reads the head block's baseFeePerGas on a 1559 chain.
    async getBlock() { return { number: 5000, baseFeePerGas: ethers.parseUnits('0.01', 'gwei') }; },
    async broadcastTransaction() { return { hash: SENT_HASH }; },
    getNetwork: async () => ({ chainId: 8453n }),
    _detectNetwork: async () => ({ chainId: 8453n }),
    resolveName: (n) => n,
    ...over,
  };
}

/** Install every seam core.buy reaches outside the chain, and restore after. */
function withStubs(chain, { padPrice = 0.2, padOk = true } = {}) {
  const realProv = core._deps.providerFor;
  const realFetch = global.fetch;
  const lp = require('./launchpads');
  const realRec = lp.record;
  const realPool = core.v4.bestPool;

  core._deps.providerFor = () => chain;
  core.v4.bestPool = async () => null;                       // no v4 pool either
  lp.record = async () => (padOk
    ? { record: { priceUsd: padPrice, launchpad: 'Pons' }, ok: true, why: null, tried: [] }
    : { record: null, ok: false, why: 'pons: ENOTFOUND', tried: [] });
  global.fetch = async (url, init) => {
    if (String(url).includes('coinbase')) return { ok: true, async json() { return { data: { amount: '2000' } }; } };
    // ⚠️ ONLY a broadcast counts. `marketOf` asks DexScreener and GeckoTerminal
    // over this same stub, and counting those as sends made the assertion
    // "nothing was broadcast" fail on a refusal that broadcast nothing — a test
    // measuring its own fake, which this repo has paid for twice.
    let body = null; try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
    if (body && body.method === 'eth_sendRawTransaction') chain.state.sent.push(body.params[0]);
    return { ok: true, async json() { return { jsonrpc: '2.0', id: 1, result: SENT_HASH }; } };
  };
  core._clearReadCaches();
  return () => {
    core._deps.providerFor = realProv;
    core.v4.bestPool = realPool;
    lp.record = realRec;
    global.fetch = realFetch;
    core._clearReadCaches();
  };
}

test('⚠️ a token whose ONLY market is a launchpad curve is BOUGHT — not politely refused', async () => {
  const chain = stubChain();
  const restore = withStubs(chain);
  try {
    // The curve pays out on the way back, so the post-buy balance read shows
    // the tokens that arrived.
    const realCall = chain.call.bind(chain);
    let bought = false;
    chain.call = async (tx) => {
      if (String(tx.data || '').startsWith('0x70a08231') && bought) return '0x' + num(1000n * E18);
      return realCall(tx);
    };
    const origWait = chain.waitForTransaction.bind(chain);
    chain.waitForTransaction = async (...a) => { bought = true; return origWait(...a); };

    const r = await core.buy(CHAT, TOKEN, 0.1, 'base');
    assert.equal(r.venue, 'curve·obs', 'the buy filled through the discovered curve');
    assert.equal(r.hash, SENT_HASH);
    assert.ok(r.gotTokens > 0, 'and tokens actually arrived');
    // ⚠️ THE RECEIPT SAYS WHICH PRICE CHECKED IT. A gate nobody can read is the
    // same as no gate — and a strong check and a weak one are different
    // assurances the user is owed the difference between.
    assert.ok(r.curveVia, 'the receipt carries what checked this trade');
    assert.match(r.curveVia.source, /Pons price/);
    assert.equal(r.curveVia.weak, false);
    assert.equal(r.curveVia.bound, true, 'an independent price is also the on-chain floor');
    assert.equal(String(r.curveVia.curve).toLowerCase(), CURVE);
  } finally { restore(); }
});

test('the signed calldata carries OUR wallet and OUR bound, never the stranger\'s', async () => {
  const chain = stubChain();
  const restore = withStubs(chain);
  const signed = [];
  try {
    const real = global.fetch;
    global.fetch = async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      if (body && body.method === 'eth_sendRawTransaction') {
        signed.push(ethers.Transaction.from(body.params[0]));
      }
      return real(url, init);
    };
    let bought = false;
    const realCall = chain.call.bind(chain);
    chain.call = async (tx) => (String(tx.data || '').startsWith('0x70a08231') && bought ? '0x' + num(1000n * E18) : realCall(tx));
    const origWait = chain.waitForTransaction.bind(chain);
    chain.waitForTransaction = async (...a) => { bought = true; return origWait(...a); };

    await core.buy(CHAT, TOKEN, 0.1, 'base');
    const tx = signed.find((t) => String(t.to).toLowerCase() === CURVE.toLowerCase());
    assert.ok(tx, 'a transaction was signed against the discovered curve');
    const body = tx.data.slice(10);
    assert.equal(body.slice(0, 64), addrWord(TOKEN), 'the token slot carries OUR token');
    assert.equal(body.slice(64, 128), addrWord(WALLET).toLowerCase(), 'the recipient slot carries OUR wallet, not the observed buyer');
    // 0.1 native at the pad's $0.20 with ETH at $2000 is 1000 tokens; the user's
    // default slippage is cut off that, and the number that lands must be OUR
    // floor rather than a stranger's minimum-out stretched to our size.
    const bound = BigInt('0x' + body.slice(128, 192));
    assert.ok(bound > 0n && bound < 1000n * E18, 'a real floor, below the expectation');
    assert.equal(tx.value, E17, 'the whole spend goes to the curve');
  } finally { restore(); }
});

test('⚠️ an unreachable launchpad does NOT make the feature inert — the fills do', async () => {
  // The pad host being unreachable is the operator's own reported state
  // ("✗ pons — can't reach api.pons.fun"). If that killed the trade, the route
  // would be inert on exactly the box it was built for. The rate recent fills
  // PAID is a different field from the argument the interface is read from, so
  // it is a real check — a weaker one, which is why it says so.
  const chain = stubChain();
  const restore = withStubs(chain, { padOk: false });
  try {
    let bought = false;
    const realCall = chain.call.bind(chain);
    chain.call = async (tx) => (String(tx.data || '').startsWith('0x70a08231') && bought ? '0x' + num(1000n * E18) : realCall(tx));
    const origWait = chain.waitForTransaction.bind(chain);
    chain.waitForTransaction = async (...a) => { bought = true; return origWait(...a); };

    const r = await core.buy(CHAT, TOKEN, 0.1, 'base');
    assert.equal(r.venue, 'curve·obs');
    assert.equal(r.curveVia.weak, true, 'and it SAYS the check was the weak one');
    assert.match(r.curveVia.source, /recent fills/);
    assert.equal(r.curveVia.bound, false, 'a weak price may check the interface but not become the on-chain floor');
  } finally { restore(); }
});

test('⚠️ with NO price at all, it refuses — and names which nothing', async () => {
  // The alternative is pricing a curve against itself. A missed trade is a
  // shrug; a wrong fill is not.
  const chain = stubChain();
  // Fills that paid nothing readable leave tier 3 with nothing either.
  for (const lg of await chain.getLogs({ address: TOKEN })) lg.data = '0x' + num(0n);
  const restore = withStubs(chain, { padOk: false });
  try {
    await assert.rejects(() => core.buy(CHAT, TOKEN, 0.1, 'base'), (e) => {
      assert.match(e.message, /launchpad curve/);
      assert.match(e.message, /could not be reached from this server/, "ours, not the token's");
      assert.match(e.message, /nothing was sent/);
      return true;
    });
    assert.equal(chain.state.sent.length, 0, 'nothing may be broadcast when the gate refuses');
  } finally { restore(); }
});

test('CURVE_ROUTE=0 puts the old dead end back, exactly', async () => {
  // A kill switch that half-works is worse than none: an operator turning this
  // off must get the behaviour they had before it shipped.
  const chain = stubChain();
  const restore = withStubs(chain);
  const real = process.env.CURVE_ROUTE;
  process.env.CURVE_ROUTE = '0';
  try {
    // The flag is read at module-eval time, so re-require in a clean registry.
    delete require.cache[require.resolve('./core')];
    delete require.cache[require.resolve('./curveTrade')];
    const c2 = require('./core');
    c2._deps.providerFor = () => chain;
    c2.v4.bestPool = async () => null;
    await c2.ensureUser(CHAT);
    await assert.rejects(() => c2.buy(CHAT, TOKEN, 0.1, 'base'), (e) => {
      // ⚠️ The OLD sentence, not a new one about a feature they switched off.
      assert.match(e.message, /can't route through yet|could not quote this buy/);
      assert.doesNotMatch(e.message, /CURVE_ROUTE/);
      return true;
    });
    assert.equal(chain.state.sent.length, 0);
  } finally {
    if (real === undefined) delete process.env.CURVE_ROUTE; else process.env.CURVE_ROUTE = real;
    delete require.cache[require.resolve('./core')];
    delete require.cache[require.resolve('./curveTrade')];
    require('./core');
    restore();
  }
});

test('⚠️ canTradeNow answers YES once the curve is known, or every snipe stays inert', async () => {
  // The dev snipe, the CA snipe, _fireLaunch's gate and the launch retry ring
  // all poll this predicate. Without a curve leg the user watches a manual buy
  // succeed while an armed snipe never fires — worse than before, because the
  // bot has told them in writing it would buy at graduation.
  const chain = stubChain();
  const restore = withStubs(chain);
  try {
    core.curveTrade._reset();
    // Cold: "we have not looked" is NOT "this token cannot be traded", and the
    // probe may not pay a dozen RPC reads on a timer.
    assert.equal(await core.canTradeNow(TOKEN, 'base'), false);
    await core.curveTrade.ifaceFor(chain, 'base', TOKEN);
    assert.equal(await core.canTradeNow(TOKEN, 'base'), true, 'a warm interface is a cheap yes');
  } finally { restore(); }
});

test('⚠️ the CARD offers a Buy button, or none of the above is reachable', async () => {
  // `core.buy` filling a curve changes nothing if the only surface a user can
  // press it from never offers the tap. The EVM branch of tokenSnapshot used to
  // `return null` for a token with no pool and no indexer — "❌ Couldn't price
  // it", no Buy button — about a token trading fine on its pad. telegram.js
  // gates the whole card on `routable`.
  const chain = stubChain();
  const restore = withStubs(chain, { padOk: false });   // the pad is unreachable, as on the box
  try {
    const snap = await core.tokenSnapshot(TOKEN, 'base');
    assert.ok(snap, 'a readable curve is not "no market"');
    assert.equal(snap.routable, true, 'and routable is MEASURED, not inferred from having a price');
    assert.ok(snap.priceEth > 0, 'priced from the token\'s own fills, with no third party at all');
    assert.equal(snap.onCurve, true);
    assert.equal(snap.liquidityUsd, null, 'a curve has no pool depth, and 0 on a card reads as a rug');
  } finally { restore(); }
});

test('…and a contract with no curve, no pool and no pad is still honestly nothing', async () => {
  const chain = stubChain({ async getLogs() { return []; } });
  const restore = withStubs(chain, { padOk: false });
  try {
    assert.equal(await core.tokenSnapshot(TOKEN, 'base'), null);
  } finally { restore(); }
});
