// A DEXSCREENER URL CARRIES THE POOL, NOT THE TOKEN — in the trade bot.
//
// Reported 2026-10-30 with https://dexscreener.com/bsc/0x20da3ebe08379117fdb7f15ff55456813b546554:
// DexScreener had the token and the bot "could not read the CA". A pasted link
// fell to "I didn't recognise that", and the bare pair address was carded as the
// pool itself (a v2 pool IS an ERC-20 — its LP token). core.resolvePaste turns
// both into the token the pool trades; these tests pin the rule and DRIVE the
// paste, /buy and auto-buy through onMessage.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dexvra-dexpaste-'));
process.env.SKIP_DOTENV = '1';
process.env.ENABLED_CHAINS = 'ethereum,base,bsc,solana';
process.env.WALLET_SECRET = process.env.WALLET_SECRET || '0123456789abcdef0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert');

const core = require('./core');
const tokeninfo = require('./tokeninfo');
let tg = null;
try { tg = require('./telegram'); } catch { /* deps not installed */ }

const PAIR = '0x20da3ebe08379117fdb7f15ff55456813b546554'; // the address in the report's URL
const TOKEN = '0x9aB1c2D3e4F5a6B7c8D9e0F1a2B3c4D5e6F7a8B9';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const LINK = `https://dexscreener.com/bsc/${PAIR}`;
const pairRecord = {
  chainId: 'bsc', dexId: 'pancakeswap', pairAddress: PAIR,
  baseToken: { address: TOKEN, name: 'Real Project', symbol: 'REAL' },
  quoteToken: { address: WBNB, name: 'Wrapped BNB', symbol: 'WBNB' },
  priceUsd: '0.0123', liquidity: { usd: 54321 },
};

const realFetch = global.fetch;
let opts = {};
let sent = [];
let dsCalls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Telegram captured; DexScreener as the box sees it. `opts.tokensFor` maps an
 *  address to the token endpoint's pairs; `opts.dsDown` fails every DS call. */
function stub(o = {}) {
  opts = o;
  sent = [];
  dsCalls = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) {
      try { const b = JSON.parse(init.body); if (b.text) sent.push(String(b.text)); } catch (_) {}
      return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length + 1 } }) };
    }
    if (u.includes('dexscreener')) {
      dsCalls.push(u);
      if (opts.dsDown) return json({ error: 'down' }, 503);
      const tok = /\/latest\/dex\/tokens\/([^/?]+)/.exec(u);
      if (tok) return json({ pairs: (opts.tokensFor || {})[tok[1].toLowerCase()] || [] });
      if (u.includes(`/latest/dex/pairs/bsc/${PAIR}`)) return json({ pairs: [pairRecord] });
      return json({ pairs: null });
    }
    return json({}, 404);
  };
}
test.beforeEach(() => core._clearReadCaches());
test.afterEach(() => { global.fetch = realFetch; core._clearReadCaches(); });

// ── the rule ─────────────────────────────────────────────────────────────────

test('the reported LINK resolves to the TOKEN on BNB Chain, and says it was a pair', async () => {
  stub();
  const r = await core.resolvePaste(LINK);
  assert.strictEqual(r.via, 'pair');
  assert.strictEqual(r.ca, TOKEN);
  assert.strictEqual(r.chain, 'bsc');
  assert.strictEqual(dsCalls.length, 1, 'the link names its chain — one request');
});

test('the bare PAIR address resolves too, once the token endpoint has said it is no token', async () => {
  stub({ tokensFor: {} });
  const r = await core.resolvePaste(PAIR.replace('0x20da3ebe', '0x20DA3EBE')); // checksum-ish casing from an explorer
  assert.strictEqual(r.via, 'pair');
  assert.strictEqual(r.ca, TOKEN);
});

test('a token DexScreener KNOWS is left exactly as pasted — and the pair endpoint is never asked', async () => {
  stub({ tokensFor: { [TOKEN.toLowerCase()]: [pairRecord] } });
  assert.strictEqual(await core.resolvePaste(TOKEN), null);
  assert.ok(!dsCalls.some((u) => u.includes('/latest/dex/pairs/')), 'a token pays nothing new');
});

test('⚠️ a bare address FAILS OPEN when DexScreener cannot be asked', async () => {
  stub({ dsDown: true });
  assert.strictEqual(await core.resolvePaste('0x1111111111111111111111111111111111111111'), null);
});

