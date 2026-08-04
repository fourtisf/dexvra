'use strict';
/*
 * What the live-position card has to tell you about the token itself.
 *
 * The card that shipped named a position and never once said WHICH token. No
 * contract address, no links, no chart. The only way to check what you were
 * holding, or to send it to someone, was to leave the card and go hunting — on
 * the one screen a holder keeps pinned.
 *
 * It also printed this, which is three characters disagreeing about one number:
 *
 *     🔴 Profit/Loss: -0.76% (-0.00002 ETH, $-0.05)
 *
 * These tests are about what the card COMMUNICATES. Wording and emoji can move.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'moncard-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'robinhood';

const core = require('./core');
const tg = require('./telegram');
const tokeninfo = require('./tokeninfo');

const CA = '0x1234567890abcdef1234567890abcdef12345678';
const CHAIN = 'robinhood';
const CHAT = 7;

function seed() {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [2, 3, 4].map((i) => ({ id: 'w' + i, name: 'Wallet ' + i, address: '0x' + String(i).repeat(40), positions: {}, orders: [], history: [] }));
  u.activeWalletId = 'w4';
  for (const w of u.wallets) {
    w.positions[core.posKey(CHAIN, CA)] = { chain: CHAIN, ca: CA, sym: 'PONS', dec: 18,
      ethIn: 0.00107, ethOut: 0, costEth: 0.00107, tokens: '75030000000000000000' };
  }
  return u;
}

/** Render the card. `links` is what the socials lookup returns. */
async function card({ links = null, priceEth = 0.00001417 } = {}) {
  const u = seed();
  const realAcross = core.tokenBalancesAcross, realSnap = core.tokenSnapshot, realSoc = tokeninfo.socials;
  core.tokenBalancesAcross = async () => u.wallets.map((w, i) => ({ id: w.id, index: i + 1, label: w.name, raw: 75030000000000000000n }));
  core.tokenSnapshot = async () => ({ sym: 'PONS', priceEth, mcapUsd: 26470000 });
  tokeninfo.socials = async () => links;
  tg._test.PRICES.ETH = 1870;
  try { return await tg._test.monitorPayload(CHAT, CA, CHAIN, 'w4'); }
  finally { core.tokenBalancesAcross = realAcross; core.tokenSnapshot = realSnap; tokeninfo.socials = realSoc; }
}
const plain = (p) => p.text.replace(/<[^>]+>/g, '');
const buttons = (p) => p.kb.inline_keyboard.flat();

// ---------------------------------------------------------------- identity
test('the card says which token this is, in full, and copyably', async () => {
  const p = await card();
  assert.ok(p.text.includes(`<code>${CA}</code>`),
    'the contract must sit in its own <code> block — that is what makes Telegram copy it on one tap');
  assert.ok(!plain(p).includes(CA.slice(0, 6) + '…'), 'a truncated contract cannot be copied or pasted');
});

test('a token with socials shows them; a token without says nothing about it', async () => {
  const withLinks = await card({ links: { website: 'https://pons.fun', twitter: 'https://x.com/pons', telegram: 'https://t.me/pons' } });
  assert.match(withLinks.text, /href="https:\/\/pons\.fun"/);
  assert.match(withLinks.text, /href="https:\/\/x\.com\/pons"/);
  assert.match(withLinks.text, /href="https:\/\/t\.me\/pons"/);

  // No links is the normal case for a fresh launch. An empty "Links:" heading
  // would read as the card failing rather than the token being new.
  const without = await card({ links: null });
  assert.ok(!/Links:/.test(plain(without)), 'an empty links section was rendered');
  assert.ok(without.text.includes(`<code>${CA}</code>`), 'the contract must still be there');
});

test('a partial set of socials renders only what exists', async () => {
  const p = await card({ links: { website: '', twitter: 'https://x.com/pons', telegram: '' } });
  assert.match(p.text, /href="https:\/\/x\.com\/pons"/);
  assert.ok(!/href=""/.test(p.text), 'an empty href was emitted for a missing link');
});

