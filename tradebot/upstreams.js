'use strict';
/*
 * upstreams.js — is every third party this bot depends on actually answering?
 *
 * WHY THIS EXISTS
 *
 * Over two days this bot broke three times in the same shape, and every time the
 * first person to find out was a user losing money:
 *
 *   • Jupiter retired quote-api.jup.ag/v6. Every Solana buy died with the words
 *     "fetch failed", five wallets at a time, under a green ✅ receipt.
 *   • pump.fun moved to frontend-api-v3. Solana snipe discovery went blind and
 *     /health kept printing 🟢, because an empty feed and a dead feed were the
 *     same empty array.
 *   • The swap-build call broke on its own, separately from the quote call, on
 *     a base that was answering fine.
 *
 * Each was found by a human typing `npm run preflight:solana` after a complaint.
 * The check existed, worked, and named the problem in one line — it just only
 * ran when somebody already suspected something. That is not monitoring; it is
 * a flashlight you have to remember to pick up.
 *
 * So the probes live HERE, and both the preflight script and the running bot use
 * this one list. Two copies of "is Jupiter up" would eventually disagree, which
 * is the same defect as the two pump.fun hosts this repo was carrying.
 *
 * DESIGN RULES, each one a way this could go wrong:
 *
 *   • Every probe is timeout-bounded and NEVER throws. A monitor that can crash
 *     the process it monitors is worse than no monitor.
 *   • A probe reports { ok, detail } — and `detail` is filled on success too, so
 *     the log says WHICH host answered, not merely that one did.
 *   • Probes are read-only and cost nothing: a quote is not a trade, and the
 *     swap-build probe uses a freshly generated address that is never signed for.
 *   • `critical` marks the ones that stop a user trading. A dead pump.fun feed
 *     costs discovery; a dead Jupiter costs every buy on the chain.
 */
const { Keypair } = require('@solana/web3.js');
const solana = require('./solana');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';   // always-liquid, so a failure is never "no route"
const PROBE_LAMPORTS = 10000000n;                                // 0.01 SOL — priced, never sent

/** Wrap a probe so it always resolves, and always within `ms`. */
function guard(ms, fn) {
  return async () => {
    let timer = null;
    try {
      const out = await Promise.race([
        fn(),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms); }),
      ]);
      return { ok: true, detail: out || '' };
    } catch (e) {
      return { ok: false, detail: String((e && e.message) || e).slice(0, 220) };
    } finally { if (timer) clearTimeout(timer); }
  };
}

const PROBES = [
  {
    key: 'jupiter.quote',
    label: 'Jupiter quote',
    critical: true,
    // What the user loses when this is down, in their words — so an alert says
    // what is broken FOR THEM and not only which host is unreachable.
    costs: 'no Solana buy or sell can be priced',
    run: guard(15000, async () => {
      const q = await solana.getQuote({ inputMint: solana.WSOL_MINT, outputMint: USDC, amountRaw: PROBE_LAMPORTS, slippageBps: 100 });
      if (!(q.outAmount > 0n)) throw new Error('quote returned no output');
      return `via ${solana.jupBase() || '?'}`;
    }),
  },
  {
    key: 'jupiter.swap',
    label: 'Jupiter swap-build',
    critical: true,
    costs: 'quotes work but no Solana trade can be built — buys fail after the user taps',
    // Its own probe, deliberately. These are two different endpoints on one host
    // and they have already failed independently: /quote answered while /swap
    // returned 500. Probing only the cheap one would have reported healthy
    // through the exact outage this file was written for.
    run: guard(20000, async () => {
      const q = await solana.getQuote({ inputMint: solana.WSOL_MINT, outputMint: USDC, amountRaw: PROBE_LAMPORTS, slippageBps: 100 });
      // A FRESH address every time. A reused one accumulates on-chain state that
      // strangers can shape — the shared BIP39 test key had a token account
      // created under a foreign owner, and Jupiter rightly refused to build for
      // it, which read as an outage that was never ours.
      const tx = await solana.getSwapTx(q.raw, Keypair.generate().publicKey.toBase58(), {});
      const n = Buffer.from(tx, 'base64').length;
      if (!(n > 100)) throw new Error('swap transaction too small to be real');
      return `tx ${n} bytes`;
    }),
  },
  {
    key: 'pumpfun.feed',
    label: 'pump.fun new-coins feed',
    critical: false,
    costs: 'Solana snipe discovery is blind — no new launch is seen',
    run: guard(15000, async () => {
      const r = await solana.pumpfunNewX(5);
      if (!r.ok) throw new Error(r.why || 'feed unreachable');
      if (!r.coins.length) throw new Error('feed answered but returned nothing — check the response shape, not the network');
      return `${r.coins.length} launches via ${solana.pumpBase() || '?'}`;
    }),
  },
  {
    key: 'dexscreener',
    label: 'DexScreener pricing',
    critical: false,
    costs: 'Solana token cards lose their price, market cap and liquidity',
    run: guard(15000, async () => {
      const d = await solana.dexScreener(USDC);
      if (!d || !(d.priceUsd > 0)) throw new Error('no market data for a mint that always has one');
      return `$${d.priceUsd}`;
    }),
  },
];

/** Run every probe concurrently. Always resolves; never throws. */
async function checkAll() {
  const out = await Promise.all(PROBES.map(async (p) => {
    const r = await p.run();
    return { key: p.key, label: p.label, critical: p.critical, costs: p.costs, ok: r.ok, detail: r.detail };
  }));
  return { at: Date.now(), results: out, ok: out.every((r) => r.ok), criticalOk: out.every((r) => r.ok || !r.critical) };
}

module.exports = { PROBES, checkAll, USDC };
