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
