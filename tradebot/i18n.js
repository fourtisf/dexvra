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

  // ---------------------------------------------------------------- wallets
  // The /wallet screen. Written so the ACTIVE wallet is the subject and every
  // other wallet is one line — the old version printed the active wallet twice
  // (once as a summary, once in the list) and both 42- and 44-character
  // addresses for every wallet, which on a phone buried the balances.
  'wal.title': { en: '💼 <b>Your wallets</b>', id: '💼 <b>Wallet kamu</b>' },
  'wal.total': {
    en: '{usd} across {n} of {cap} wallets',
    id: '{usd} di {n} dari {cap} wallet',
  },
  'wal.split': { en: '{coins} in coins · {tokens} in tokens', id: '{coins} berupa coin · {tokens} berupa token' },
  'wal.active_head': { en: '<b>Active wallet</b>', id: '<b>Wallet aktif</b>' },
  'wal.others_head': { en: '<b>Your other wallets</b>', id: '<b>Wallet kamu yang lain</b>' },
  'wal.tokens_row': { en: '🪙 Tokens', id: '🪙 Token' },
  'wal.empty_on': { en: '<i>Nothing yet on {chains}</i>', id: '<i>Belum ada isinya di {chains}</i>' },
  'wal.unread_on': {
    en: "<i>Couldn't reach {chains} — those are not counted above</i>",
    id: '<i>{chains} tidak bisa dihubungi — belum dihitung di atas</i>',
  },
  'wal.addr_evm': { en: 'Deposit on {chains}', id: 'Deposit di {chains}' },
  'wal.addr_sol': { en: 'Deposit on {chain}', id: 'Deposit di {chain}' },
  // The one genuinely actionable thing a zero balance tells you.
  'wal.no_gas': {
    en: "⚠️ <b>0 {native} on {chain}</b> — you can't buy or pay gas here until you deposit.",
    id: '⚠️ <b>0 {native} di {chain}</b> — belum bisa beli atau bayar gas di sini sampai kamu deposit.',
  },
  'wal.orders': { en: '{n} open', id: '{n} order jalan' },
  // Named, never silent: a screen that quietly drops wallets reads as a screen
  // that lost them. Every rolled-up wallet still has its own button below.
  'wal.more': {
    en: '…and {n} more, holding {usd}. Their buttons are below.',
    id: '…dan {n} wallet lagi, isinya {usd}. Tombolnya ada di bawah.',
  },
  'wal.hint': {
    en: '<i>Tap a wallet to make it active · ✏️ rename · 📥 its address &amp; QR · 🗑 remove.</i>',
    id: '<i>Tap wallet untuk jadikan aktif · ✏️ ganti nama · 📥 alamat &amp; QR-nya · 🗑 hapus.</i>',
  },
  'wal.first_steps': {
    en: '<b>Three steps to your first trade 👇</b>\n1️⃣ Tap <b>📥</b> on a wallet and send it some {native}.\n2️⃣ Tap <b>🔄 Refresh</b> — you will see it land.\n3️⃣ Paste any token contract address to get a live card with a one-tap Buy.',
    id: '<b>Tiga langkah menuju trade pertama 👇</b>\n1️⃣ Tap <b>📥</b> di salah satu wallet, lalu kirim {native} ke situ.\n2️⃣ Tap <b>🔄 Refresh</b> — saldonya akan langsung kelihatan.\n3️⃣ Paste alamat kontrak token apa pun untuk dapat kartu live dengan tombol Buy sekali tap.',
  },
  'wal.keys_note': {
    en: '<i>One key per wallet. Every EVM chain shares the same 0x address; Solana has its own.</i>',
    id: '<i>Satu key per wallet. Semua chain EVM pakai alamat 0x yang sama; Solana punya alamatnya sendiri.</i>',
  },

  // ---------------------------------------------------------------- tokens
  // The cross-chain "what do I actually hold" list. /portfolio answers the same
  // question for ONE chain, because it reports PnL in that chain's native coin
  // and ETH profit cannot be added to BNB profit. USD is what makes this list
  // possible across chains, so it is the only unit here.
  'tok.title': { en: '🪙 <b>Your tokens</b> · every chain', id: '🪙 <b>Token kamu</b> · semua chain' },
  'tok.total': { en: '{usd} in tokens', id: '{usd} dalam bentuk token' },
  'tok.empty': {
    en: 'No tokens yet — only your coins.\n\nPaste a token contract address and tap Buy; whatever you buy shows up here, grouped by the chain it lives on.',
    id: 'Belum ada token — baru coin saja.\n\nPaste alamat kontrak token lalu tap Buy; semua yang kamu beli muncul di sini, dikelompokkan per chain.',
  },
  'tok.no_price': { en: '<i>price unavailable</i>', id: '<i>harga tidak terbaca</i>' },
  'tok.plus_unknown': { en: '<i>+ more we could not price</i>', id: '<i>+ ada yang harganya tidak terbaca</i>' },
  'tok.unpriced_note': {
    en: "<i>A price we can't read is left out of the totals rather than counted as zero — usually a pool with no liquidity right now.</i>",
    id: '<i>Harga yang tidak terbaca tidak dihitung sebagai nol, tapi dikeluarkan dari total — biasanya karena pool-nya lagi tidak ada likuiditas.</i>',
  },
  'tok.note': {
    en: '<i>Tap a token to open its card. This lists what you bought with the bot — a token sent in from another wallet is not tracked.</i>',
    id: '<i>Tap token untuk buka kartunya. Yang terdaftar di sini adalah yang kamu beli lewat bot — token kiriman dari wallet lain tidak ikut tercatat.</i>',
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
  // Shown the instant the transaction is broadcast, well before it confirms. On a
  // 12-second chain this is the whole difference between a bot that feels alive
  // and one that looks hung.
  'buy.sent': {
    en: '🚀 <b>Buy sent</b> — {amt} {native}\nWaiting for the network to confirm it…\n{link}',
    id: '🚀 <b>Buy terkirim</b> — {amt} {native}\nMenunggu konfirmasi jaringan…\n{link}',
  },
  'sell.sent': {
    en: '🚀 <b>Sell sent</b> — {pct}%\nWaiting for the network to confirm it…\n{link}',
    id: '🚀 <b>Sell terkirim</b> — {pct}%\nMenunggu konfirmasi jaringan…\n{link}',
  },
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
