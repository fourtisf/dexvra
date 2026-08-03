'use strict';
/*
 * i18n.js — user-facing copy, in English and Indonesian.
 *
 * core.js has carried `user.lang` ('en' | 'id') plus getLang()/setLang() since the
 * schema was written, and exported both. NOTHING ever called them: every string in
 * telegram.js was a hardcoded English literal and there was no command, button or
 * flow that could change the setting. A large share of this bot's users trade in
 * Indonesian, and the bot answered all of them in English while its own store
 * claimed to know better. This module is the missing half.
 *
 * CONVENTIONS
 *   • Keys are `area.thing`, and BOTH languages live on the same line-block, so a
 *     translation that drifts is visible in the diff rather than discovered by a
 *     user. A key missing from `id` falls back to `en` — never to a blank message.
 *   • `{placeholders}` are substituted verbatim. Callers pass values that are
 *     ALREADY escaped/formatted, exactly as the surrounding telegram.js code does
 *     with esc() — this module adds no escaping of its own and must not, or
 *     pre-escaped HTML (<b>, <code>) would be double-escaped and render as markup.
 *   • Indonesian copy is written the way traders actually talk: "buy", "sell",
 *     "wallet", "slippage", "gas" and "token" stay in English because translating
 *     them ("dompet", "selip") reads as machine output to the people using this.
 */

const LANGS = ['en', 'id'];
const DEFAULT_LANG = 'en';
const LANG_LABEL = { en: '🇬🇧 English', id: '🇮🇩 Bahasa Indonesia' };