// ---------------------------------------------------------------- links out
test('the chart and the explorer are one tap from the position', async () => {
  const b = buttons(await card());
  const urls = b.filter((x) => x.url).map((x) => x.url);
  assert.ok(urls.some((u) => /dexscreener\.com/.test(u)), 'no DexScreener link on the live card');
  assert.ok(urls.some((u) => u.includes(CA)), 'a link that does not carry the contract is not about this token');
  assert.ok(b.some((x) => /Explorer/i.test(x.text) && x.url), 'no explorer link');
});

test('the sell buttons are still there, and still act on the bound wallet', async () => {
  // The new rows must not have displaced what the card is for.
  const b = buttons(await card());
  for (const pct of [25, 50, 75, 100]) {
    assert.ok(b.some((x) => x.callback_data === `s:${CHAIN}:3:${CA}:${pct}`), `Sell ${pct}% is gone or unbound`);
  }
});

// ---------------------------------------------------------------- the number
test('one minus sign per number, and it goes in front of the currency', async () => {
  // "$-0.05" is not a way to write minus five cents.
  const t = plain(await card({ priceEth: 0.00001 }));
  const pl = t.split('\n').find((l) => l.includes('Profit/Loss'));
  assert.ok(pl, 'setup');
  assert.ok(!/\$-/.test(pl), `the sign landed after the dollar sign: ${pl}`);
  assert.ok(!/[^\w]-\d/.test(pl), `an ASCII hyphen is mixed with − on: ${pl}`);
  assert.match(pl, /−.*ETH/, 'the native loss must be signed');
});

test('the per-wallet rows use the same minus sign as the total', async () => {
  // They disagreed inside one card: "−0.64%" up top, "-0.64%" in the rows.
  const t = plain(await card({ priceEth: 0.00001 }));
  for (const line of t.split('\n')) {
    if (!/^•/.test(line)) continue;
    assert.ok(!/[^\w]-\d/.test(line), `a wallet row uses an ASCII hyphen: ${line}`);
  }
});

test('a token in profit still reads as profit', async () => {
  const t = plain(await card({ priceEth: 0.0001 }));
  const pl = t.split('\n').find((l) => l.includes('Profit/Loss'));
  assert.match(pl, /🟢/);
  assert.match(pl, /\+/);
  assert.ok(!/−/.test(pl), `a winning position printed a minus: ${pl}`);
});

// ---------------------------------------------------------------- safety
test('only http(s) links survive — the token deployer writes these strings', async () => {
  // Socials come from whoever deployed the token and land inside an href on a
  // card the user is invited to tap. A javascript: URL has no business there,
  // and a malformed one makes Telegram reject the whole message — taking the
  // monitor down over a field a stranger controls.
  const t = tokeninfo._test._pickSocials({
    websites: [{ url: 'javascript:alert(1)' }, { url: 'https://ok.example' }],
    socials: [{ type: 'twitter', url: 'data:text/html,<script>' }, { type: 'telegram', url: 'https://t.me/ok' }],
  });
  assert.equal(t.website, 'https://ok.example', 'a javascript: URL was accepted');
  assert.ok(!t.twitter, 'a data: URL was accepted');
  assert.equal(t.telegram, 'https://t.me/ok');
  assert.equal(tokeninfo._test._pickSocials({ websites: [{ url: 'not a url' }] }), null);
});

test('the socials lookup is cached — the monitor re-renders on a timer', async () => {
  // Uncached, this is a 6-second HTTP call paid on every refresh of every open
  // card. Links do not change often enough to be worth that.
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async () => { calls++; return { ok: true, json: async () => ({ pairs: [] }) }; };
  try {
    const ca = '0x' + 'be'.repeat(20);
    await tokeninfo.socials(ca, 'base');
    await tokeninfo.socials(ca, 'base');
    await tokeninfo.socials(ca, 'base');
  } finally { global.fetch = realFetch; }
  assert.equal(calls, 1, `the lookup went out ${calls} times for three renders of one token`);
});