test('⚠️ a LINK DexScreener cannot be asked about is refused, never guessed at', async () => {
  stub({ dsDown: true });
  const r = await core.resolvePaste(`https://dexscreener.com/ethereum/${'0x2222222222222222222222222222222222222222'}`);
  assert.ok(r && r.refused, 'a link is almost always a pair — guessing it is a token would card the pool');
});

test('a link on a network this bot does not trade is refused, naming it', async () => {
  stub();
  const r = await core.resolvePaste(`https://dexscreener.com/polygon/${PAIR}`);
  assert.match(r.refused, /polygon/);
  assert.strictEqual(dsCalls.length, 0);
});

test('chatter and commands cost nothing', async () => {
  stub();
  assert.strictEqual(await core.resolvePaste('gm'), null);
  assert.strictEqual(await core.resolvePaste('/menu'), null);
  assert.strictEqual(dsCalls.length, 0);
});

// ── driven through onMessage ────────────────────────────────────────────────

const CHAT = '880001';
/** tokenCard's own reads, stubbed so the card renders instantly; `carded`
 *  records which address the card was built for — the fact under test. */
function stubCard() {
  const real = { enrich: tokeninfo.enrich, meta: core.tokenMeta, across: core.tokenAcrossWallets, buy: core.buy, probe: core.marketProbe };
  const carded = [];
  const bought = [];
  tokeninfo.enrich = async (ca) => (carded.push(ca), null);
  core.tokenMeta = async () => null;
  core.tokenAcrossWallets = async () => null;
  core.marketProbe = async () => ({ chains: [], checked: [], source: 'none', degraded: false });
  core.buy = async (...a) => { bought.push(a[1]); throw new Error('not in this test'); };
  return {
    carded, bought,
    undo: () => { tokeninfo.enrich = real.enrich; core.tokenMeta = real.meta; core.tokenAcrossWallets = real.across; core.buy = real.buy; core.marketProbe = real.probe; },
  };
}
const msg = (text) => ({ message_id: 1, chat: { id: CHAT, type: 'private' }, from: { id: CHAT }, text });

test('DRIVEN: pasting the reported link opens the TOKEN card, with the substitution said out loud', { skip: !tg }, async () => {
  core.ensureUser(CHAT);
  stub();
  const s = stubCard();
  try {
    await tg._test.onMessage(msg(LINK));
    assert.deepStrictEqual(s.carded, [TOKEN], `carded ${s.carded.join(', ')}`);
    assert.ok(sent.some((t) => /DexScreener pair/.test(t) && /REAL\/WBNB/.test(t)), sent.join(' | '));
    assert.ok(!sent.some((t) => /didn't recognise/.test(t)), 'a link is no longer unrecognised');
  } finally { s.undo(); }
});

test('⚠️ DRIVEN: auto-buy does NOT buy a token resolved from a pair — the card is the confirmation', { skip: !tg }, async () => {
  core.ensureUser(CHAT);
  core.setAutoBuy(CHAT, true, '0.01');
  stub({ tokensFor: {} });
  const s = stubCard();
  try {
    await tg._test.onMessage(msg(PAIR));
    assert.deepStrictEqual(s.bought, [], 'nothing may spend on an address DexScreener handed us');
    assert.deepStrictEqual(s.carded, [TOKEN]);
    assert.ok(sent.some((t) => /Not bought automatically/.test(t)), sent.join(' | '));
  } finally { s.undo(); core.setAutoBuy(CHAT, false); }
});

test('⚠️ DRIVEN: /buy with a pair address opens the card instead of buying', { skip: !tg }, async () => {
  core.ensureUser(CHAT);
  stub({ tokensFor: {} });
  const s = stubCard();
  try {
    await tg._test.onMessage(msg(`/buy ${PAIR} 0.05`));
    assert.deepStrictEqual(s.bought, []);
    assert.deepStrictEqual(s.carded, [TOKEN]);
  } finally { s.undo(); }
});

test('DRIVEN: a plain token paste is untouched — no note, carded as typed', { skip: !tg }, async () => {
  core.ensureUser(CHAT);
  stub({ tokensFor: { [TOKEN.toLowerCase()]: [pairRecord] } });
  const s = stubCard();
  try {
    await tg._test.onMessage(msg(TOKEN));
    assert.deepStrictEqual(s.carded, [TOKEN]);
    assert.ok(!sent.some((t) => /DexScreener pair/.test(t)));
  } finally { s.undo(); }
});

// ── the doors the audit found still open (2026-10-31) ───────────────────────
// "bagaimana agar masalah ini tidak terjadi lgi": /pnl and both ways of arming
// a CA snipe still read a pasted link as unrecognised and a pair as the token.

test('DRIVEN: /pnl with the reported link answers for the TOKEN on BNB Chain, not the pool', { skip: !tg }, async () => {
  core.ensureUser(CHAT);
  stub();
  const asked = [];
  const real = core.tokenPnl;
  core.tokenPnl = async (_c, ca, chain) => (asked.push([ca, chain]), null);
  try {
    await tg._test.onMessage(msg(`/pnl ${LINK}`));
    assert.deepStrictEqual(asked, [[TOKEN, 'bsc']], `asked ${JSON.stringify(asked)}`);
    assert.ok(sent.some((t) => /DexScreener pair/.test(t)), 'the substitution was not said');
  } finally { core.tokenPnl = real; }
});

test('DRIVEN: the 🎛 panel Target step turns a pasted link into the TOKEN, on the pair\'s own chain', { skip: !tg }, async () => {
  core.ensureUser(CHAT);
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'ethereum', kind: 'ca' });
  stub();
  await tg._test.resolvePending(CHAT, { action: 'snw_ca' }, `${LINK} 0.05`, {});
  const d = core.snipeDraft(core.getUser(CHAT));
  assert.strictEqual(d.ca, TOKEN, 'the snipe watches the POOL');
  assert.strictEqual(d.chain, 'bsc', 'two EVM chains share one shape — the pair\'s chain must win over the row\'s');
  assert.ok(sent.some((t) => /DexScreener pair/.test(t)), sent.join(' | '));
});