const S = {
  // ---------------------------------------------------------------- onboarding
  'start.title': {
    en: '👋 <b>Welcome to Dexvra Trade Bot</b>',
    id: '👋 <b>Selamat datang di Dexvra Trade Bot</b>',
  },
  'start.pitch': {
    en: 'Buy and sell tokens right here in Telegram — no website, no wallet app, no extension.',
    id: 'Beli dan jual token langsung dari Telegram — tanpa website, tanpa aplikasi wallet, tanpa extension.',
  },
  'start.steps.head': { en: '<b>Get started in 3 steps</b>', id: '<b>Mulai dalam 3 langkah</b>' },
  'start.steps.1': {
    en: '1️⃣ <b>Add funds.</b> Tap <b>📥 Get my deposit address</b> below and send some {native} to it.',
    id: '1️⃣ <b>Isi saldo.</b> Tap <b>📥 Ambil alamat deposit</b> di bawah, lalu kirim {native} ke alamat itu.',
  },
  'start.steps.2': {
    en: "2️⃣ <b>Pick a token.</b> Paste its contract address here — you'll get a live card with price, safety and your holdings.",
    id: '2️⃣ <b>Pilih token.</b> Paste alamat kontraknya di sini — kamu langsung dapat kartu live berisi harga, cek keamanan, dan posisi kamu.',
  },
  'start.steps.3': {
    en: "3️⃣ <b>Trade.</b> Tap Buy or Sell. That's it.",
    id: '3️⃣ <b>Trading.</b> Tap Buy atau Sell. Sesederhana itu.',
  },
  'start.custody': {
    en: '<i>Your wallet is created and secured for you — only you can withdraw. Never share your private key with anyone.</i>',
    id: '<i>Wallet kamu dibuat dan diamankan otomatis — hanya kamu yang bisa withdraw. Jangan pernah bagikan private key ke siapa pun.</i>',
  },
  'start.new': {
    en: '👇 A wallet was just created for you. Add funds to begin.',
    id: '👇 Wallet kamu baru saja dibuat. Isi saldo dulu untuk mulai.',
  },
  'start.returning': { en: "👇 Here's your wallet.", id: '👇 Ini wallet kamu.' },
  'start.deeplink.new': {
    en: '👋 <b>Welcome to Dexvra Trade Bot</b>\n\nA wallet was just created for you. To start trading, tap 💼 Wallets → 📥 to get your deposit address and add some funds. Here\'s the token you tapped 👇',
    id: '👋 <b>Selamat datang di Dexvra Trade Bot</b>\n\nWallet kamu baru saja dibuat. Untuk mulai trading, tap 💼 Wallets → 📥 buat ambil alamat deposit dan isi saldo. Ini token yang kamu tap 👇',
  },
  'start.deeplink.fail': {
    en: "⚠️ <b>Couldn't open that token just now.</b>\n\nTap to copy its contract and paste it here to try again 👇",
    id: '⚠️ <b>Token itu belum bisa dibuka sekarang.</b>\n\nTap untuk menyalin alamat kontraknya, lalu paste di sini buat coba lagi 👇',
  },

  // ---------------------------------------------------------------- chrome
  'common.cancelled': { en: 'Cancelled.', id: 'Dibatalkan.' },
  'common.sending': { en: '⏳ Sending…', id: '⏳ Mengirim…' },
  'common.unknown_input': {
    en: "🤔 I didn't recognise that.\n\nTo trade a token, paste its <b>contract address</b> here. Or tap a button below.",
    id: '🤔 Saya belum mengerti pesan itu.\n\nUntuk trading token, paste <b>alamat kontraknya</b> di sini. Atau tap salah satu tombol di bawah.',
  },

  // ---------------------------------------------------------------- buy
  'buy.inflight': {
    en: '⏳ Already buying that token — wait for the result before buying again.',
    id: '⏳ Token itu sedang diproses — tunggu hasilnya dulu sebelum beli lagi.',
  },
  'buy.progress': { en: '⏳ <b>Buying {amt} {native}</b>{atMc}…', id: '⏳ <b>Beli {amt} {native}</b>{atMc}…' },
  'buy.progress.multi': {
    en: '⏳ <b>Buying {amt} {native} on {n} wallets…</b>',
    id: '⏳ <b>Beli {amt} {native} di {n} wallet…</b>',
  },
  'buy.at_mc': { en: ' at MC <b>${mc}</b>', id: ' di MC <b>${mc}</b>' },
  'buy.receipt.title': { en: '✅ <b>Bought ${sym}</b>', id: '✅ <b>Berhasil beli ${sym}</b>' },
  'buy.receipt.spent': { en: 'Spent: <b>{amt} {native}</b> ({usd})', id: 'Terpakai: <b>{amt} {native}</b> ({usd})' },
  'buy.receipt.got': { en: 'Got: <b>{amt} ${sym}</b> ({usd})', id: 'Dapat: <b>{amt} ${sym}</b> ({usd})' },
  'buy.receipt.entry': { en: 'Entry: <b>${px}</b>', id: 'Harga masuk: <b>${px}</b>' },
  'buy.receipt.wallet': { en: 'Wallet: {wallet} · {venue}', id: 'Wallet: {wallet} · {venue}' },
  'buy.receipt.multi': {
    en: '✅ <b>Bought ${sym}</b> · {ok}/{n} wallets\nTotal: <b>{tokens} ${sym}</b> · spent <b>{spent} {native}</b>{usd}',
    id: '✅ <b>Berhasil beli ${sym}</b> · {ok}/{n} wallet\nTotal: <b>{tokens} ${sym}</b> · terpakai <b>{spent} {native}</b>{usd}',
  },
  'buy.failed': { en: "❌ <b>Buy didn't go through</b>", id: '❌ <b>Buy tidak berhasil</b>' },

  // ---------------------------------------------------------------- sell
  'sell.progress': { en: '⏳ <b>Selling {pct}% of {what}…</b>', id: '⏳ <b>Jual {pct}% dari {what}…</b>' },
  'sell.progress.multi': {
    en: '⏳ <b>Selling {pct}% on {n} wallets…</b>',
    id: '⏳ <b>Jual {pct}% di {n} wallet…</b>',
  },
  'sell.your_token': { en: 'your token', id: 'token kamu' },
  'sell.retry': {
    en: '⚙️ <b>Retry {n}/2</b> — raising gas &amp; slippage to complete the sell…',
    id: '⚙️ <b>Percobaan {n}/2</b> — menaikkan gas &amp; slippage supaya sell-nya tembus…',
  },
  'sell.receipt.title': { en: '✅ <b>Sold {pct}% of ${sym}</b>', id: '✅ <b>Berhasil jual {pct}% dari ${sym}</b>' },
  'sell.receipt.received': { en: 'Received: <b>{amt} {native}</b>{usd}', id: 'Diterima: <b>{amt} {native}</b>{usd}' },
  'sell.receipt.pnl': { en: 'P/L: <b>{pnl}</b>{usd}', id: 'Untung/Rugi: <b>{pnl}</b>{usd}' },
  'sell.receipt.multi': {
    en: '✅ <b>Sold {pct}%</b> · {ok}/{n} wallets{skip}\nTotal received: <b>{amt} {native}</b>{usd}',
    id: '✅ <b>Berhasil jual {pct}%</b> · {ok}/{n} wallet{skip}\nTotal diterima: <b>{amt} {native}</b>{usd}',
  },
  'sell.receipt.multi.skip': { en: ' ({n} had no bag)', id: ' ({n} tidak punya posisi)' },
  'sell.no_bag': { en: '— no bag', id: '— tidak ada posisi' },
  'sell.failed': { en: "❌ <b>Sell didn't go through</b>", id: '❌ <b>Sell tidak berhasil</b>' },

  // ---------------------------------------------------------------- errors
  // One clear sentence per failure class, each ending in what to actually do.
  // The raw on-chain / RPC text is still logged server-side for the operator.
  'err.no_bag': {
    en: "You don't hold any of this token to sell.",
    id: 'Kamu tidak punya token ini untuk dijual.',
  },
  'err.insufficient': {
    en: 'Not enough balance to cover this {act} plus network gas. Top up and try again.',
    id: 'Saldo kamu tidak cukup untuk {act} ini plus gas jaringan. Isi saldo dulu, lalu coba lagi.',
  },
  'err.gas_moved': {
    en: 'The network gas price just moved. Please tap {btn} again — it usually goes through on the next try.',
    id: 'Harga gas jaringan barusan berubah. Tap {btn} sekali lagi — biasanya langsung tembus di percobaan berikutnya.',
  },
  'err.slippage': {
    en: "The price moved faster than your slippage allows, so the {act} didn't go through. Try again, or raise your slippage in ⚙️ Settings.",
    id: 'Harga bergerak lebih cepat dari batas slippage kamu, jadi {act}-nya tidak tembus. Coba lagi, atau naikkan slippage di ⚙️ Settings.',
  },
  'err.unconfirmed': {
    en: 'The network is slow right now — your {act} may still complete. Check your wallet before trying again.',
    id: 'Jaringan sedang lambat — {act} kamu mungkin masih akan tembus. Cek wallet dulu sebelum coba lagi.',
  },
  'err.no_price': {
    en: "Couldn't read live pricing for this token right now. Please try again in a moment.",
    id: 'Harga live token ini belum bisa dibaca sekarang. Coba lagi sebentar lagi.',
  },
  'err.restricted': {
    en: "This token can't be traded yet (it may be restricted). Try a different token.",
    id: 'Token ini belum bisa ditradingkan (kemungkinan masih dibatasi). Coba token lain.',
  },
  'err.generic': {
    en: "The {act} didn't go through. Please try again in a moment.",
    id: '{act} tidak berhasil. Coba lagi sebentar lagi.',
  },
  // Substituted into the {act} slot above, so the sentence reads naturally.
  'word.buy': { en: 'buy', id: 'buy' },
  'word.sell': { en: 'sell', id: 'sell' },
  'word.transaction': { en: 'transaction', id: 'transaksi' },

  // ---------------------------------------------------------------- language
  'lang.screen': {
    en: '🌍 <b>Language</b>\n\nChoose the language the bot replies in.\n\nCurrent: <b>{current}</b>',
    id: '🌍 <b>Bahasa</b>\n\nPilih bahasa yang dipakai bot untuk membalas.\n\nSaat ini: <b>{current}</b>',
  },
  'lang.set': { en: '✅ Language set to <b>{lang}</b>.', id: '✅ Bahasa diganti ke <b>{lang}</b>.' },
  'lang.button': { en: '🌍 Language', id: '🌍 Bahasa' },
  'lang.back': { en: '« ⚙️ Settings', id: '« ⚙️ Pengaturan' },
};