// ---------------------------------------------------------------- per wallet
/** Render with a per-wallet cost basis. `costs[i]` of 0 means that wallet holds
 *  the token with NO recorded entry — airdropped, sent in, or bought elsewhere. */
async function multi({ costs = [0.00107, 0.00107, 0.00107], rate = 1870, priceEth = 0.00001417 } = {}) {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [2, 3, 4].map((i) => ({ id: 'w' + i, name: 'Wallet ' + i, address: '0x' + String(i).repeat(40), positions: {}, orders: [], history: [] }));
  u.activeWalletId = 'w4';
  u.wallets.forEach((w, i) => {
    if (costs[i] > 0) w.positions[core.posKey(CHAIN, CA)] = { chain: CHAIN, ca: CA, sym: 'PONS', dec: 18, ethIn: costs[i], ethOut: 0, costEth: costs[i], tokens: '75030000000000000000' };
  });
  const realAcross = core.tokenBalancesAcross, realSnap = core.tokenSnapshot, realSoc = tokeninfo.socials;
  core.tokenBalancesAcross = async () => u.wallets.map((w, i) => ({ id: w.id, index: i + 1, label: w.name, raw: 75030000000000000000n }));
  core.tokenSnapshot = async () => ({ sym: 'PONS', priceEth, mcapUsd: 26470000 });
  tokeninfo.socials = async () => null;
  tg._test.PRICES.ETH = rate;
  try { return plain(await tg._test.monitorPayload(CHAT, CA, CHAIN, 'w4')); }
  finally { core.tokenBalancesAcross = realAcross; core.tokenSnapshot = realSnap; tokeninfo.socials = realSoc; }
}
// A helper that finds nothing must FAIL, not hand back an empty list for a
// caller to loop over zero times and call it a pass. Every assertion below that
// iterates these rows was green on the version of the card that had no such rows
// at all — the same vacuous-pass that let two pump bugs ship.
const rows = (t) => {
  const r = t.split('\n').filter((l) => /^\s{2,}worth |^\s{2,}—/.test(l));
  assert.equal(r.length, 3, `expected one detail line per wallet, found ${r.length}:\n${t}`);
  return r;
};

test('every wallet row says what that wallet is worth in dollars', async () => {
  // The row gave a token count, a cost and a percentage, and never answered the
  // question the section exists for: what is THIS wallet worth right now. The
  // reader was left to multiply a token count by a price printed further up.
  const t = await multi();
  const r = rows(t);
  assert.equal(r.length, 3, 'expected one detail line per wallet');
  for (const line of r) assert.match(line, /worth \$\d/, `no dollar value on: ${line}`);
});

test('the native amount rides along with the dollar figure', async () => {
  const r = rows(await multi());
  for (const line of r) assert.match(line, /worth \$[\d.]+ \([\d.]+ ETH\)/, `native amount missing from: ${line}`);
});

test('no USD feed means native alone — never a confident $0.00', async () => {
  // PRICES.ETH is 0 until the first Coinbase call lands, and stays 0 while it
  // keeps failing. "$0.00" is a number, and a wrong one, on a bag worth money.
  const t = await multi({ rate: 0 });
  for (const line of rows(t)) {
    assert.ok(!/\$0\.00/.test(line), `a zero dollar value was printed on: ${line}`);
    assert.match(line, /worth [\d.]+ ETH/, `no native fallback on: ${line}`);
  }
});

test('an unreadable price says so instead of pricing the bag at nothing', async () => {
  const t = await multi({ priceEth: 0 });
  for (const line of rows(t)) {
    assert.match(line, /worth —/, `a bag with no price read as: ${line}`);
    assert.ok(!/\$0\.00/.test(line));
  }
});