test('⚠️ DRIVEN: a one-line CA snipe on a PAIR address does not arm — it lands on the panel for ⚡ ARM', { skip: !tg }, async () => {
  const u = core.ensureUser(CHAT);
  const before = (u.snipeTargets || []).length;
  // A FRESH draft: the panel test above leaves one behind with an amount, and an
  // inherited amount would pass the "the line's amount reached the panel" check
  // for a reason that has nothing to do with this door (a mutation run said so).
  core.clearSnipeDraft(CHAT);
  stub({ tokensFor: {} });
  await tg._test.resolvePending(CHAT, { action: 'ca_snipe', chain: 'ethereum' }, `${PAIR} 0.07`, {});
  assert.strictEqual((core.getUser(CHAT).snipeTargets || []).length, before, 'a spend was armed on an address DexScreener handed us');
  const d = core.snipeDraft(core.getUser(CHAT));
  assert.strictEqual(d.ca, TOKEN);
  assert.strictEqual(d.chain, 'bsc');
  assert.strictEqual(Number(d.amount), 0.07, 'the line\'s amount was dropped on the way to the panel');
  assert.ok(sent.some((t) => /Not armed yet/.test(t)), sent.join(' | '));
});

test('DRIVEN: a one-line CA snipe on a plain token still arms straight away', { skip: !tg }, async () => {
  const u = core.ensureUser(CHAT);
  const before = (u.snipeTargets || []).length;
  stub({ tokensFor: { [TOKEN.toLowerCase()]: [pairRecord] } });
  await tg._test.resolvePending(CHAT, { action: 'ca_snipe', chain: 'bsc' }, `${TOKEN} 0.05`, {});
  const after = core.getUser(CHAT).snipeTargets || [];
  assert.strictEqual(after.length, before + 1, sent.join(' | '));
  assert.strictEqual(after[after.length - 1].ca, TOKEN);
});

test('a pair resolved to its token is a [ca] line in pm2 — found with grep, not a screenshot', async () => {
  stub();
  const real = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { await core.resolvePaste(LINK); } finally { console.log = real; }
  assert.ok(lines.some((l) => l.startsWith('[ca]') && /DexScreener pair on bsc/.test(l) && /\$REAL/.test(l)), lines.join(' | '));
});

test('a plain token paste writes no [ca] line', async () => {
  stub({ tokensFor: { [TOKEN.toLowerCase()]: [pairRecord] } });
  const real = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { await core.resolvePaste(TOKEN); } finally { console.log = real; }
  assert.deepStrictEqual(lines.filter((l) => l.startsWith('[ca]')), []);
});