function normalize(lang) { return LANGS.includes(lang) ? lang : DEFAULT_LANG; }

/** Look up `key` in `lang`, substituting {placeholders} from `vars`.
 *  Falls back to English for a key the translation is missing, and returns the
 *  key itself if it exists in neither — a visibly wrong string beats a blank
 *  message, because a blank one ships unnoticed. */
function t(lang, key, vars) {
  const entry = S[key];
  if (!entry) return key;
  const tpl = entry[normalize(lang)] || entry.en || key;
  if (!vars) return tpl;
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? '' : String(vars[k])));
}

/** Classify a raw engine/RPC error into a translation key. Kept separate from the
 *  rendering so the (regex-heavy, easy-to-get-wrong) matching is testable on its
 *  own and shared by every language. */
function errorKey(raw) {
  const m = String((raw && (raw.message || raw)) || '').toLowerCase();
  if (/token balance is 0|no bag/.test(m)) return 'err.no_bag';
  if (/insufficient|need ~|exceeds balance/.test(m)) return 'err.insufficient';
  if (/max fee per gas|base fee|underpriced|replacement|nonce/.test(m)) return 'err.gas_moved';
  if (/thin pool|price impact|slippage|reverted|iia|too little received/.test(m)) return 'err.slippage';
  if (/not confirmed|timeout|pending/.test(m)) return 'err.unconfirmed';
  if (/could not (read|price)|pool read|quote|no pool|no liquidity/.test(m)) return 'err.no_price';
  if (/private beta|not allowed|notallowed/.test(m)) return 'err.restricted';
  return 'err.generic';
}

/** One clear, localized sentence for a failed trade. `action` is 'buy'|'sell'. */
function errorText(lang, raw, action) {
  const key = errorKey(raw);
  const act = t(lang, action === 'buy' ? 'word.buy' : action === 'sell' ? 'word.sell' : 'word.transaction');
  // 'err.gas_moved' names the BUTTON to press, which is capitalised UI, not a noun.
  const btn = action === 'buy' ? 'Buy' : 'Sell';
  return t(lang, key, { act, btn });
}

module.exports = { t, errorKey, errorText, normalize, LANGS, DEFAULT_LANG, LANG_LABEL, _strings: S };