// ------------------------------------------------- mixed cost bases
test('tokens with no entry price never invent a profit', async () => {
  // THE BUG THIS SURFACED. A wallet holding the token with no recorded entry
  // (airdrop, sent in, bought elsewhere) contributed its full VALUE to the top
  // line and nothing to the COST — so the card divided the value of three
  // wallets by the cost of two and printed "🟢 +49.04%" over a position that
  // was down 0.64%. Same arithmetic as the portfolio card's old "2.13× (+113%)".
  const t = await multi({ costs: [0, 0.00107, 0.00107] });
  const pl = t.split('\n').find((l) => l.includes('Profit/Loss'));
  assert.ok(pl, 'setup');
  assert.ok(/🔴/.test(pl) && /−/.test(pl), `a losing position reported a gain: ${pl}`);
  assert.ok(!/\+4\d\./.test(pl), `the blended-basis gain is back: ${pl}`);
});

test('the tokens left out of P/L are named, not silently dropped', async () => {
  // A number left out of a total has to be named, or the total reads as
  // covering everything.
  const t = await multi({ costs: [0, 0.00107, 0.00107] });
  assert.match(t, /no entry price on record/, 'the excluded tokens were never mentioned');
  assert.match(t, /left out of P\/L/);
});

test('what you HOLD and what it is WORTH still count every token', async () => {
  // The uncosted tokens are excluded from profit only. They are still yours and
  // still worth something — dropping them from the totals would be the opposite
  // error.
  const t = await multi({ costs: [0, 0.00107, 0.00107] });
  assert.match(t, /You hold:\s*225\.09/, 'the held total stopped counting an uncosted wallet');
  assert.match(t, /Now worth:.*\$5\.96/, 'the value total stopped counting an uncosted wallet');
});

test('a wallet with no entry price says so rather than showing a 100% win', async () => {
  // cost 0 with any value is an infinite return. Printing "in 0.00000 ETH"
  // beside it would read as a total win on tokens that were simply given away.
  const t = await multi({ costs: [0, 0.00107, 0.00107] });
  const line = t.split('\n')[t.split('\n').findIndex((l) => /Wallet 2 —/.test(l)) + 1];
  assert.match(line, /no cost basis on record/, `Wallet 2's row read: ${line}`);
  assert.ok(!/%/.test(line), `a percentage was invented from a zero cost: ${line}`);
});

test('a clean book is unaffected — no note, and every row keeps its percentage', async () => {
  const t = await multi();
  assert.ok(!/no entry price on record/.test(t), 'the exclusion note fired with nothing excluded');
  for (const line of rows(t)) assert.match(line, /−0\.6\d%/, `a row lost its P/L: ${line}`);
});

// ---------------------------------------------------------------- audit round two
//
// Thirteen findings from an adversarial review of the card above, every one of
// them reproduced against the real render before being written down. They share
// three roots: a LIVE balance divided by a BUY-TIME basis, one wallet's decimals
// used for the whole token, and a failed read priced as a fact.

const E = (n) => BigInt(Math.round(n)) * 10n ** 18n;

/** Full control of every wallet: live balance, recorded size, recorded cost. */
async function book({ dec = 18, wallets, price = 0.00001417, rate = 1870, bound = 'w2' } = {}) {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = wallets.map((_, i) => ({ id: 'w' + (i + 2), name: 'Wallet ' + (i + 2), address: '0x' + String(i + 2).repeat(40), positions: {}, orders: [], history: [] }));
  u.activeWalletId = bound;
  u.wallets.forEach((w, i) => {
    const spec = wallets[i];
    if (spec.cost > 0) w.positions[core.posKey(CHAIN, CA)] = { chain: CHAIN, ca: CA, sym: 'PONS', dec, ethIn: spec.cost, ethOut: 0, costEth: spec.cost, tokens: String(spec.recorded) };
  });
  const realAcross = core.tokenBalancesAcross, realSnap = core.tokenSnapshot, realSoc = tokeninfo.socials, realMeta = core.tokenMeta;
  core.tokenBalancesAcross = async () => u.wallets.map((w, i) => ({ id: w.id, index: i + 1, label: w.name, raw: wallets[i].live }));
  core.tokenSnapshot = async () => ({ sym: 'PONS', priceEth: price, mcapUsd: 26e6 });
  core.tokenMeta = async () => ({ sym: 'PONS', name: 'Pons', decimals: dec });
  tokeninfo.socials = async () => null;
  tg._test.PRICES.ETH = rate;
  try { return await tg._test.monitorPayload(CHAT, CA, CHAIN, bound); }
  finally { core.tokenBalancesAcross = realAcross; core.tokenSnapshot = realSnap; tokeninfo.socials = realSoc; core.tokenMeta = realMeta; }
}
const pl = (t) => t.split('\n').find((l) => l.includes('Profit/Loss')) || '';

