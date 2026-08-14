'use strict';
/*
 * Solana preflight — a READ-ONLY end-to-end check of every live integration the bot's
 * Solana support depends on, WITHOUT spending a lamport. Run this on the box that will
 * host the bot (same network egress) BEFORE adding `solana` to ENABLED_CHAINS.
 *
 *   cd tradebot && SOLANA_RPC=<your rpc> node scripts/solana-preflight.js
 *
 * It validates: RPC reachability, the deterministic key derivation (regression anchor),
 * a live Jupiter quote, DexScreener pricing, RugCheck safety, and the pump.fun new-coins
 * feed. Any ❌ means that feature won't work in production — fix it first. Exits non-zero
 * on any failure so it can gate a deploy.
 */
const path = require('path');
const solana = require(path.join(__dirname, '..', 'solana'));
const rugcheck = require(path.join(__dirname, '..', 'rugcheck'));
const upstreams = require(path.join(__dirname, '..', 'upstreams'));
const { Connection, Keypair } = require('@solana/web3.js');

const RPC = (process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com').trim();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';   // a known, always-liquid mint
const MN = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const MN_SOL = 'BLeUXTx9thHGT7VJUtF9vHEmfMDgW1nnKZ9UVer2CoLX';   // Phantom-path anchor (must never change)

const results = [];
async function check(name, fn) {
  try { const info = await fn(); results.push({ name, ok: true }); console.log('  ✅ ' + name + (info ? '  · ' + info : '')); }
  catch (e) { results.push({ name, ok: false }); console.log('  ❌ ' + name + '  · ' + ((e && e.message) || e)); }
}

(async () => {
  console.log('\nSolana preflight — RPC: ' + RPC + '\n');
  const conn = new Connection(RPC, 'confirmed');

  await check('RPC reachable (getVersion)', async () => { const v = await conn.getVersion(); return 'solana-core ' + (v['solana-core'] || '?'); });
  await check('RPC getSlot', async () => 'slot ' + (await conn.getSlot()));
  await check('Key derivation anchor (mnemonic → Phantom path)', async () => {
    const a = solana.deriveKeypair(MN).publicKey.toBase58();
    if (a !== MN_SOL) throw new Error('derivation changed! got ' + a + ' — funds would be stranded');
    return a;
  });
  // WHICH Jupiter host answers, named, before anything that depends on one. The
  // hosts move (quote-api.jup.ag/v6 → lite-api.jup.ag/swap/v1) and a withdrawn
  // one fails at the transport, not with a status — from Telegram that was
  // indistinguishable from the token having no route. This line is the
  // difference between "our server can't reach Jupiter" and "that token can't
  // be bought", which need completely different answers.
  await check('Jupiter reachable (which base answers)', async () => {
    await solana.getQuote({ inputMint: solana.WSOL_MINT, outputMint: USDC, amountRaw: 10000000n, slippageBps: 100 });
    return solana.jupBase() + (process.env.JUP_BASE ? '  (pinned by JUP_BASE)' : '  (auto, tried: ' + solana.JUP_BASES.join(', ') + ')');
  });
  // The upstream probes the RUNNING BOT uses, run here too — one list, two
  // callers. Two copies of "is Jupiter up" would eventually disagree, and this
  // repo has already paid for that once with two pump.fun hosts.
  for (const p of upstreams.PROBES) {
    await check(p.label + ' [watchdog]', async () => {
      const r = await p.run();
      if (!r.ok) throw new Error(r.detail);
      return r.detail;
    });
  }
  await check('Jupiter quote (0.01 SOL → USDC)', async () => {
    const q = await solana.getQuote({ inputMint: solana.WSOL_MINT, outputMint: USDC, amountRaw: 10000000n, slippageBps: 100 });
    return 'out ' + q.outAmount + ' USDC-units · impact ' + q.priceImpactPct + '%';
  });
  await check('Jupiter swap-build (does not send)', async () => {
    // A FRESH random address, never MN_SOL.
    //
    // MN is the standard BIP39 test-vector mnemonic — one of the most widely
    // used keys in existence — so its accounts carry whatever strangers have
    // done to them. On a real run Jupiter refused with "Token account Hpjz… is
    // owned by usdc8UkQ… instead of the user": someone had created a token
    // account at its USDC ATA under a different owner. That is a fact about a
    // public test address, not about this box, and it failed a check the
    // operator is told to fix before trading.
    //
    // A brand-new keypair has no on-chain state at all, so Jupiter builds the
    // create-ATA-and-swap transaction it would build for a real user's first
    // buy — which is the thing this check is actually for. It is never signed
    // and never sent. MN_SOL keeps its own job as the derivation anchor above.
    const probe = Keypair.generate().publicKey.toBase58();
    const q = await solana.getQuote({ inputMint: solana.WSOL_MINT, outputMint: USDC, amountRaw: 10000000n, slippageBps: 100 });
    const tx = await solana.getSwapTx(q.raw, probe, {});
    return 'tx ' + Math.round(Buffer.from(tx, 'base64').length) + ' bytes  · for a fresh address';
  });
  await check('DexScreener pricing (USDC)', async () => {
    const d = await solana.dexScreener(USDC); if (!d) throw new Error('no market data');
    return '$' + d.priceUsd + ' · liq $' + Math.round(d.liquidityUsd);
  });
  await check('RugCheck safety (USDC report)', async () => {
    const s = await rugcheck.tokenSecurity('solana', USDC); if (!s) throw new Error('no report');
    return 'score ' + (s.scoreNorm != null ? s.scoreNorm + '/100' : '?') + ' · freeze ' + (s.freezeAuthorityEnabled ? 'ON' : 'off');
  });
  await check('pump.fun new-coins feed', async () => {
    // Names the host and the REASON. "feed empty/unreachable" could not tell a
    // dead host from a quiet minute, which is the whole reason snipe discovery
    // could be blind for days behind a green tick.
    const r = await solana.pumpfunNewX(5);
    if (!r.ok) throw new Error(`${r.why}  (tried: ${solana.PUMPFUN_BASES.join(', ')})`);
    const c = r.coins;
    if (!c.length) throw new Error('feed answered but returned nothing — check the response shape, not the network');
    console.log('     via ' + solana.pumpBase());
    return c.length + ' recent launches';
  });

  const fail = results.filter((r) => !r.ok).length;
  console.log('\n' + (fail ? '❌ ' + fail + ' check(s) FAILED — fix these before enabling Solana with real funds.' : '✅ All Solana preflight checks passed — the live integration paths work.') + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('preflight crashed:', (e && e.stack) || e); process.exit(1); });
