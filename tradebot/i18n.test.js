'use strict';
/*
 * The bot's copy, in both languages.
 *
 * `user.lang` and getLang()/setLang() sat in core.js unused for the whole life of
 * this bot: the schema said the bot could answer in Indonesian and every single
 * reply was a hardcoded English literal. These tests exist so that cannot happen
 * again quietly — a key added in English and forgotten in Indonesian fails here,
 * and so does a translation that loses one of the numbers a trader is reading.
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const i18n = require('./i18n');
const TG = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');

// ---------------------------------------------------------------- completeness
test('every string exists in every supported language', () => {
  const missing = [];
  for (const [key, entry] of Object.entries(i18n._strings)) {
    for (const lang of i18n.LANGS) if (!entry[lang]) missing.push(`${key} (${lang})`);
  }
  assert.deepEqual(missing, [], 'untranslated keys — an English-only key ships as English to everyone');
});

test('no translation silently drops a placeholder the English copy fills', () => {
  // The real hazard of a hand-written locale: "Bought {sym}" translated without
  // {sym}, so a receipt renders with a blank where the token should be.
  const slots = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort();
  const bad = [];
  for (const [key, entry] of Object.entries(i18n._strings)) {
    const want = slots(entry.en);
    for (const lang of i18n.LANGS) {
      if (lang === 'en') continue;
      if (String(slots(entry[lang])) !== String(want)) bad.push(`${key} (${lang}): ${slots(entry[lang])} != ${want}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the two languages are genuinely different copy, not a copy-paste', () => {
  // A locale file that was filled in by duplicating English is worse than none:
  // it reports as complete and reads as broken. Allow the handful of strings
  // that legitimately match (bare labels, trading jargon kept in English).
  let same = 0, total = 0;
  for (const entry of Object.values(i18n._strings)) { total++; if (entry.en === entry.id) same++; }
  assert.ok(same / total < 0.25, `${same}/${total} Indonesian strings are identical to English`);
});

// ---------------------------------------------------------------- rendering
test('placeholders are substituted, and a missing one leaves no "{name}" on screen', () => {
  assert.equal(i18n.t('en', 'buy.progress', { amt: '0.05', native: 'ETH', atMc: '' }), '⏳ <b>Buying 0.05 ETH</b>…');
  assert.equal(i18n.t('id', 'buy.progress', { amt: '0.05', native: 'ETH', atMc: '' }), '⏳ <b>Beli 0.05 ETH</b>…');
  // A var the caller forgot renders as nothing — never as literal braces.
  assert.ok(!i18n.t('id', 'buy.progress', { amt: '1' }).includes('{'));
});

test('an unknown language falls back to English rather than blank', () => {
  assert.equal(i18n.t('fr', 'common.cancelled'), i18n.t('en', 'common.cancelled'));
  assert.equal(i18n.t(undefined, 'common.cancelled'), i18n.t('en', 'common.cancelled'));
});

test('an unknown key returns the key — visibly wrong beats invisibly empty', () => {
  assert.equal(i18n.t('en', 'no.such.key'), 'no.such.key');
});

// ---------------------------------------------------------------- errors
test('each failure class maps to its own message, in both languages', () => {
  const cases = [
    ['token balance is 0', 'err.no_bag'],
    ['insufficient ETH — need ~0.016, have 0.01499', 'err.insufficient'],
    ['max fee per gas less than block base fee', 'err.gas_moved'],
    ['execution reverted', 'err.slippage'],
    ['trade sent but not confirmed', 'err.unconfirmed'],
    ['could not price this buy on Base V3 (pool read failed)', 'err.no_price'],
    ['NotAllowed: private beta', 'err.restricted'],
    ['something nobody has seen before', 'err.generic'],
  ];
  for (const [raw, key] of cases) {
    assert.equal(i18n.errorKey(new Error(raw)), key, `"${raw}" classified wrong`);
    for (const lang of i18n.LANGS) {
      const msg = i18n.errorText(lang, new Error(raw), 'buy');
      assert.ok(msg && msg.length > 10, `${lang}/${key} rendered empty`);
      assert.ok(!msg.includes('{'), `${lang}/${key} left an unsubstituted placeholder`);
    }
  }
});

test('an error message never leaks the raw chain/RPC text to the user', () => {
  // "could not coalesce error", a revert selector, a nonce dump: all real
  // strings this engine produces, none of them something a trader can act on.
  for (const lang of i18n.LANGS) {
    const msg = i18n.errorText(lang, new Error('could not coalesce error (payload=0x08c379a0…)'), 'sell');
    assert.ok(!/coalesce|0x08c379a0|payload/i.test(msg), `${lang} passed the raw error through`);
  }
});

test('the gas-moved message names the button to press, not a verb', () => {
  assert.match(i18n.errorText('en', new Error('nonce too low'), 'buy'), /tap Buy again/i);
  assert.match(i18n.errorText('id', new Error('nonce too low'), 'sell'), /Sell/);
});

// ---------------------------------------------------------------- reachability
test('a user can actually reach the language setting', () => {
  // The whole failure this fixes: the setting existed and nothing could change
  // it. A picker nobody can open is the same bug wearing a different hat.
  assert.match(TG, /text === '\/language'/, 'no /language command');
  assert.match(TG, /data === 'lang'/, 'Settings has no route to the picker');
  assert.match(TG, /k === 'setlang'/, 'no handler applies the choice');
  assert.match(TG, /core\.setLang\(chatId, ca\)/, 'the choice is never persisted');
  assert.match(TG, /btn\(i18n\.t\(core\.getLang\(chatId\), 'lang\.button'\)/, 'Settings shows no Language button');
});

test('the bot reads the stored language instead of assuming English', () => {
  // core.getLang existed and was exported for the bot's whole life without a
  // single caller. If this count goes back to zero, the feature is dead again.
  const reads = (TG.match(/core\.getLang\(/g) || []).length;
  assert.ok(reads > 0, 'nothing in the UI reads the user language');
});