test('tokens sent INTO a wallet that also bought are not priced at that wallet\'s entry', async () => {
  // 675 tokens arrive in Wallet 2, which had bought 75 for 0.00107. The split
  // was per WALLET — any wallet with a basis had its ENTIRE live balance priced
  // — so the donated tokens were charged against the bought ones' cost and the
  // card printed 🟢 +297.33% on a position that was down 0.68%. Move the same
  // 675 to a wallet with no position and it printed −0.64%. Same tokens, same
  // money, two answers.
  const p = await book({ wallets: [
    { live: E(750), recorded: E(75), cost: 0.00107 },
    { live: E(75), recorded: E(75), cost: 0.00107 },
    { live: E(75), recorded: E(75), cost: 0.00107 },
  ] });
  const t = plain(p);
  assert.ok(/🔴/.test(pl(t)), `a flat book reported a gain: ${pl(t)}`);
  assert.ok(!/\+29\d\./.test(t), 'the +297% is back');
  assert.match(t, /675\.00 \$PONS has no entry price/, 'the donated tokens were never named');
});

test('moving your own bag out of a wallet does not print −100% on it', async () => {
  // Tokens leave Wallet 2 out of band. The whole basis stayed charged against
  // what remained, so a winning position read as a total loss. The basis is
  // scaled to what is still there.
  const p = await book({ wallets: [
    { live: 0n, recorded: E(75), cost: 0.00107 },
    { live: E(150), recorded: E(75), cost: 0.00107 },
    { live: E(75), recorded: E(75), cost: 0.00107 },
  ] });
  const t = plain(p);
  assert.ok(!/−100\.00%/.test(t), `a moved bag read as a wipeout:\n${t}`);
  assert.ok(/−0\.6\d%/.test(pl(t)), `the book is flat and should read flat: ${pl(t)}`);
});

test('a row\'s percentage and its dollar amount describe the same tokens', async () => {
  // The percentage came from the costed part and the money from the whole live
  // bag, so one row printed "🟢 +0.68% (+$17.87)" — a green plus on a losing
  // number.
  const t = plain(await book({ wallets: [
    { live: E(750), recorded: E(75), cost: 0.00107 },
    { live: E(75), recorded: E(75), cost: 0.00107 },
  ] }));
  for (const line of t.split('\n')) {
    if (!/worth /.test(line) || !/%/.test(line)) continue;
    const green = /🟢/.test(line), plus = /\(\+\$/.test(line), minus = /\(−\$/.test(line);
    if (green) assert.ok(!minus, `a green row carries a negative amount: ${line}`);
    else assert.ok(!plus, `a red row carries a positive amount: ${line}`);
  }
});

// ---------------------------------------------------------------- decimals
test('a 6-decimal token is decoded as 6 decimals on EVERY wallet', async () => {
  // decimals were read off the BOUND wallet's position record and fell back to a
  // hardcoded 18. Every Solana SPL is 6 or 9: a real 675-token bag on the active
  // wallet — the one the Sell buttons act on — rendered "0.0000 $PONS · $0.00".
  const p = await book({ dec: 6, wallets: [
    { live: 675000000n, recorded: 0, cost: 0 },        // active wallet, no position record
    { live: 75030000n, recorded: 75030000n, cost: 0.00107 },
  ] });
  const t = plain(p);
  assert.match(t, /675\.00 \$PONS/, `a 6-decimal bag was decoded as 18:\n${t}`);
  assert.ok(!/Wallet 2 — 0\.0000/.test(t), 'the bound wallet\'s bag rendered as zero');
  assert.ok(p.kb.inline_keyboard.flat().some((b) => (b.callback_data || '').startsWith('s:')),
    'the Sell buttons vanished from a wallet that is holding');
});

// ---------------------------------------------------------------- failed reads
test('a wallet that could not be read is excluded from the numbers, and named', async () => {
  // It kept its full cost in the denominator while contributing no tokens to the
  // numerator — a confident −33.76% over one failed RPC call, with no caveat
  // anywhere on the totals.
  const p = await book({ wallets: [
    { live: E(75), recorded: E(75), cost: 0.00107 },
    { live: null, recorded: 0, cost: 0.00107 },        // read failed, nothing on record
    { live: E(75), recorded: E(75), cost: 0.00107 },
  ] });
  const t = plain(p);
  assert.ok(/−0\.6\d%/.test(pl(t)), `an RPC blip was reported as a loss: ${pl(t)}`);
  assert.match(t, /could not be read/, 'the missing wallet was never mentioned');
});

test('an unreadable wallet never gets a row asserting $0.00 and −100%', async () => {
  // "(unreadable)" sat on line one and two fabricated facts sat on line two.
  const t = plain(await book({ wallets: [
    { live: E(75), recorded: E(75), cost: 0.00107 },
    { live: null, recorded: 0, cost: 0.00107 },
  ] }));
  assert.ok(!/worth \$0\.00/.test(t), `a wallet with no information was priced at zero:\n${t}`);
  assert.ok(!/−100\.00%/.test(t), 'a wallet with no information was reported as a total loss');
});

test('the "could not be read" warning survives the wallet-row cap', async () => {
  // Unreadable rows carry 0 tokens, the list sorts by tokens descending, and it
  // is capped — so truncation dropped precisely the rows the user needed. The
  // warning lives outside the list.
  const many = Array.from({ length: 12 }, (_, i) => ({ live: E(75), recorded: E(75), cost: 0.00107 }));
  many[11] = { live: null, recorded: 0, cost: 0.00107 };
  const t = plain(await book({ wallets: many }));
  assert.match(t, /1 wallet could not be read/, 'the warning was truncated away with its row');
});

// ---------------------------------------------------------------- holding is a position
test('holding tokens with no recorded entry is still an open position', async () => {
  // Keyed on cost alone, a bag that was airdropped or bought elsewhere rendered
  // "No open position", hid the Sell buttons, and let the monitor retire itself
  // — on tokens the user was holding and could have sold from that card.
  const p = await book({ wallets: [{ live: E(500), recorded: 0, cost: 0 }] });
  const t = plain(p);
  assert.ok(!/No open position/.test(t), `a held bag was declared closed:\n${t}`);
  assert.match(t, /500\.00 \$PONS/);
  assert.ok(p.kb.inline_keyboard.flat().some((b) => (b.callback_data || '').startsWith('s:')),
    'no way to sell a bag the card admits you are holding');
  assert.equal(p.closed, false, 'the monitor would have stopped itself');
});

// ---------------------------------------------------------------- dust
test('the exclusion note does not fire on an amount that displays as zero', async () => {
  // The gate was 1e-12, far below fmt()'s resolution, so dust announced
  // "ℹ️ 0.0000 $PONS has no entry price on record" — which reads as a bug.
  const t = plain(await book({ wallets: [
    { live: E(75) + 1000n, recorded: E(75), cost: 0.00107 },   // 1e-15 of a token extra
  ] }));
  assert.ok(!/0\.0000 \$PONS has no entry price/.test(t), `dust triggered the notice:\n${t}`);
});

test('a clean book still says nothing it does not need to', async () => {
  const t = plain(await book({ wallets: [
    { live: E(75), recorded: E(75), cost: 0.00107 },
    { live: E(75), recorded: E(75), cost: 0.00107 },
  ] }));
  assert.ok(!/no entry price on record/.test(t), 'the exclusion note fired with nothing excluded');
  assert.ok(!/could not be read/.test(t), 'the read warning fired with every wallet readable');
  assert.ok(!/not bought here/.test(t), 'a fully-costed row claimed uncosted tokens');
});
