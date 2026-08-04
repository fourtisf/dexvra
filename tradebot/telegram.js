'use strict';
/*
 * Dexvra Trade Bot — Telegram UI (long-polling, HTML, inline keyboards).
 * Multi-chain: pick a chain, paste a token contract, one-tap buy/sell. Manage a
 * custodial wallet (generate/import/export/withdraw), portfolio, snipes,
 * limit/TP-SL orders and referrals. Trading logic is in core.js; watchers.js runs
 * snipe + order fills. DMs only (custodial wallet must not be shared in a group).
 */
const { ethers } = require('ethers');
const { AsyncLocalStorage } = require('async_hooks');
const core = require('./core');
const watchers = require('./watchers');
const report = require('./report');   // ops reporting to admin channel (never sends secrets)
// Carries the user's message id through a text-message handler so every reply THREADS
// (Telegram "reply to") that message — set once in onMessage, read in send(). Safe under
// concurrency (per-invocation store, not a global). Callback (button) handlers have no
// store, so button responses don't reply-to-nothing.
const _replyCtx = new AsyncLocalStorage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goplus = require('./goplus');
const i18n = require('./i18n');       // EN/ID copy — see i18n.js for why this exists
const safety = require('./safety');   // chain-aware token safety (GoPlus on EVM, RugCheck on Solana)
const tokeninfo = require('./tokeninfo');
const solana = require('./solana');   // base58 address validation + SVM helpers
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const API = `https://api.telegram.org/bot${core.CFG.tgToken}`;
const pending = new Map();      // chatId -> { action, ..., ts }
const PENDING_TTL = 5 * 60 * 1000;
const PRICES = { ETH: 0, BNB: 0, SOL: 0 };
let BOT_USERNAME = '';
// Last-known native balance per `${walletId}:${chainKey}` → { raw, at }. Used so a
// single flaky/slow RPC (a timed-out read) can't silently drop a chain from the wallet
// totals — the total stays stable instead of jumping down then back on refresh.
const _balCache = new Map();
// Short-lived token price cache `${chain}:${caLower}` → { priceEth, at } so the wallet
// screen can include TOKEN holdings in each wallet's total without re-pricing every render.
const _priceCache = new Map();

// ------------------------------------------------------------ telegram api
async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  return r.json();
}
function send(chatId, text, kb) { const rt = _replyCtx.getStore(); return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}), ...(rt ? { reply_to_message_id: rt, allow_sending_without_reply: true } : {}) }); }
function edit(chatId, mid, text, kb) { return tg('editMessageText', { chat_id: chatId, message_id: mid, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}) }); }
function answer(id, text) { return tg('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }); }
// Callback keys whose handler answers the query with its OWN text. These must
// NOT be pre-acked — see the comment at the top of onCallback. Keep in sync with
// every `answer(q.id, <text>)` call site; callbackAck.test.js enforces it.
const ANSWERS_ITSELF = new Set(['oc', 'al', 'wtc', 'setlang', 'gasset', 'monn', 'monx', 'cpsell', 'ospd', 'mw', 'mwa', 'mwn']);
function del(chatId, mid) { return tg('deleteMessage', { chat_id: chatId, message_id: mid }).catch(() => {}); }
function sendPhoto(chatId, photo, caption, kb) { return tg('sendPhoto', { chat_id: chatId, photo, ...(caption ? { caption, parse_mode: 'HTML' } : {}), ...(kb ? { reply_markup: kb } : {}) }); }
// Deposit QR image (Telegram fetches the URL server-side; the address is public, so no
// secret leaves the bot). Configurable / disable-able via QR_API. Returns '' if disabled.
const QR_API = (process.env.QR_API === undefined ? 'https://api.qrserver.com/v1/create-qr-code' : process.env.QR_API).replace(/\/+$/, '');
const qrUrl = (data) => QR_API ? `${QR_API}/?size=320x320&margin=10&data=${encodeURIComponent(data)}` : '';
const rows = (...r) => ({ inline_keyboard: r });
const btn = (text, data) => ({ text, callback_data: data });
// Localized copy for a chat. core.getLang() has existed (and been exported) since
// the schema was written; until now nothing called it and every user got English
// regardless of what their record said. Values passed in `vars` must already be
// escaped/formatted by the caller — i18n adds no escaping (see i18n.js).
const T = (chatId, key, vars) => i18n.t(core.getLang(chatId), key, vars);

// ------------------------------------------------------------ helpers
// Escape ALL five HTML-sensitive chars — including " and ' — so a creator-set
// value (e.g. a token's website URL) can't break out of an href="..." attribute.
// &quot; and &#39; are both valid Telegram-HTML entities and render as the literal
// quote in text, so this is safe everywhere esc() is used.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
// True when a quantity still shows as non-zero after fmt() rounds it. Guards
// every "we left something out" notice: a threshold below the display's own
// resolution announces amounts the reader sees as 0.0000.
const fmtNZ = (n) => Number(fmt(n).replace(/[KM]$/, '')) > 0;
const fmt = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'; return n.toFixed(n < 1 ? 4 : 2); };
// A "contract" the user can paste: a 0x EVM address OR a base58 Solana mint. Both
// map to a token card (scoped to the active chain), and a withdraw destination.
const isEvmCa = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || '').trim());
const isCa = (s) => isEvmCa(s) || solana.isSolAddress(s);
const nativeUsd = (native) => PRICES[native] || 0;
const usd = (amount, native) => nativeUsd(native) > 0 ? '$' + fmt(Number(amount) * nativeUsd(native)) : '—';
const txLink = (chainKey, h) => { const c = core.chainOf(chainKey); return (h && c) ? `<a href="${c.explorer}/tx/${h}">tx ↗</a>` : ''; };
// Native decimals: SOL is 9 (lamports), EVM is 18 (wei). Format a raw balance for a chain.
const natDec = (chainKey) => core.chains.isSvm(chainKey) ? 9 : 18;
const fmtEth = (wei) => { try { return Number(ethers.formatEther(wei)).toFixed(5); } catch (_) { return '0'; } };
const fmtNat = (raw, chainKey) => { try { return Number(ethers.formatUnits(BigInt(raw || 0), natDec(chainKey))).toFixed(5); } catch (_) { return '0'; } };
// The address a wallet uses on a chain (base58 on Solana, 0x elsewhere).
const wAddr = (w, chainKey) => core.walletAddress(w, chainKey);
// A valid destination FOR a specific chain (base58 on Solana, 0x on EVM).
const isAddrFor = (s, chainKey) => core.chains.isSvm(chainKey) ? solana.isSolAddress(s) : isEvmCa(s);
const taxStr = (t) => (t == null ? '?' : (Math.round(t * 10) / 10) + '%');
function fmtAge(ms) { const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; }
function setPending(chatId, obj) { obj.ts = Date.now(); pending.set(chatId, obj); }
function activeChain(chatId) { return core.chainOf(core.userChain(core.ensureUser(chatId))); }
// Cost basis of the tokens a position currently HOLDS (drained proportionally on
// sells in core). Falls back to the legacy net-cash figure for old positions.
const posCost = (pos) => (pos && pos.costEth != null) ? pos.costEth : Math.max(0, ((pos && pos.ethIn) || 0) - ((pos && pos.ethOut) || 0));
const withTmo = (p, ms, fb) => Promise.race([p, new Promise((r) => setTimeout(() => r(fb), ms))]);
// Chart + explorer URL buttons for the token card. DexScreener covers the big
// chains by slug; anything else (e.g. Robinhood Chain) falls back to search.
// Buy amounts accept native units ('0.05') or USD ('$10', '10$', '10usd') —
// USD converts to native at the live price-feed rate at parse time.
function parseAmt(input, native) {
  const s = String(input == null ? '' : input).trim().toLowerCase();
  const m = s.match(/^\$?([0-9]*\.?[0-9]+)(\$|usd)?$/);
  if (!m) return null;
  const n = Number(m[1]); if (!(n > 0)) return null;
  if (!(s.startsWith('$') || m[2])) return { amt: String(n) };
  const px = nativeUsd(native);
  if (!(px > 0)) return { err: `price feed unavailable — send a ${native} amount instead (e.g. 0.01)` };
  return { amt: String(Number((n / px).toFixed(6))), usdVal: n };
}
// DexScreener indexes Robinhood Chain — the chain filter and /robinhood/<addr>
// pages are live. The map predates that, so robinhood was the ONE enabled chain
// falling through to `search?q=<address>`, which lands on the trending list
// rather than the token: a 📈 Chart button that shows somebody else's coins.
/** A dollar figure as a person would type it: 2k, 101K, 1.5m, $250,000, 0.0025.
 *
 *  A market-cap target is six or seven digits and was being typed out in full —
 *  "mc 1000000" — where one wrong zero sets the order ten times away from what
 *  was meant, on a screen whose whole job is to fire without asking again.
 *
 *  Returns null on anything it cannot read, never a guess: this number decides
 *  when a position is sold. */
function parseUsd(input) {
  let s = String(input == null ? '' : input).trim().toLowerCase();
  s = s.replace(/^\$/, '').replace(/(\$|usd)$/, '').replace(/,/g, '').trim();
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*([kmb])?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || !(n > 0)) return null;
  const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1;
  const v = n * mult;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The inverse of parseUsd: a dollar figure written the way we ask people to
 *  type it, so an example can be copied straight back into the box. */
const usdShort = (v) => {
  if (!(v > 0)) return '0';
  const cut = (n, suf) => String(Number(n.toFixed(n >= 100 ? 0 : 1))) + suf;
  if (v >= 1e9) return cut(v / 1e9, 'b');
  if (v >= 1e6) return cut(v / 1e6, 'm');
  if (v >= 1e3) return cut(v / 1e3, 'k');
  return String(Number(v.toPrecision(3)));
};

/** The "what target do you want" prompt, with examples computed from where the
 *  token ACTUALLY is.
 *
 *  The examples used to be constants — "0.0025", "mc 2k". Someone holding $PONS
 *  at $0.0272 with a $27M cap reads those and still has to work out what to type
 *  for their own position, which is the entire question they came here with. A
 *  target is a multiple of the price in front of them, so the prompt does that
 *  arithmetic. */
async function orderPrompt(ca, chainKey, kind) {
  const ch = core.chainOf(chainKey) || {};
  const snap = await withTmo(core.tokenSnapshot(ca, chainKey).catch(() => null), 4000, null);
  const rate = nativeUsd(ch.native);
  const px = snap && snap.priceEth > 0 && rate > 0 ? snap.priceEth * rate : 0;
  const mc = snap ? (snap.mcapUsd || ((snap.mcapEth || 0) * rate)) : 0;
  const sym = (snap && snap.sym) || '';
  const up = kind === 'tp';
  const head = up
    ? `🎯 <b>Limit sell${sym ? ' $' + esc(sym) : ''}</b> — sells 100% automatically when the price goes <b>UP</b>`
    : `🛑 <b>Stop-loss${sym ? ' $' + esc(sym) : ''}</b> — sells 100% automatically when the price goes <b>DOWN</b>`;
  const L = [head, ''];
  if (px > 0) L.push(`📈 <b>Now:</b> $${Number(px.toPrecision(3))}${mc > 0 ? ` · market cap $${fmt(mc)}` : ''}`, '');
  L.push('❓ <b>What price or market cap do you want to sell at?</b>', '');

  // FORMAT FIRST, examples second. "Reply with one of these:" over a list of
  // four numbers reads as a menu — pick one — rather than as two ways of
  // answering with any number you like. The question people were left with was
  // not "which of these four" but "what am I supposed to type".
  const pxEg = px > 0 ? Number((px * (up ? 2 : 0.7)).toPrecision(3)) : 0.0025;
  const mcEg = mc > 0 ? usdShort(mc * (up ? 2 : 0.7)) : (up ? '101k' : '250k');
  L.push('📝 <b>Reply with EITHER of these two:</b>');
  L.push(`  <b>1. A price</b> — just the number  →  <code>${pxEg}</code>`);
  L.push(`  <b>2. A market cap</b> — put <code>mc</code> in front  →  <code>mc ${mcEg}</code>`);
  L.push('');

  // Two multiples in the direction this order watches. Round numbers a holder
  // actually thinks in — double and 5× on the way up, a third and a half off on
  // the way down.
  const ms = up ? [[2, '2×'], [5, '5×']] : [[0.7, '−30%'], [0.5, '−50%']];
  if (px > 0) {
    L.push('💡 <b>Any number you want.</b> For reference, from where it is now:');
    for (const [k, why] of ms) {
      const priceCol = `<code>${Number((px * k).toPrecision(3))}</code>`;
      L.push(mc > 0 ? `  <b>${why}</b> → ${priceCol}  or  <code>mc ${usdShort(mc * k)}</code>` : `  <b>${why}</b> → ${priceCol}`);
    }
  } else {
    // No price read. Say so rather than printing invented multiples next to a
    // token whose value we could not fetch.
    L.push('<i>💡 Any number you want. I could not read this token\'s price just now, so the two above are generic examples rather than multiples of it.</i>');
  }
  L.push('', '<i>k = thousand · m = million · b = billion · $ and commas are fine.</i>');
  if (!up) L.push('<i>Fires at 🚀 Turbo gas so it lands during a dump — change it under 📋 Orders.</i>');
  return L.join('\n');
}

const DS_SLUG = { robinhood: 'robinhood', ethereum: 'ethereum', base: 'base', bsc: 'bsc', arbitrum: 'arbitrum', solana: 'solana' };
const chartUrl = (chainKey, ca) => DS_SLUG[chainKey] ? `https://dexscreener.com/${DS_SLUG[chainKey]}/${ca}` : `https://dexscreener.com/search?q=${ca}`;
const expTokenUrl = (chainKey, ca) => { const c = core.chainOf(chainKey); return c ? `${c.explorer}/token/${ca}` : ''; };

// Maestro-style chain auto-detect: figure out which enabled chain a pasted CA
// lives on so the user never has to switch chains to trade. base58 → Solana;
// 0x → probe every enabled EVM chain for contract code in parallel (bounded).
// Prefers the ACTIVE chain when the same address is a contract on several
// chains (common for multi-chain deployments). Returns { chain } on a unique
// hit, { choices } when ambiguous, {} when nothing was found (caller falls
// back to the active chain, which keeps the old behavior for edge cases).
async function detectChain(chatId, ca) {
  if (!isEvmCa(ca)) {
    const sol = core.chains.enabledChains().find((c) => core.chains.isSvm(c.key));
    return sol ? { chain: sol.key } : {};
  }
  const evm = core.chains.enabledChains().filter((c) => !core.chains.isSvm(c.key));
  const hits = (await Promise.all(evm.map(async (c) => {
    const code = await withTmo(core.providerFor(c.key).getCode(ca).catch(() => null), 4000, null);
    return (code && code !== '0x') ? c.key : null;
  }))).filter(Boolean);
  const active = core.userChain(core.ensureUser(chatId));
  if (hits.includes(active)) return { chain: active };
  if (hits.length === 1) return { chain: hits[0] };
  if (hits.length > 1) return { choices: hits };
  return {};
}

// ------------------------------------------------------------ screens
function mainMenu() {
  return rows(
    [btn('💼 Wallets', 'wal'), btn('📊 Portfolio', 'pos'), btn('🧾 History', 'hist')],
    [btn('🌐 Chain', 'chain'), btn('🎯 Snipe', 'snipe'), btn('📋 Orders', 'orders')],
    [btn('🔔 Alerts', 'alerts'), btn('👥 Copy', 'copy'), btn('🎁 Referrals', 'ref')],
    [btn('⚙️ Settings', 'set'), btn('❔ Help', 'help')],
  );
}
// The Wallet menu is an ALL-WALLETS dashboard (Maestro-style): every wallet with its
// name, live balance and full address on one screen — tap a name to switch, ✏️ rename,
// 📥 deposit QR, 🗑 remove. Export/Withdraw act on the ✅ active wallet.
// USD value of each wallet's TOKEN holdings (bags), so the wallet total reflects the full
// portfolio, not just native coin. Uses the bot-tracked bag size (p.tokens — no per-token
// RPC) and prices each distinct token ONCE (deduped, cached 30s, bounded + timed out), so
// it stays fast. Returns a per-wallet USD array aligned to `list`.
async function walletTokenUsd(list, enabledKeys) {
  const distinct = new Map();               // 'chain:caLower' -> { chain, ca }
  const bags = list.map(() => []);          // per wallet: [{ ck, tokens, native }]
  list.forEach((w, wi) => {
    for (const key of Object.keys(w.positions || {})) {
      const p = w.positions[key];
      if (!p || p.closed || !enabledKeys.has(p.chain)) continue;
      let raw = 0n; try { raw = BigInt(p.tokens || '0'); } catch (_) { continue; }
      if (raw <= 0n) continue;
      const tokens = Number(ethers.formatUnits(raw, p.dec || 18));
      if (!(tokens > 0)) continue;
      const ck = p.chain + ':' + String(p.ca).toLowerCase();
      distinct.set(ck, { chain: p.chain, ca: p.ca });
      bags[wi].push({ ck, tokens, native: (core.chainOf(p.chain) || {}).native || 'ETH' });
    }
  });
  if (!distinct.size) return list.map(() => 0);
  const now = Date.now();
  const stale = [...distinct.entries()].filter(([ck]) => { const h = _priceCache.get(ck); return !(h && now - h.at < 30000); });
  await Promise.all(stale.map(([ck, { chain, ca }]) =>
    withTmo(core.tokenSnapshot(ca, chain).catch(() => null), 4000, null)
      .then((snap) => { _priceCache.set(ck, { priceEth: (snap && snap.priceEth > 0) ? snap.priceEth : 0, at: Date.now() }); })));
  if (_priceCache.size > 5000) { const first = _priceCache.keys().next().value; _priceCache.delete(first); }
  return bags.map((wb) => wb.reduce((sum, b) => {
    const h = _priceCache.get(b.ck); const priceEth = h ? h.priceEth : 0;
    return sum + b.tokens * priceEth * nativeUsd(b.native);
  }, 0));
}
async function walletScreen(chatId) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(core.userChain(u));
  const list = core.walletList(u);
  // Maestro-style: EVERY wallet × EVERY enabled chain, fetched in parallel (one
  // EVM key = same 0x address everywhere, Solana has its own), so a deposit on
  // ANY chain shows up in the totals — never just the active chain. A chain
  // whose RPC doesn't answer in time is null → '—', not a misleading 0.
  const allChains = core.chains.enabledChains();
  const awIdx = Math.max(0, list.findIndex((w) => w.id === u.activeWalletId));
  // STRICT reads: core.ethBalance swallows EVM RPC errors into 0n, which made a
  // dead RPC render as "0 ETH" (looked like an untracked deposit). Read the
  // provider directly with one retry; a chain that still fails is null → '—'.
  const readNative = async (w, c) => {
    const addr = wAddr(w, c.key);
    if (core.chains.isSvm(c.key)) return core.ethBalance(addr, c.key);   // svm errors already bubble
    const prov = core.providerFor(c.key);
    try { return await prov.getBalance(addr); } catch (_) { return prov.getBalance(addr); }
  };
  const rawMatrix = await Promise.all(list.map((w) =>
    Promise.all(allChains.map((c) => withTmo(readNative(w, c).catch(() => null), 6000, null)))));
  // Resolve each cell: a successful read (incl. a real 0) updates the last-known cache; a
  // FAILED read (null, e.g. RPC timeout) falls back to the last-known balance (≤10 min) so
  // the grand total stays stable and accurate instead of silently undercounting.
  const nowMs = Date.now();
  const matrix = list.map((w, wi) => allChains.map((c, ci) => {
    const key = w.id + ':' + c.key;
    const live = rawMatrix[wi][ci];
    if (live != null) { _balCache.set(key, { raw: live, at: nowMs }); return live; }
    const hit = _balCache.get(key);
    return (hit && (nowMs - hit.at) < 600000) ? hit.raw : null;
  }));
  if (_balCache.size > 5000) { const first = _balCache.keys().next().value; _balCache.delete(first); }
  // Per-wallet USD total across chains + the grand total over all wallets.
  const usdOfRow = (row) => row.reduce((sum, b, i) => {
    if (b == null) return sum;
    return sum + Number(fmtNat(b, allChains[i].key)) * nativeUsd(allChains[i].native);
  }, 0);
  const nativeUsdArr = matrix.map(usdOfRow);
  // Include TOKEN holdings so each wallet's total is the full portfolio value, not just
  // native coin (why "Wallet 4" reads $292 native but ~$1.3k with its bags).
  const tokenUsdArr = await walletTokenUsd(list, new Set(allChains.map((c) => c.key)));
  const walletUsd = nativeUsdArr.map((v, i) => v + (tokenUsdArr[i] || 0));
  const grandUsd = walletUsd.reduce((a, b) => a + b, 0);
  const grandNative = nativeUsdArr.reduce((a, b) => a + b, 0);
  const grandToken = tokenUsdArr.reduce((a, b) => a + b, 0);
  const anyFunds = grandToken > 0.05 || matrix.some((row) => row.some((b, i) => b != null && Number(fmtNat(b, allChains[i].key)) > 0));
  // Active wallet's per-chain breakdown block.
  let chainBlock = '';
  allChains.forEach((c, i) => {
    const b = (matrix[awIdx] || [])[i];
    if (b == null) { chainBlock += `${c.emoji} ${esc(c.name)}: —\n`; return; }
    const amt = Number(fmtNat(b, c.key));
    const usdV = nativeUsd(c.native) * amt;
    chainBlock += `${c.emoji} ${esc(c.name)}: <b>${amt > 0 ? amt.toFixed(4) : '0'} ${c.native}</b>${usdV > 0.005 ? ` ($${fmt(usdV)})` : ''}\n`;
  });
  // One EVM key = one 0x address shared by every EVM chain; Solana has its own key.
  // Show BOTH addresses per wallet so it's obvious where to deposit each.
  const evmChain = allChains.find((c) => !core.chains.isSvm(c.key)) || allChains[0];
  const solChain = allChains.find((c) => core.chains.isSvm(c.key));
  const evmNames = allChains.filter((c) => !core.chains.isSvm(c.key)).map((c) => c.name).join(' · ');
  let body = '';
  const kbRows = [];
  list.forEach((w, i) => {
    const active = i === awIdx;
    const label = core.walletLabel(w, i + 1);
    const nOrders = (w.orders && w.orders.length) || 0;
    body += `${active ? '✅' : '▫️'} <b>${esc(label)}</b>${active ? ' <i>· active</i>' : ''} · <b>≈ $${fmt(walletUsd[i])}</b> total${nOrders ? ' · ' + nOrders + ' order' + (nOrders > 1 ? 's' : '') : ''}\n`;
    if ((tokenUsdArr[i] || 0) > 0.05) body += `    <i>native $${fmt(nativeUsdArr[i])} · tokens $${fmt(tokenUsdArr[i])}</i>\n`;
    body += `🔗 <b>EVM address</b> <i>(${esc(evmNames)})</i>\n<code>${wAddr(w, evmChain.key)}</code>\n`;
    if (solChain) body += `🟣 <b>Solana address</b>\n<code>${wAddr(w, solChain.key)}</code>\n`;
    body += `\n`;
    const row = [btn(`${active ? '✓ ' : '⚪ '}${label}`.slice(0, 26), active ? 'wal' : 'sw:' + w.id), btn('✏️', 'rnw:' + w.id), btn('📥', 'qrw:' + w.id)];
    if (list.length > 1) row.push(btn('🗑', 'rmw:' + w.id));
    kbRows.push(row);
  });
  if (list.length < core.WALLET_CAP) kbRows.push([btn('➕ Generate wallet', 'neww'), btn('📩 Import', 'imp')]);
  kbRows.push([btn('🔑 Export (active)', 'exp'), btn('📤 Withdraw (active)', 'wd')]);
  kbRows.push([btn('🌐 Chain', 'chain'), btn('🔄 Refresh', 'wal'), btn('« Menu', 'menu')]);
  const head = `💼 <b>Your Wallets</b> · ${ch.emoji} ${esc(ch.name)}\n${list.length}/${core.WALLET_CAP} wallets · total <b>≈ $${fmt(grandUsd)}</b>${grandToken > 0.05 ? ` <i>(native $${fmt(grandNative)} · tokens $${fmt(grandToken)})</i>` : ''}\n\n`
    + `🌐 <b>${esc(core.walletLabel(list[awIdx], awIdx + 1))}</b>${walletUsd[awIdx] > 0.005 ? ` · ≈ $${fmt(walletUsd[awIdx])}` : ''}\n${chainBlock}${(tokenUsdArr[awIdx] || 0) > 0.05 ? `🪙 Tokens (bags): <b>$${fmt(tokenUsdArr[awIdx])}</b>\n` : ''}\n`;
  const guide = !anyFunds
    ? `<b>Start in 3 steps 👇</b>\n1️⃣ Deposit ${ch.native} to a wallet — tap <b>📥</b> on it for the address/QR.\n2️⃣ Tap <b>🔄 Refresh</b> to see it land.\n3️⃣ Paste any token contract → live card → one-tap buy.\n\n<i>Tap a name to switch · ✏️ rename · 📥 deposit · 🗑 remove. One key per wallet on every chain — EVM shares one 0x address, Solana has its own (switch with 🌐).</i>`
    : `<i>Tap a wallet to switch · ✏️ rename · 📥 deposit · 🗑 remove. Paste any token address to trade.</i>`;
  return { text: head + body + guide, kb: { inline_keyboard: kbRows } };
}
// Maestro-style deposit: a QR of the address + the address text. Works for any wallet
// (not just the active one). Degrades to a plain text address if QR is disabled/fails.
async function depositScreen(chatId, w) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(core.userChain(u));
  const idx = core.walletList(u).findIndex((x) => x.id === w.id) + 1;
  const label = core.walletLabel(w, idx);
  const addr = wAddr(w, ch.key);
  const sameNote = core.chains.isSvm(ch.key) ? 'This is your Solana address (different from your EVM one).' : 'Shared across every EVM chain.';
  const caption = `📥 <b>Deposit ${ch.native}</b> · ${esc(label)}\n${ch.emoji} <b>${esc(ch.name)}</b>\n\n<code>${addr}</code>\n\nScan the QR or copy the address. ${sameNote} Switch with 🌐 to deposit elsewhere. Then paste a token contract to buy.`;
  const kb = rows([btn('🔄 Refresh balance', 'wal'), btn('🌐 Chain', 'chain')], [btn('👛 Wallets', 'wallets'), btn('« Menu', 'menu')]);
  const url = qrUrl(addr);
  if (url) { const r = await sendPhoto(chatId, url, caption, kb).catch(() => null); if (r && r.ok) return r; }
  return send(chatId, caption, kb);   // QR disabled/failed → text address (still fully usable)
}
// 'Wallets' and 'Wallet' now open the SAME all-wallets dashboard.
async function walletsScreen(chatId) { return walletScreen(chatId); }
function chainScreen(chatId) {
  const cur = core.userChain(core.ensureUser(chatId));
  const list = core.chains.enabledChains();
  const kb = list.map((c) => [btn(`${c.emoji} ${c.name}${c.key === cur ? '  ✓' : ''}`, 'setch:' + c.key)]);
  kb.push([btn('« Menu', 'menu')]);
  return { text: `🌐 <b>Select chain</b>\n\nYour wallet is the same address on all of them, and pasting a CA <b>auto-detects its chain</b> — this only sets the default for deposits, snipes and quick commands:`, kb: { inline_keyboard: kb } };
}
// `opts.multi` opens the wallet toggles INLINE on the card (Maestro's 🟢 Multi
// panel) instead of pushing the user to a separate screen — the price, liquidity
// and per-wallet bags stay on screen while you choose which wallets to trade.
async function tokenCard(chatId, ca, chainKey, walletId, opts) {
  const u = core.ensureUser(chatId);
  const multiOpen = !!(opts && opts.multi);
  chainKey = (chainKey && core.chainOf(chainKey)) ? chainKey : core.userChain(u);
  const ch = core.chainOf(chainKey);
  const list = core.walletList(u);
  const explicit = (walletId && core.walletById(u, walletId)) || null;
  // Rich scan: on-chain price/mcap + liquidity + launchpad API (vol/socials) + GoPlus
  // (tax/honeypot/holders/LP) — all best-effort, never throws (tokeninfo swallows).
  const info = await tokeninfo.enrich(ca, chainKey).catch(() => null);
  if (!info) return { text: `❌ Couldn't price <code>${short(ca)}</code> on ${ch.emoji} ${esc(ch.name)} — no pool/curve found here. Switch chain if it trades elsewhere.`, kb: rows([btn('🌐 Switch chain', 'chain'), btn('« Menu', 'menu')]) };
  const meta = await core.tokenMeta(ca, chainKey);
  // Maestro-style: this token's balance across EVERY wallet (live on-chain). Bind the
  // card to the wallet that actually HOLDS the token so Buy/Sell act on the right one —
  // this is what fixes "Sell failed: token balance is 0" when the bag sits on another
  // wallet than the active one. Explicitly-opened cards keep their wallet.
  const across = await core.tokenAcrossWallets(chatId, ca, chainKey, meta.decimals);
  const w = explicit || (across.holderId && core.walletById(u, across.holderId)) || core.activeWallet(u);
  const wi = list.findIndex((x) => x.id === w.id) + 1;   // 1-based wallet index, encoded in every action
  const myRow = across.rows.find((r) => r.id === w.id);
  const autoSwitched = !explicit && !!myRow && !myRow.active && (myRow.tokens > 1e-9);
  const balRaw = myRow ? myRow.raw : await core.tokenBalance(ca, wAddr(w, chainKey), chainKey);
  const bal = myRow ? myRow.tokens : Number(ethers.formatUnits(balRaw, meta.decimals));
  const pos = (w.positions || {})[core.posKey(chainKey, ca)];
  const nat = ch.native;
  const api = info.api, sec = info.security;
  const px = info.priceEth || 0;
  const priceUsd = px * nativeUsd(nat);
  const name = (api && api.name) || meta.name;
  const sym = (api && api.symbol) || meta.sym;

  const L = [];
  // A blank line between blocks, not a drawn rule. Rules add a line of noise per
  // section; whitespace does the same grouping and lets the eye land on the
  // numbers. Nothing in the card may run more than four lines without a break.
  const gap = () => { if (L.length && L[L.length - 1] !== '') L.push(''); };
  // ── Header: name · symbol, then chain · venue · age, then the contract ──
  // Age sits here rather than buried in a stats line: "6 minutes old" changes how
  // you read every number under it, so it belongs beside the name.
  const mkt = info.market;
  const created = (api && api.createdAt) || (mkt && mkt.createdAt);
  const statusBadge = info.dex ? `◆ DEX${info.dexVenue === 'v3' ? ' · V3 pool' : ''}` : (info.graduated ? '◆ Graduated' : `◈ Bonding curve · ${(info.progressPct || 0).toFixed(0)}%`);
  L.push(`<b>${esc(name)}</b> · <b>$${esc(sym)}</b>`);
  L.push(`${ch.emoji} ${esc(ch.name)}  ·  ${statusBadge}${created ? `  ·  ${fmtAge(created)} old` : ''}`);
  L.push(`<code>${ca}</code>`);
  if (sec) { const v = safety.verdict(chainKey, sec); if (v.level === 'danger') L.push(`🚨 <b>HIGH RISK</b> — ${esc(v.red.join(', '))}`); else if (v.level === 'warn') L.push(`⚠️ <b>Caution</b> — ${esc(v.warn.join(', '))}`); }
  // ── Market ─────────────────────────────────────────────────────────────────
  // Every value is labelled and every line leads with what it is. The old card
  // printed bare fragments — "LP burned" alone on a line, "Liq 0.02 ETH" with
  // nothing to compare it against — and silently DROPPED whole lines when a
  // source returned nothing, so a chain with no indexer rendered three lines and
  // read like a broken card rather than a thin token.
  gap();
  const mcapUsd = (api && api.marketCapUsd) || (info.mcapEth * nativeUsd(nat));
  const priceStr = priceUsd > 0 ? '$' + priceUsd.toPrecision(3) : px.toExponential(2) + ' ' + nat;
  const mcapStr = mcapUsd > 0 ? '$' + fmt(mcapUsd) : usd(info.mcapEth, nat);
  L.push(`💵 <b>Price</b> ${priceStr}   ·   🌍 <b>Mcap</b> ${mcapStr}`);
  // Liquidity carries the number that actually answers "can I get out again":
  // how it compares to the market cap. $36 of liquidity under a $2.59K cap is the
  // whole story of a token, and the card used to leave the reader to divide it.
  if (info.liquidityNative != null) {
    const liqUsd = info.liquidityNative * nativeUsd(nat);
    const pctOfCap = mcapUsd > 0 && liqUsd > 0 ? (liqUsd / mcapUsd) * 100 : 0;
    const share = pctOfCap > 0 ? `   ·   <b>${pctOfCap < 0.1 ? '<0.1' : pctOfCap.toFixed(1)}%</b> of mcap` : '';
    // Decimals that match the magnitude: 0.020 ETH and 210.4 ETH both want to be
    // read at a glance, and one fixed precision cannot do both.
    const q = info.liquidityNative;
    const qStr = q < 1 ? q.toFixed(3) : q < 100 ? q.toFixed(2) : q.toFixed(1);
    L.push(`💧 <b>Liquidity</b> ${qStr} ${nat} (${usd(info.liquidityNative, nat)})${share}`);
  } else if (info.raised != null) {
    const pct = info.target > 0 ? (info.raised / info.target) * 100 : 0;
    L.push(`🚀 <b>Raised</b> ${info.raised.toFixed(2)} / ${(info.target || 0).toFixed(1)} ${nat}   ·   <b>${pct.toFixed(0)}%</b> to graduation`);
  }
  // Thin-pool warning: indexer sees far deeper liquidity than the pool the bot can trade.
  if (info.liquidityNative != null && mkt && mkt.liqUsd > 0) {
    const poolUsd = info.liquidityNative * nativeUsd(nat);
    // Its own block: a warning buried between two stat lines is read as a stat.
    if (mkt.liqUsd > Math.max(poolUsd, 1) * 5) { gap(); L.push(`⚠️ <b>Thin tradeable pool</b> — the market's <b>$${fmt(mkt.liqUsd)}</b> sits on a pool this bot can't reach. Buys here move the price hard.`); gap(); }
  }
  if (mkt) {
    const chg = (v) => (v == null ? null : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`);
    const c1 = chg(mkt.chgH1), c24 = chg(mkt.chgH24);
    // An arrow makes the direction readable before the number is: a wall of
    // percentages is what people skim past.
    const arrow = (v) => (v == null ? '' : (v >= 0 ? '🟢 ' : '🔴 '));
    const parts = [];
    if (c1 != null) parts.push(`1h ${arrow(mkt.chgH1)}${c1}`);
    if (c24 != null) parts.push(`24h ${arrow(mkt.chgH24)}${c24}`);
    if (parts.length) L.push(`📈 <b>Change</b> ${parts.join('   ·   ')}`);
  }
  const vol24 = (api && api.volume && api.volume.h24Usd != null) ? api.volume.h24Usd : (mkt && mkt.volH24Usd != null ? mkt.volH24Usd : null);
  const volParts = [];
  if (vol24 != null) volParts.push(`$${fmt(vol24)}`);
  if (mkt && (mkt.buysH24 != null || mkt.sellsH24 != null)) volParts.push(`${mkt.buysH24 || 0} buys / ${mkt.sellsH24 || 0} sells`);
  if (volParts.length) L.push(`🔄 <b>Vol 24h</b> ${volParts.join('   ·   ')}`);
  // Safety, in its own block: holders and LP on one line, tax and flags on the
  // next. Three long labels joined on a single line wrap on a phone, and a
  // wrapped line reads as two lines that lost their bullet.
  const holdLp = [];
  if (sec && sec.holders != null) holdLp.push(`👥 ${sec.holders} holders`);
  if (sec && sec.lpLockedPct != null) holdLp.push(`🔒 LP ${Math.round(sec.lpLockedPct)}% locked`);
  else if (ch.curve && info.graduated) holdLp.push('🔒 LP burned');
  const flags = [];
  if (sec) flags.push(`⚖️ Tax ${taxStr(sec.buyTaxPct)} buy / ${taxStr(sec.sellTaxPct)} sell`);
  else if (ch.curve) flags.push('⚖️ Fair launch · 0% tax');   // launchpad tokens can't set a tax
  if (sec && sec.honeypot) flags.push('🚨 HONEYPOT');
  if (sec && sec.openSource === false) flags.push('⚠️ closed-source');
  if (holdLp.length || flags.length) gap();
  if (holdLp.length) L.push(holdLp.join('   ·   '));
  if (flags.length) L.push(flags.join('   ·   '));
  // What a trade costs, which the card could never answer. On a cheap L2 "about
  // four cents" is often what decides whether a small buy is worth making.
  if (info.gas && info.gas.gwei > 0) {
    const feeUsd = info.gas.feeNative * nativeUsd(nat);
    const feeStr = feeUsd > 0 ? ` · ≈<b>$${feeUsd < 0.01 ? feeUsd.toFixed(4) : feeUsd.toFixed(2)}</b> per trade` : '';
    L.push(`⛽ <b>Gas</b> ${info.gas.gwei < 1 ? info.gas.gwei.toFixed(3) : info.gas.gwei.toFixed(1)} gwei${feeStr}`);
  }
  // Say what is missing instead of just omitting the lines. A card that shrinks
  // to three lines on a chain with no indexer looks broken; saying so once tells
  // the reader the numbers above are still real, and read straight from chain.
  gap();
  const gaps = [];
  if (!mkt) gaps.push('volume', 'price change');
  if (!sec) { gaps.push('holder count'); if (!ch.curve) gaps.push('tax'); }
  if (gaps.length) {
    const listed = gaps.length > 1 ? `${gaps.slice(0, -1).join(', ')} and ${gaps[gaps.length - 1]}` : gaps[0];
    L.push(`ℹ️ <i>No indexer covers ${esc(ch.name)} yet — ${listed} unavailable. The prices above are read straight from the chain.</i>`);
  }
  // Maestro's own card shows a timestamp because its numbers can be minutes old.
  // Ours are fetched on render — saying so is what makes a stale-looking price
  // trustworthy, and points at the button that refetches it.
  L.push(`🕐 <i>Updated ${new Date().toISOString().slice(11, 19)} UTC · tap 🔄 Refresh for a new read</i>`);
  if (api && api.links) { const lk = []; if (api.links.website) lk.push(`<a href="${esc(api.links.website)}">Web</a>`); if (api.links.twitter) lk.push(`<a href="${esc(api.links.twitter)}">X</a>`); if (api.links.telegram) lk.push(`<a href="${esc(api.links.telegram)}">TG</a>`); if (lk.length) L.push(`🔗 ${lk.join(' · ')}`); }
  const valueEth = bal * px;
  const sel = core.tradeSelection(chatId);
  const selIds = new Set(core.tradeWalletIds(chatId));
  const selN = selIds.size;
  const usdOf = (tokens) => (priceUsd > 0 ? '$' + fmt(tokens * priceUsd) : '—');   // USD worth of a token bag
  if (list.length > 1) {
    // Per-wallet balance table (Maestro "Balance" panel): ✅ marks the wallet(s) a
    // Buy/Sell will act on (single, a selected subset, or ALL). Shows each bag's USD worth.
    gap();
    L.push(`👛 <b>Balance across wallets</b> (${esc(sym)} · USD · ${nat})`);
    const held = across.rows.filter((r) => r.tokens > 1e-9 || r.eth > 1e-5);
    const show = (held.length ? held : across.rows).slice(0, 10);
    for (const r of show) {
      const on = selN ? selIds.has(r.id) : (r.id === w.id);
      const mark = on ? '✅' : (r.active ? '▫️' : '▪️');
      const pctStr = r.pctSupply >= 0.01 ? ` (${r.pctSupply.toFixed(2)}%)` : '';
      L.push(`${mark} ${esc(r.label)} · <b>${fmt(r.tokens)}</b>${pctStr} · <b>${usdOf(r.tokens)}</b> · ${r.eth.toFixed(4)} ${nat}`);
    }
    const totTok = across.rows.reduce((s, r) => s + r.tokens, 0);
    const totEth = across.rows.reduce((s, r) => s + r.eth, 0);
    if (totTok > 1e-9) L.push(`Σ <b>${fmt(totTok)} $${esc(sym)}</b> ≈ <b>${usdOf(totTok)}</b> · ${totEth.toFixed(4)} ${nat} across ${across.rows.length} wallets`);
    if (pos && posCost(pos) > 0 && !selN) { const cb = posCost(pos); const unreal = valueEth - cb; const pct = cb > 0 ? (unreal / cb) * 100 : 0; L.push(`PnL (${esc(core.walletLabel(w, wi))}): <b>${unreal >= 0 ? '+' : ''}${unreal.toFixed(4)} ${nat}</b> · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`); }
    gap();
    if (sel.all) L.push(`<i>Trading all ${list.length} wallets — every Buy runs on each one.</i>`);
    else if (selN >= 1) L.push(`<i>Trading ${selN} selected wallet${selN > 1 ? 's' : ''} — every Buy runs on each one.</i>`);
    else L.push(`<i>Trading ${esc(core.walletLabel(w, wi))}${autoSwitched ? ' (holds this token)' : ''} — tap 🔴 Multi to use several at once.</i>`);
  } else {
    // Single wallet: ALWAYS show the bag (even "none") and the wallet's native
    // balance, so the card answers "what do I hold and what can I spend" at a glance.
    gap();
    if (pos && posCost(pos) > 0) { const cb = posCost(pos); const unreal = valueEth - cb; const pct = cb > 0 ? (unreal / cb) * 100 : 0; L.push(`Your bag: <b>${fmt(bal)} $${esc(sym)}</b> · ${usd(valueEth, nat)} · PnL <b>${unreal >= 0 ? '+' : ''}${unreal.toFixed(4)} ${nat}</b> (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`); }
    else if (bal > 0) L.push(`Your bag: <b>${fmt(bal)} $${esc(sym)}</b> · ${usd(valueEth, nat)}`);
    else L.push(`Your bag: <i>none yet</i>`);
    if (myRow && myRow.eth != null) L.push(`Wallet ${esc(core.walletLabel(w, wi))}: <b>${myRow.eth.toFixed(4)} ${nat}</b> available (${usd(myRow.eth, nat)})`);
  }
  const text = L.join('\n');
  // Encode the card's chain AND wallet index in every action, so a tap on a stale
  // card trades on the chain+wallet it was rendered for — never on whatever chain
  // or wallet merely happens to be active now.
  const bp = core.buyPresets(u, chainKey);   // per-chain (or global) quick-buy amounts (Settings)
  // NOTE: the buy callback below `b:${chainKey}:${wi}:${ca}:${amt}` must stay ≤64 bytes
  // (Telegram limit). Worst case ≈ 64 with chain "robinhood", wi≤99, 42-char ca, and a
  // 6-char preset (capped in setBuyPresets). Keep those caps if you touch this.
  const lastRow = [btn('🔁 DCA', `dca:${chainKey}:${wi}:${ca}`), btn('🔔 Alert', `alt:${chainKey}:${wi}:${ca}`), btn('🔄 Refresh', `tok:${chainKey}:${wi}:${ca}`), btn('« Menu', 'menu')];
  if (safety.supported(chainKey)) lastRow.unshift(btn('🛡 Safety', `sec:${chainKey}:${ca}`));   // GoPlus (EVM) / RugCheck (Solana)
  // Multi-wallet: one row when closed, the toggle grid below it when open.
  // NOTE the 64-byte callback limit again — worst case here is
  // `wtc:robinhood:99:<42-char ca>:10` = 62 bytes. Adding a field overflows it.
  const selLabel = sel.all ? `👛 Trading: ALL ${list.length} wallets` : (selN >= 1 ? `👛 Trading: ${selN} wallet${selN > 1 ? 's' : ''}` : `👛 Trade from: ${core.walletLabel(w, wi)}`);
  const walletRow = [];
  if (list.length > 1) {
    const multiLabel = selN > 1 ? `🟢 Multi | ${sel.all ? 'ALL' : selN}` : '🔴 Multi';
    walletRow.push([btn(selLabel, `wsel:${chainKey}:${ca}`), btn(multiLabel, `${multiOpen ? 'wex0' : 'wex1'}:${chainKey}:${wi}:${ca}`)]);
    if (multiOpen) {
      // Two per row: the dot is what a wallet DOES on the next Buy/Sell, so in
      // single mode the card's own wallet is already lit — it is the one trading.
      for (let i = 0; i < list.length; i += 2) {
        walletRow.push(list.slice(i, i + 2).map((wobj, j) => {
          const n = i + j + 1;
          const on = selN ? selIds.has(wobj.id) : wobj.id === w.id;
          return btn(`${on ? '🟢' : '🔴'} ${core.walletLabel(wobj, n)}`, `wtc:${chainKey}:${wi}:${ca}:${n}`);
        }));
      }
      walletRow.push([btn('🟢 All ON', `wtcA:${chainKey}:${wi}:${ca}`), btn('🔴 All OFF', `wtcN:${chainKey}:${wi}:${ca}`)]);
    }
  }
  const ikb = [
    ...walletRow,
    [btn(`Buy ${bp[0]}`, `b:${chainKey}:${wi}:${ca}:${bp[0]}`), btn(`Buy ${bp[1]}`, `b:${chainKey}:${wi}:${ca}:${bp[1]}`), btn(`Buy ${bp[2]}`, `b:${chainKey}:${wi}:${ca}:${bp[2]}`), btn('Buy X', `bx:${chainKey}:${wi}:${ca}`)],
    [btn('Sell 25%', `s:${chainKey}:${wi}:${ca}:25`), btn('Sell 50%', `s:${chainKey}:${wi}:${ca}:50`), btn('Sell 75%', `s:${chainKey}:${wi}:${ca}:75`), btn('Sell 100%', `s:${chainKey}:${wi}:${ca}:100`)],
    [btn('🔻 Sell other %', `sx:${chainKey}:${wi}:${ca}`), btn('⏳ Limit buy', `lb:${chainKey}:${wi}:${ca}`)],
    // "TP" and "SL" are what a trading desk calls these. Someone looking for the
    // feature they read about as a stop-loss does not scan a cramped row of five
    // and recognise "🛑 SL" as it.
    [btn('🎯 Limit sell', `tp:${chainKey}:${wi}:${ca}`), btn('🛑 Stop-loss', `sl:${chainKey}:${wi}:${ca}`), btn('📉 Trailing', `trl:${chainKey}:${wi}:${ca}`)],
  ];
  // Offer "send this token out" only when the bound wallet actually holds a bag.
  if (bal > 1e-9) ikb.push([btn(`📤 Send $${esc(sym)}`, `wt:${chainKey}:${wi}:${ca}`)]);
  ikb.push([{ text: '📈 Chart', url: chartUrl(chainKey, ca) }, btn('📍 Monitor', `monn:${chainKey}:${wi}:${ca}`), { text: '🔎 Explorer', url: expTokenUrl(chainKey, ca) }]);
  ikb.push(lastRow);
  return { text, kb: { inline_keyboard: ikb } };
}
// Multi-wallet trade picker (Maestro style): choose one / several / ALL wallets that
// every Buy / Sell tap acts on. Shows each wallet's live balance of THIS token so the
// choice is informed. Opened from the 👛 row on a token card.
async function walletPickScreen(chatId, ca, chainKey) {
  const u = core.ensureUser(chatId);
  chainKey = (chainKey && core.chainOf(chainKey)) ? chainKey : core.userChain(u);
  const ch = core.chainOf(chainKey);
  const list = core.walletList(u);
  const across = await core.tokenAcrossWallets(chatId, ca, chainKey, 18).catch(() => ({ rows: [] }));
  const sel = core.tradeSelection(chatId);
  const selIds = new Set(core.tradeWalletIds(chatId));
  const kbRows = [];
  list.forEach((wobj, i) => {
    const r = (across.rows || []).find((x) => x.id === wobj.id) || { tokens: 0, eth: 0 };
    const on = selIds.size ? selIds.has(wobj.id) : false;   // default (none selected) = single card wallet
    kbRows.push([btn(`${on ? '✅' : '⬜'} ${core.walletLabel(wobj, i + 1)} · ${fmt(r.tokens)} · ${(r.eth || 0).toFixed(3)} ${ch.native}`, `wtg:${chainKey}:${i + 1}:${ca}`)]);
  });
  kbRows.push([btn(sel.all ? '✅ ALL wallets ON' : '☑️ Select ALL', `wtgA:${chainKey}:${ca}`), btn('⬜ Clear', `wtgN:${chainKey}:${ca}`)]);
  kbRows.push([btn('✔ Done', `tok:${chainKey}::${ca}`)]);   // empty wi → card auto-binds to the holder
  const mode = sel.all ? `ALL ${list.length} wallets` : (selIds.size ? `${selIds.size} wallet${selIds.size > 1 ? 's' : ''}` : 'single (the card wallet)');
  return {
    text: `👛 <b>Trade wallets</b> · ${ch.emoji} ${esc(ch.name)}\n\nPick which wallets every <b>Buy / Sell</b> acts on. Now: <b>${mode}</b>.\n\n<i>Buy spends the amount on EACH selected wallet (total = amount × wallets). Sell sells that % of each wallet's own bag; wallets with no bag are skipped.</i>`,
    kb: { inline_keyboard: kbRows },
  };
}
/** The 📍 Monitor picker. /monitor used to be nothing at all — not a registered
 *  command and not a handler — so typing it fell through to "I didn't recognise
 *  that". The live tracker existed but was reachable only from a button on a
 *  token card, which is exactly where someone who already bought is NOT looking.
 *  This lists what you actually hold and opens a tracker on any of it. */
async function monitorListScreen(chatId) {
  const pf = await core.portfolioAll(chatId);
  const nat = pf.native || 'ETH';
  const open = pf.rows.filter((r) => r.open);
  const wi = walletIndex(chatId);
  if (!open.length) {
    return { text: `📍 <b>Live monitor</b> · ${pf.chain ? pf.chain.emoji + ' ' + esc(pf.chain.name) : ''}\n\nYou hold nothing on this chain right now, so there is nothing to track. Buy a token and the monitor opens itself.`,
      kb: rows([btn('📊 Portfolio', 'pos'), btn('🌐 Chain', 'chain'), btn('« Menu', 'menu')]) };
  }
  const rate = nativeUsd(nat);
  const L = [`📍 <b>Live monitor</b> · ${pf.chain.emoji} ${esc(pf.chain.name)}\n`,
    'Pick a position to track. The card pins itself and refreshes on its own, across every wallet holding it.\n'];
  const kb = [];
  for (const r of open.slice(0, MON_LIST_ROWS)) {
    const usdStr = rate > 0 ? ` ($${(r.valueEth * rate).toFixed(2)})` : '';
    const n = (r.holders || []).length;
    L.push(`<b>$${esc(r.sym)}</b> · ${r.valueEth.toFixed(4)} ${nat}${usdStr}${n > 1 ? ` · ${n} wallets` : ''}`);
    kb.push([btn(`📍 ${r.sym}`, `monn:${pf.chain.key}:${wi}:${r.ca}`)]);
  }
  if (open.length > MON_LIST_ROWS) L.push(`<i>…and ${open.length - MON_LIST_ROWS} more — see 📊 Portfolio</i>`);
  kb.push([btn('📊 Portfolio', 'pos'), btn('« Menu', 'menu')]);
  return { text: L.join('\n'), kb: { inline_keyboard: kb } };
}

async function portfolioScreen(chatId) {
  const pf = await core.portfolioAll(chatId);   // aggregated across ALL wallets (Maestro style)
  const nat = pf.native || 'ETH';
  const rate = nativeUsd(nat);
  // Every native figure gets its USD twin. "PnL -0.0001" is not a number anyone
  // can act on; "-0.0001 ETH (-$0.19)" is.
  const both = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(4)} ${nat}${rate > 0 ? ` (${v >= 0 ? '+' : '−'}$${Math.abs(v * rate).toFixed(2)})` : ''}`;
  const money = (v) => `${v.toFixed(4)} ${nat}${rate > 0 ? ` ($${(v * rate).toFixed(2)})` : ''}`;
  // Same minus sign as both() — toFixed() emits an ASCII hyphen, so mixing the
  // two put "−0.0005 ETH" and "-13.5%" on one line.
  const pctStr = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
  const dot = (v) => (v >= 0 ? '🟢' : '🔴');
  if (!pf.rows.length) {
    return { text: `📊 <b>Portfolio</b> · ${pf.chain ? pf.chain.emoji + ' ' + esc(pf.chain.name) : ''}\n\nNo holdings on this chain across your wallets. Paste a token contract to buy, or switch chain.`,
      kb: rows([btn('🌐 Chain', 'chain'), btn('« Menu', 'menu')]) };
  }

  const open = pf.rows.filter((r) => r.open);
  const closed = pf.rows.filter((r) => !r.open);

  // ── Header ────────────────────────────────────────────────────────────────
  // Three SEPARATE lines, because they are three different questions and the old
  // card answered them on one. It printed
  //   Value $6.17 · 0.0033 ETH · 2.13× (+113%)
  // where the value was what you hold NOW and the multiple was every trade you
  // have EVER made, closed ones included. A portfolio whose live positions were
  // −2% and −67% read as "up 113%".
  const L = [`📊 <b>Portfolio</b> · ${pf.chain.emoji} ${esc(pf.chain.name)} · all wallets\n`];
  L.push(`💰 <b>Holding now:</b> ${money(pf.totalValueEth)}`);
  if (pf.totalCostEth > 0) {
    const pct = (pf.totalUnrealEth / pf.totalCostEth) * 100;
    L.push(`${dot(pf.totalUnrealEth)} <b>Unrealized:</b> ${both(pf.totalUnrealEth)} · ${pctStr(pct)} <i>on what you still hold</i>`);
  }
  if (Math.abs(pf.totalRealizedEth) > 1e-9) {
    L.push(`${dot(pf.totalRealizedEth)} <b>Realized:</b> ${both(pf.totalRealizedEth)} <i>banked from closed trades</i>`);
  }

  // ── Open positions ────────────────────────────────────────────────────────
  if (open.length) {
    L.push(`\n<b>── Open ──</b>`);
    for (const r of open) {
      const pct = r.costEth > 0 ? (r.unrealizedEth / r.costEth) * 100 : null;
      const who = (r.holders && r.holders.length)
        ? r.holders.map((h) => `${esc(h.label)} ${fmt(h.tokens)}`).join(' · ')
        : '—';
      L.push(`\n<b>$${esc(r.sym)}</b> · ${money(r.valueEth)}`);
      L.push(`   ${fmt(r.tokens)} tokens · cost ${money(r.costEth)}`);
      if (pct != null) L.push(`   ${dot(r.unrealizedEth)} ${both(r.unrealizedEth)} · ${pctStr(pct)}`);
      L.push(`   held: ${who}`);
      L.push(`   <code>${r.ca}</code>`);
    }
  }

  // ── Closed ────────────────────────────────────────────────────────────────
  // Their own section, showing ONLY what is true of them: what was banked. The
  // old card gave a closed token a live-looking row — "$0.0000 · 3.99× (+299%)"
  // above "now 0.0000 ETH · PnL +0.0000" — three numbers that each mean
  // something different and contradict each other at a glance.
  if (closed.length) {
    L.push(`\n<b>── Closed</b> <i>(sold out)</i> <b>──</b>`);
    for (const r of closed.slice(0, PF_CLOSED_ROWS)) {
      const mult = r.ethIn > 0 ? r.ethOut / r.ethIn : 0;
      L.push(`<b>$${esc(r.sym)}</b> · ${dot(r.realizedEth)} ${both(r.realizedEth)}${mult > 0 ? ` · <b>${mult.toFixed(2)}×</b> on ${r.ethIn.toFixed(4)} ${nat}` : ''}`);
    }
    if (closed.length > PF_CLOSED_ROWS) L.push(`<i>…and ${closed.length - PF_CLOSED_ROWS} more — see 🧾 History</i>`);
  }

  return {
    text: L.join('\n'),
    kb: rows([btn('🔄 Refresh', 'pos'), btn('📍 Monitor', 'monlist')], [btn('🧾 History', 'hist'), btn('🌐 Chain', 'chain'), btn('« Menu', 'menu')]),
  };
}

function historyScreen(chatId) {
  const u = core.ensureUser(chatId);
  const wal = core.activeWallet(u);
  const wi = core.walletList(u).findIndex((x) => x.id === wal.id) + 1;
  const ch = core.chainOf(core.userChain(u));
  const h = core.getHistory(chatId);               // active wallet, newest first
  const realized = core.realizedEth(wal, ch.key);  // active chain only (out − in; net of cost still held)
  const rp = (realized >= 0 ? '+' : '') + realized.toFixed(4);
  if (!h.length) return { text: `🧾 <b>History</b> · Wallet ${wi}\n\nNo trades yet. Paste a token contract and buy to start.`, kb: rows([btn('🔄 Refresh', 'hist'), btn('« Menu', 'menu')]) };
  let body = '';
  for (const t of h.slice(0, 20)) {
    const c = core.chainOf(t.chain || 'robinhood') || { native: 'ETH' };
    const when = t.ts ? fmtAge(t.ts) : '?';
    body += t.side === 'buy'
      ? `🟢 <b>BUY</b> $${esc(t.sym || '')} · ${Number(t.ethAmount || 0).toFixed(4)} ${c.native} · ${when} ago\n`
      : `🔴 <b>SELL</b> $${esc(t.sym || '')} ${t.pct || 100}% · ${Number(t.ethAmount || 0).toFixed(4)} ${c.native} · ${when} ago\n`;
  }
  return { text: `🧾 <b>History</b> · Wallet ${wi} · ${ch.emoji} ${esc(ch.name)}\n\nNet PnL (this chain): <b>${rp} ${ch.native}</b>\n<i>proceeds − total cost; a partly-sold bag reads low until fully exited</i>\n\n${body}`, kb: rows([btn('🔄 Refresh', 'hist'), btn('📊 Portfolio', 'pos'), btn('« Menu', 'menu')]) };
}
function snipeScreen(chatId) {
  const u = core.ensureUser(chatId);
  const chains = u.snipe.chains || {};
  const enabled = core.chains.enabledChains();
  const onList = enabled.filter((c) => chains[c.key]);
  const amt = esc(u.snipe.ethAmount);
  const live = onList.length > 0;
  const onStr = live ? onList.map((c) => `${c.emoji} ${esc(c.name)}`).join(', ') : '—';
  const SEP = '━━━━━━━━━━━━━━━━';
  const statusLine = live
    ? `<b>Status: 🟢 Active</b>\nSniping on <b>${onStr}</b> · <b>${amt}</b> per launch from your active wallet.`
    : `<b>Status: ⚪ Inactive</b>\nEnable at least one chain below to begin.`;
  const text =
    `🎯 <b>Auto-Snipe</b>\n\n` +
    `Automatically buys every brand-new token the moment it launches, on the chains you enable — no manual monitoring required.\n\n` +
    `<b>Step 1 — Amount per launch</b>\n` +
    `Currently <b>${amt}</b> (each chain's native coin). Tap a preset below, or ✏️ to type your own.\n\n` +
    `<b>Step 2 — Turn on a chain</b>\n` +
    `Tap a chain to start or stop sniping on it. Done.\n\n` +
    SEP + `\n${statusLine}\n` + SEP + `\n\n` +
    `⚠️ <b>Buys every new launch</b> on the enabled chains. Brand-new tokens carry high risk, so keep the amount small. Honeypots are filtered automatically; always do your own research.\n\n` +
    `<i>To follow one specific developer's launches instead, use 👥 Copy &amp; Dev Snipe.</i>`;
  const cur = String(u.snipe.ethAmount);
  const QUICK = ['0.01', '0.05', '0.1', '0.5'];
  const kbRows = [];
  // Step 1 — one-tap amount presets (no typing). ✓ marks the current amount.
  kbRows.push(QUICK.map((p) => btn(`${cur === p ? '✓ ' : ''}${p}`, `snamtq:${p}`)));
  kbRows.push([btn('✏️ Custom amount', 'snamt')]);
  // Step 2 — one tap per chain to start/stop sniping there.
  enabled.forEach((c) => kbRows.push([btn(`${c.emoji} ${c.name}  ·  ${chains[c.key] ? '🟢 ON' : '⚪ OFF'}`, `sntog:${c.key}`)]));
  kbRows.push([btn('🎯 Snipe a specific developer', 'copy')]);
  kbRows.push([btn('« Back', 'menu')]);
  return { text, kb: { inline_keyboard: kbRows } };
}
// Execution speed, in the user's terms. "gasMult 3, slipAddBps 1500" is the
// implementation; what a trader needs to know is what it buys them and what it
// costs.
const SPEED_NAME = { normal: 'Normal', fast: 'Fast', turbo: 'Turbo' };
const SPEED_ICON = { normal: '🐢', fast: '⚡', turbo: '🚀' };
const SPEED_LABEL = {
  normal: '🐢 Normal — ordinary gas and slippage. Cheapest; may miss a fast move.',
  fast: '⚡ Fast — 2× gas, +5% slippage. Lands through normal traffic.',
  turbo: '🚀 Turbo — 3× gas, +15% slippage. Built to land during a dump; costs the most.',
};
const SPEED_ORDER = ['normal', 'fast', 'turbo'];
/** One line telling the user how hard this order will try to land, and where to
 *  change it. A stop-loss defaults to Turbo precisely because it fires when the
 *  pool is busiest — but a default nobody is told about is a default nobody can
 *  disagree with. */
const speedNote = (o) => `${SPEED_LABEL[watchers.orderSpeed(o)]}\n<i>Tap 📋 Orders to change this.</i>`;

function ordersScreen(chatId) {
  const u = core.ensureUser(chatId);
  const wl = core.walletList(u);
  const multi = wl.length > 1;
  const list = [];
  wl.forEach((w, i) => { for (const o of (w.orders || [])) list.push({ o, wi: i + 1 }); });
  if (!list.length) return { text: '📋 <b>Orders</b>\n\nNo active orders. Open a token card and set a TP / SL / Limit buy.', kb: rows([btn('« Menu', 'menu')]) };
  let body = ''; const kbRows = [];
  for (const { o, wi } of list) {
    const c = core.chainOf(o.chain || 'robinhood');
    const label = o.type === 'tp' ? 'TP' : o.type === 'sl' ? 'SL' : o.type === 'trail' ? 'Trail' : 'Limit buy';
    const wtag = multi ? ` · <i>W${wi}</i>` : '';
    let tgt;
    if (o.type === 'trail') tgt = `−${Number(o.trailPct) || 0}% from peak`;
    else if (o.metric === 'mcap') tgt = nativeUsd(c.native) > 0 ? ('MC $' + fmt(o.targetPriceEth * nativeUsd(c.native))) : ('MC ' + o.targetPriceEth.toPrecision(3) + ' ' + c.native);
    else tgt = nativeUsd(c.native) > 0 ? ('$' + (o.targetPriceEth * nativeUsd(c.native)).toPrecision(3)) : (o.targetPriceEth.toExponential(2) + ' ' + c.native);
    const tail = o.type === 'limitbuy' ? ' · ' + o.ethAmount + ' ' + c.native : ' · sell ' + (o.sellPct || 100) + '%';
    // How hard this order will try to LAND, spelled out. A stop-loss fires while
    // the price is falling and everyone else is leaving; at ordinary gas and
    // ordinary slippage it is a stop-loss that misses. The number was decided
    // for the user and never shown to them.
    const sp = watchers.orderSpeed(o);
    body += `${c.emoji} <b>${label}</b> $${esc(o.sym || '')} @ ${tgt}${tail}${wtag}\n`;
    body += `    <i>${SPEED_LABEL[sp]}</i>\n`;
    kbRows.push([
      btn(`${SPEED_ICON[sp]} ${SPEED_NAME[sp]}`, `ospd:${o.id}`),
      btn(`✖ Cancel ${label} $${o.sym || ''}${multi ? ' (W' + wi + ')' : ''}`, `oc:${o.id}`),
    ]);
  }
  kbRows.push([btn('« Menu', 'menu')]);
  return { text: `📋 <b>Active orders</b>\n\n${body}`, kb: { inline_keyboard: kbRows } };
}
function dcaScreen(chatId) {
  const u = core.ensureUser(chatId);
  const list = u.dca || [];
  if (!list.length) return { text: '🔁 <b>DCA — scheduled buys</b>\n\nNo active plans. Open a token card and tap 🔁 DCA to buy a fixed amount on a repeating schedule.', kb: rows([btn('« Menu', 'menu')]) };
  let body = ''; const kbRows = [];
  const wl = core.walletList(u);
  for (const p of list) {
    const c = core.chainOf(p.chain) || { emoji: '', native: '' };
    const wi = (wl.findIndex((w) => w.id === p.walletId) + 1) || 1;
    body += `${c.emoji} <b>$${esc(p.sym || '')}</b> · ${esc(p.amount)} ${c.native} every ${p.intervalMin}m · <b>${p.roundsLeft}/${p.rounds}</b> left${wl.length > 1 ? ' · W' + wi : ''}\n`;
    kbRows.push([btn(`✖ Cancel $${p.sym || ''} DCA`, `dcac:${p.id}`)]);
  }
  kbRows.push([btn('« Menu', 'menu')]);
  return { text: `🔁 <b>Active DCA plans</b>\n\n${body}`, kb: { inline_keyboard: kbRows } };
}
function alertsScreen(chatId) {
  const u = core.ensureUser(chatId);
  const list = u.alerts || [];
  if (!list.length) return { text: '🔔 <b>Price alerts</b>\n\nNo alerts. Open a token card and tap 🔔 Alert to get pinged when a token crosses a target price. (Notify-only — no trade.)', kb: rows([btn('« Menu', 'menu')]) };
  let body = ''; const kbRows = [];
  for (const a of list) {
    const c = core.chainOf(a.chain || 'robinhood') || { emoji: '' };
    body += `${c.emoji} $${esc(a.sym || '')} ${a.dir === 'above' ? '↑' : '↓'} $${esc(String(a.targetUsd != null ? a.targetUsd : a.targetPriceEth))}\n`;
    kbRows.push([btn(`✖ Cancel $${a.sym || ''} ${a.dir === 'above' ? '↑' : '↓'}`, `al:${a.id}`)]);
  }
  kbRows.push([btn('« Menu', 'menu')]);
  return { text: `🔔 <b>Active alerts</b>\n\n${body}`, kb: { inline_keyboard: kbRows } };
}
function copyScreen(chatId) {
  const u = core.ensureUser(chatId);
  const c = u.copy || { on: false, targets: [] };
  const list = c.targets || [];
  const ach = activeChain(chatId);
  let body = `👥 <b>Copy &amp; Dev Snipe</b> (beta)\n\n` +
    `Follow any wallet and act on it automatically. Two modes:\n` +
    `• <b>Copy trades</b> — when it <b>buys</b> a token, you buy it too.\n` +
    `• <b>Dev snipe</b> 🎯 — when it <b>launches a new token</b> on the launchpad, you buy the launch instantly (like a pump.fun dev sniper).\n\n` +
    `Each followed wallet also has an <b>exit mirror</b> 🔻: the moment that wallet starts selling a token you copy-bought from it, you sell <b>100%</b> of yours. Tokens you bought yourself are never touched.\n\n` +
    `Master switch: <b>${c.on ? '🟢 ON' : '⚪ OFF'}</b>\n\n`;
  const kbRows = [[btn(c.on ? '🔴 Turn OFF' : '🟢 Turn ON', 'cptog')]];
  if (!list.length) body += '<i>No wallets followed yet — add one below.</i>\n';
  else {
    body += '<b>Following:</b>\n';
    for (const t of list) {
      const ch = core.chainOf(t.chain) || { emoji: '' };
      const badge = (t.mode === 'launches') ? '🎯 dev snipe' : '👥 copy trades';
      const spent = Number(t.spentEth).toFixed(3), max = esc(t.maxEth);
      const held = Object.keys(t.holding || {}).length;
      body += `${ch.emoji} <code>${short(t.address)}</code> · <b>${badge}</b>\n    ${esc(t.buyEth)}/buy · used ${spent}/${max} ${ch.native || ''}\n` +
        `    🔻 Exit mirror: <b>${t.copySell ? '🟢 ON' : '⚪ OFF'}</b>${held ? ` · watching <b>${held}</b> position${held > 1 ? 's' : ''}` : ''}\n`;
      kbRows.push([
        btn(t.copySell ? '🔻 Exit mirror OFF' : '🔻 Exit mirror ON', `cpsell:${t.id}`),
        btn(`✖ Remove ${short(t.address)}`, `cprm:${t.id}`),
      ]);
    }
  }
  if (list.length < core.MAX_COPY_TARGETS) {
    kbRows.push([btn('➕ Copy trades', 'cpadd')]);
    // Dev snipe is only offered when the active chain is a launchpad chain.
    if (core.canDevSnipe(ach.key)) kbRows.push([btn('🎯 Snipe a dev wallet', 'cpaddd')]);
  }
  kbRows.push([btn('« Menu', 'menu')]);
  body += `\n<i>Both modes skip honeypots and are capped by your budget. Turn the master switch ON to start. ⚠️ High risk — DYOR.</i>`;
  body += `\n<i>The exit mirror only ever sells what copy bought from that wallet, and only positions opened after you enabled it — it will not reach back into bags you already held.</i>`;
  if (!core.canDevSnipe(ach.key)) body += `\n<i>🎯 Dev snipe is available on Robinhood Chain &amp; Solana — switch chain (🌐) to add one.</i>`;
  return { text: body, kb: { inline_keyboard: kbRows } };
}
function referralScreen(chatId) {
  const u = core.ensureUser(chatId);
  const link = `https://t.me/${BOT_USERNAME}?start=${u.refCode}`;
  const owed = u.refOwed || {};
  const earned = Object.keys(owed).length
    ? Object.entries(owed).map(([ck, wei]) => { const c = core.chainOf(ck) || { native: 'ETH' }; return `${fmtNat(wei || '0', ck)} ${c.native}`; }).join(' · ')
    : '0';
  return {
    text: `🎁 <b>Referrals</b>\n\nShare your link — you earn <b>${(core.CFG.refShareBps / 100).toFixed(0)}%</b> of the bot fee on every trade your referrals make.\n\n<code>${link}</code>\n\nEarned so far: <b>${earned}</b>\n<i>${core.feePayoutEnabled() ? 'Auto-paid to your active wallet once it clears the minimum.' : 'Settled manually by the team.'}</i>`,
    kb: rows([btn('« Menu', 'menu')]),
  };
}

function settingsScreen(chatId) {
  const u = core.ensureUser(chatId);
  const s = u.settings;
  const ch = core.chainOf(core.userChain(u));
  const slip = s.slippage > 0 ? s.slippage + '%' : 'default (5%)';
  const bp = core.buyPresets(u, ch.key).join(' · ');
  const perChain = core.hasChainPresets(u, ch.key) ? ' <i>(set for this chain)</i>' : '';
  const onoff = (b) => b ? '🟢 ON' : '⚪ OFF';
  const gasName = gasLabel(core.userGasBoost(u));
  return {
    text: `⚙️ <b>Settings</b>\n\n` +
      `<b>Trading</b>\n` +
      `Active chain: <b>${ch.emoji} ${esc(ch.name)}</b>\n` +
      `Slippage: <b>${esc(String(slip))}</b>\n` +
      `Gas priority: <b>${esc(gasName)}</b>\n` +
      `Quick-buy (${esc(ch.name)}): <b>${esc(bp)} ${ch.native}</b>${perChain}\n\n` +
      `<b>How buys behave</b>\n` +
      `Confirm before buy: <b>${onoff(s.confirmBuy)}</b>\n` +
      `Fast mode: <b>${onoff(s.expert)}</b>\n` +
      `Auto-buy on paste: <b>${s.autoBuy ? '🟢 ON · ' + esc(s.autoBuyAmount) + ' ' + ch.native : '⚪ OFF'}</b>\n\n` +
      `<b>Automatic exits</b>\n` +
      `Auto-exit after buy: <b>${(s.autoTpPct > 0 || s.autoSlPct > 0) ? [(s.autoTpPct > 0 ? 'TP +' + s.autoTpPct + '%' : ''), (s.autoSlPct > 0 ? 'SL −' + s.autoSlPct + '%' : '')].filter(Boolean).join(' · ') : '⚪ OFF'}</b>\n` +
      `🛡 Auto-protect (rug guard): <b>${onoff(s.autoProtect)}</b>\n\n` +
      `<i>Quick-buy amounts are per-chain. Fast mode skips the "buying…" message. Auto-buy buys instantly on paste. Auto-protect auto-sells only on a ~60% loss vs entry or a honeypot — never a profitable dip.</i>`,
    kb: rows(
      [btn('🌐 Chain', 'chain'), btn('📉 Slippage', 'setslip'), btn('⛽ Gas', 'setgas')],
      [btn(`⚡ Buy amounts`, 'setbp')],
      [btn(`${s.confirmBuy ? '🔴 Confirm buy OFF' : '🟢 Confirm buy ON'}`, 'cbtog'), btn(`${s.expert ? '🔴 Fast mode OFF' : '🟢 Fast mode ON'}`, 'extog')],
      [btn(s.autoBuy ? '🔴 Auto-buy OFF' : '🟢 Auto-buy ON', 'abtog'), btn('✏️ Auto-buy amount', 'abamt')],
      [btn('🎯 Auto-exit (TP/SL)', 'aex'), btn(`${s.autoProtect ? '🔴 Rug guard OFF' : '🛡 Rug guard ON'}`, 'aptog')],
      [btn('🔐 Security', 'usec'), btn('🔔 Notifications', 'ntf')],
      [btn(i18n.t(core.getLang(chatId), 'lang.button') + ` · ${i18n.LANG_LABEL[core.getLang(chatId)]}`, 'lang')],
      [btn('❔ Help', 'help'), btn('« Menu', 'menu')],
    ),
  };
}
// Language picker. The setting itself has always been in the store — this is the
// screen that finally lets a user reach it.
function langScreen(chatId) {
  const cur = core.getLang(chatId);
  return {
    text: T(chatId, 'lang.screen', { current: i18n.LANG_LABEL[cur] || cur }),
    kb: rows(
      ...i18n.LANGS.map((l) => [btn((l === cur ? '✅ ' : '') + i18n.LANG_LABEL[l], 'setlang:' + l)]),
      [btn(T(chatId, 'lang.back'), 'set')],
    ),
  };
}
// Gas priority: a small multiplier on the gas price the bot pays. Higher = faster
// confirmations, marginally higher network fee (tiny on the Robinhood L2).
function gasLabel(n) { return n >= 3 ? 'Turbo (≈3× gas)' : (n === 2 ? 'Fast (≈2× gas)' : 'Normal'); }
function gasScreen(chatId) {
  const u = core.ensureUser(chatId);
  const g = core.userGasBoost(u);
  const mark = (n) => (g === n ? '✅ ' : '');
  return {
    text: `⛽ <b>Gas priority</b>\n\n` +
      `This sets how much gas the bot pays to get your <b>buys and sells mined</b>. Higher priority confirms faster when the chain is busy — the extra fee is tiny on Robinhood Chain.\n\n` +
      `Current: <b>${esc(gasLabel(g))}</b>\n\n` +
      `🟢 <b>Normal</b> — standard speed, lowest fee. Best for calm markets.\n` +
      `⚡ <b>Fast</b> — about 2× gas. Gets you in quicker during busy moments.\n` +
      `🚀 <b>Turbo</b> — about 3× gas. For fast-moving launches where every second counts.\n\n` +
      `<i>You don't have to touch this — if a sell ever fails on gas, the bot already auto-retries with higher gas and wider slippage. This just sets your starting level.</i>`,
    kb: rows(
      [btn(`${mark(1)}🟢 Normal`, 'gasset:1'), btn(`${mark(2)}⚡ Fast`, 'gasset:2'), btn(`${mark(3)}🚀 Turbo`, 'gasset:3')],
      [btn('« Settings', 'set')],
    ),
  };
}
// Withdrawal protections: vault lock, per-chain whitelist, rate limit. Guards a hijacked
// Telegram account from instantly draining funds.
function securityScreen(chatId) {
  const u = core.ensureUser(chatId);
  const sec = core.getSecurity(chatId);
  const ch = core.chainOf(core.userChain(u));
  const wl = (sec.whitelist || []);
  const wlChain = wl.filter((w) => w.chain === ch.key);
  let body = `🔐 <b>Security</b>\n\n` +
    `Withdraw vault lock: <b>${sec.withdrawLock ? '🔒 ON (all withdrawals blocked)' : '🔓 OFF'}</b>\n` +
    `Withdraw rate limit: <b>${core.MAX_WD_PER_HOUR}/hour</b>\n\n` +
    `<b>Withdraw whitelist</b> · ${ch.emoji} ${esc(ch.name)}\n`;
  if (!wl.length) body += `<i>Empty — withdrawals are allowed to ANY address. Add addresses to restrict withdrawals to only them.</i>\n`;
  else if (!wlChain.length) body += `<i>None for ${esc(ch.name)} yet (you have ${wl.length} on other chains). With none set here, withdrawals on ${esc(ch.name)} go to any address.</i>\n`;
  else { body += wlChain.map((w) => `• <code>${esc(w.address)}</code>`).join('\n') + `\n<i>Only these addresses can receive ${esc(ch.name)} withdrawals.</i>\n`; }
  const kbRows = [
    [btn(sec.withdrawLock ? '🔓 Unlock withdrawals' : '🔒 Lock withdrawals (vault)', 'usectog')],
    [btn('➕ Add whitelist address', 'uwladd')],
  ];
  for (const w of wlChain) kbRows.push([btn('🗑 ' + short(w.address), 'uwlrm:' + w.id)]);
  kbRows.push([btn('🌐 Chain', 'chain'), btn('« Settings', 'set')]);
  return { text: body + `\n<i>Whitelist is per chain — switch with 🌐 to manage another chain. The bot NEVER shares keys; withdrawals always need your explicit action.</i>`, kb: { inline_keyboard: kbRows } };
}
function notifyScreen(chatId) {
  const u = core.ensureUser(chatId);
  const n = (u.settings && u.settings.notify) || {};
  const on = (t) => (n[t] === undefined ? true : !!n[t]);
  const row = (t, label) => [btn(`${on(t) ? '🟢' : '⚪'} ${label}`, `ntftog:${t}`)];
  return {
    text: `🔔 <b>Notifications</b>\n\nChoose which automatic DMs you get. Your own limit/TP/SL order fills always notify.`,
    kb: {
      inline_keyboard: [
        row('snipe', 'Snipe fills'),
        row('copy', 'Copy-trade fills'),
        row('alerts', 'Price alerts'),
        [btn('« Settings', 'set'), btn('« Menu', 'menu')],
      ],
    },
  };
}
async function safetyScreen(chatId, ca, chainKey) {
  const ch = core.chainOf(chainKey) || core.chainOf(core.userChain(core.ensureUser(chatId)));
  const back = rows([btn('« Menu', 'menu')]);
  if (!safety.supported(chainKey)) {
    return { text: `🛡 <b>Token safety</b> — not available on ${ch.emoji} ${esc(ch.name)}.\n\nLaunchpad tokens on Robinhood Chain are fair-launch by design: fixed supply, no tax, and LP is 100% burned at graduation.`, kb: back };
  }
  const s = await safety.tokenSecurity(chainKey, ca).catch(() => null);
  if (!s) return { text: `🛡 <b>Token safety</b>\n\nCouldn't fetch security data right now (or the token isn't indexed yet). Trade carefully.`, kb: rows([btn('🔄 Retry', `sec:${chainKey}:${ca}`), btn('« Menu', 'menu')]) };
  const v = safety.verdict(chainKey, s);
  const banner = v.level === 'danger' ? '🚨 <b>HIGH RISK</b>' : v.level === 'warn' ? '⚠️ <b>CAUTION</b>' : '✅ <b>No major red flags</b>';
  const yn = (bad) => (bad ? '🔴' : '🟢');
  const svm = core.chains.isSvm(chainKey);
  let body, src;
  if (svm) {
    // RugCheck (Solana): authorities, LP lock, holder concentration, "rugged".
    src = 'RugCheck';
    body =
      `${yn(s.freezeAuthorityEnabled)} Freeze authority: <b>${s.freezeAuthorityEnabled ? 'ACTIVE 🚩' : 'revoked'}</b>\n` +
      `${yn(s.mintAuthorityEnabled)} Mint authority: <b>${s.mintAuthorityEnabled ? 'active' : 'revoked'}</b>\n` +
      `${yn(s.rugged)} Rugged flag: <b>${s.rugged ? 'YES' : 'no'}</b>\n`;
    if (s.lpLockedPct != null) body += `${yn(s.lpLockedPct < 50)} LP locked/burned: <b>${Math.round(s.lpLockedPct)}%</b>\n`;
    if (s.topHolderPct != null) body += `${yn(s.topHolderPct >= 20)} Top holder: <b>${s.topHolderPct.toFixed(1)}%</b>${s.top10Pct != null ? ` · top-10 <b>${s.top10Pct.toFixed(0)}%</b>` : ''}\n`;
    if (s.totalHolders != null) body += `Holders: <b>${s.totalHolders}</b>\n`;
    if (s.liquidityUsd != null) body += `Liquidity: <b>$${fmt(s.liquidityUsd)}</b>\n`;
    if (s.scoreNorm != null) body += `RugCheck score: <b>${Math.round(s.scoreNorm)}/100</b> <i>(lower is safer)</i>\n`;
  } else {
    // GoPlus (EVM): tax, honeypot, mintable, owner footguns, LP lock.
    src = 'GoPlus';
    const tax = (t) => (t == null ? '?' : (Math.round(t * 10) / 10) + '%');
    body =
      `${yn((s.buyTaxPct || 0) > 10)} Buy tax: <b>${tax(s.buyTaxPct)}</b>  ·  ${yn((s.sellTaxPct || 0) > 10)} Sell tax: <b>${tax(s.sellTaxPct)}</b>\n` +
      `${yn(s.honeypot)} Honeypot: <b>${s.honeypot ? 'YES' : 'no'}</b>  ·  ${yn(s.cannotSellAll)} Can sell all: <b>${s.cannotSellAll ? 'NO' : 'yes'}</b>\n` +
      `${yn(s.mintable)} Mintable: <b>${s.mintable ? 'yes' : 'no'}</b>  ·  ${yn(s.ownerChangeBalance)} Owner edits balances: <b>${s.ownerChangeBalance ? 'yes' : 'no'}</b>\n` +
      `${yn(s.openSource === false)} Open-source: <b>${s.openSource === false ? 'no' : 'yes'}</b>  ·  ${yn(s.proxy)} Proxy: <b>${s.proxy ? 'yes' : 'no'}</b>\n`;
    if (s.lpLockedPct != null) body += `${yn(s.lpLockedPct < 50)} LP locked/burned: <b>${Math.round(s.lpLockedPct)}%</b>\n`;
    if (s.holders != null) body += `Holders: <b>${s.holders}</b>\n`;
  }
  if (v.red.length) body += `\n🔴 <b>${esc(v.red.join(', '))}</b>`;
  else if (v.warn.length) body += `\n⚠️ ${esc(v.warn.join(', '))}`;
  return {
    text: `🛡 <b>Token safety</b> · ${ch.emoji} ${esc(ch.name)}  ${s.symbol ? '· $' + esc(s.symbol) : ''}\n${banner}\n\n${body}\n\n<i>Source: ${src}. Not financial advice — always DYOR.</i>`,
    kb: rows([btn('🔄 Recheck', `sec:${chainKey}:${ca}`), btn('« Menu', 'menu')]),
  };
}

// ------------------------------------------------------------ actions
// 1-based index of a wallet (default active) — used to re-encode the card action.
function walletIndex(chatId, walletId) {
  const u = core.getUser(chatId); if (!u) return 1;
  const id = walletId || (core.activeWallet(u) || {}).id;
  const i = core.walletList(u).findIndex((w) => w.id === id);
  return i >= 0 ? i + 1 : 1;
}
// Human label for the wallet a trade will use (e.g. "Wallet 1") — in-memory, no network.
function walletLabelFor(chatId, walletId) {
  try { const u = core.getUser(chatId) || core.ensureUser(chatId); const w = (walletId && core.walletById(u, walletId)) || core.activeWallet(u); return core.walletLabel(w, walletIndex(chatId, w && w.id)); }
  catch (_) { return 'your wallet'; }
}
// The token's symbol from the user's stored position, if any — instant (no RPC), so the
// "selling…" progress note can name the coin without adding latency to the trade.
function quickSym(chatId, ca, chainKey, walletId) {
  try { const u = core.getUser(chatId); const w = (walletId && core.walletById(u, walletId)) || core.activeWallet(u); const p = w && (w.positions || {})[core.posKey(chainKey || core.userChain(u), ca)]; return (p && p.sym) || ''; }
  catch (_) { return ''; }
}
// Which wallets a Buy/Sell tap acts on: the explicit multi-selection if the user set
// one (👛 picker on the card), otherwise the card's single bound wallet. Returns
// [{id,index,label}] in wallet order.
function tradeTargets(chatId, cardWalletId) {
  const u = core.ensureUser(chatId);
  const list = core.walletList(u);
  const ids = core.tradeWalletIds(chatId);
  const pick = ids.length ? ids : [cardWalletId || (core.activeWallet(u) || {}).id].filter(Boolean);
  return pick.map((id) => { const i = list.findIndex((w) => w.id === id); return i >= 0 ? { id, index: i + 1, label: core.walletLabel(list[i], i + 1) } : null; }).filter(Boolean);
}
// Entry point for a buy from a tap/command. If the user enabled "Confirm before buy",
// show a Yes/No confirmation first; otherwise execute immediately. (Auto-buy-on-paste
// is deliberately instant and bypasses this.)
let _confirmSeq = 0;
async function requestBuy(chatId, ca, amt, chain, walletId) {
  const u = core.ensureUser(chatId);
  if (u.settings && u.settings.confirmBuy) {
    const ch = core.chainOf(chain) || core.chainOf(core.userChain(u));
    const targets = tradeTargets(chatId, walletId);
    // Bind the confirm to a fresh id so tapping a STALE confirm card (whose pending
    // was overwritten by a newer buy) can't execute the wrong token/amount/wallet.
    const cid = (_confirmSeq = (_confirmSeq + 1) % 1000000).toString(36);
    setPending(chatId, { action: 'confirm_buy', ca, amt: String(amt), chain, walletId, confirmId: cid });
    const who = targets.length > 1
      ? `on <b>${targets.length} wallets</b> (${targets.map((t) => esc(t.label)).join(', ')}) — total <b>${esc(String(+(Number(amt) * targets.length).toFixed(6)))} ${ch.native}</b>`
      : `with <b>${esc(targets[0] ? targets[0].label : 'your wallet')}</b>`;
    return send(chatId, `🟢 <b>Confirm buy</b>\n\nBuy <b>${esc(String(amt))} ${ch.native}</b> of <code>${short(ca)}</code> ${who}?`, rows([btn('✅ Confirm', 'bcok:' + cid), btn('✖ Cancel', 'bccancel:' + cid)]));
  }
  return doBuy(chatId, ca, amt, chain, walletId);
}
// Blocks a CONCURRENT buy of the SAME (user, chain, token) — a rapid double-tap (or
// double-paste) fires two handlers; the second sees the key in-flight and is dropped,
// so one intended tap can't spend twice. A deliberate second buy after the first lands
// is fine (the key is released on completion).
const _inflightBuy = new Set();
// After a buy, auto-place the user's take-profit / stop-loss (⚙️ Settings) relative to
// the entry price, on the wallet that just bought. Best-effort — never breaks the buy.
// Places the user's auto TP/SL (⚙️ Settings) on the wallet that just bought, and RETURNS
// a short line to fold into the buy receipt (so it isn't a separate message). Best-effort.
async function _placeAutoExit(chatId, r, walletId) {
  try {
    const u = core.getUser(chatId); const s = u && u.settings;
    if (!s || (!(s.autoTpPct > 0) && !(s.autoSlPct > 0))) return '';
    const got = Number(r.gotTokens) || 0, spent = Number(r.spentEth) || 0;
    if (!(got > 0) || !(spent > 0)) return '';
    const entry = spent / got;   // native price per token at entry
    const msgs = [];
    if (s.autoTpPct > 0) { watchers.addOrder(chatId, { type: 'tp', ca: r.ca, sym: r.sym, chain: r.chain, targetPriceEth: entry * (1 + s.autoTpPct / 100), sellPct: 100, auto: true }, walletId); msgs.push(`TP +${s.autoTpPct}%`); }
    if (s.autoSlPct > 0) { watchers.addOrder(chatId, { type: 'sl', ca: r.ca, sym: r.sym, chain: r.chain, targetPriceEth: entry * (1 - s.autoSlPct / 100), sellPct: 100, auto: true }, walletId); msgs.push(`SL −${s.autoSlPct}%`); }
    return msgs.length ? `\nAuto-exit: <b>${msgs.join(' · ')}</b>` : '';
  } catch (_) { return ''; }   /* order cap reached or unpriceable — skip silently */
}
// Price impact for the size being bought — INFORMATION, never a gate (operator
// rule: the user must always be able to buy). Returns "" when it cannot be
// measured, and it is never awaited ahead of the trade.
//
// V2 only: a V2 pair's WETH balance IS its depth, so spend/(reserve+spend) is
// the real impact. A V3 pool's balance is NOT — its liquidity is concentrated,
// so a pool holding 0.8 ETH can fill a 0.05 ETH buy at almost no impact.
// Running the constant-product formula over one invented an 11% figure and
// refused a trade Maestro filled.
// How long the "Buying…" line waits for a market cap before going out without
// one. The trade is already in flight by then, so this is never execution
// latency — only how long the user stares at a message with a blank in it.
const ENTRY_MC_WAIT_MS = 1200;

async function impactNote(ca, chG, amt) {
  if (core.chains.isSvm(chG.key)) return '';
  try {
    const pick = await withTmo(core.bestDexVenue(ca, chG.key).catch(() => null), 6000, null);
    if (!pick || pick.kind === 'v3' || pick.wethBal == null) return '';
    const reserve = Number(ethers.formatEther(pick.wethBal));
    const amtN = Number(amt) || 0;
    const impact = reserve > 0 ? (amtN / (reserve + amtN)) * 100 : 0;
    return impact >= 5 ? `\n⚠️ Thin pool — this size moved the price ~<b>${impact.toFixed(0)}%</b>.` : '';
  } catch (_) {
    return '';   // an unreadable pool is not a reason to say anything
  }
}

async function doBuy(chatId, ca, amt, chain, walletId) {
  const u = core.ensureUser(chatId);
  const chG = core.chainOf(chain) || core.chainOf(core.userChain(u));
  const key = chatId + ':' + (chain || core.userChain(u)) + ':' + String(ca).toLowerCase();
  if (_inflightBuy.has(key)) return send(chatId, T(chatId, 'buy.inflight'));
  _inflightBuy.add(key);
  const expert = u.settings.expert;
  const targets = tradeTargets(chatId, walletId);
  try {
    if (targets.length <= 1) {
      const wid = targets[0] ? targets[0].id : walletId;
      // SPEED: the trade starts on the very first line of this block. Nothing
      // is awaited before it — not the "Buying…" message, not the depth probe.
      //
      // Those two used to run in series ahead of the buy: a bestDexVenue call
      // with a 6s timeout, purely to compute a warning line, and then a
      // Telegram round-trip for the progress message. Up to ~6.5s of the user's
      // latency was spent before a single on-chain call, on a bot competing
      // with one that fills immediately.
      //
      // Now the buy, the progress message and the depth probe are all in
      // flight at once, and the probe's result is folded into the receipt if it
      // arrives in time. Nothing about the trade waits on either of them.
      // The progress message is upgraded to a live explorer link the moment the
      // transaction is broadcast, instead of sitting on "Buying…" until the
      // receipt lands. On Ethereum that wait is a full 12s block; the trade is
      // already irreversible by then, so there is nothing to gain by hiding it.
      let progressId = null, sentSeen = null, settled = false;
      const onSent = (hash) => {
        sentSeen = hash;
        if (!progressId || settled) return;   // no message yet, or the receipt already won
        edit(chatId, progressId, T(chatId, 'buy.sent', { amt: esc(amt), native: chG.native, link: txLink(chain || core.userChain(u), hash) })).catch(() => {});
      };
      const buying = core.buy(chatId, ca, amt, chain, wid, { onSent });
      const impactP = impactNote(ca, chG, amt);
      // Entry snapshot, started WITH the trade. The buy is already in flight, so
      // the short wait below costs execution nothing — it only decides whether
      // the "Buying…" line can name the market cap being entered at. "At what
      // MC did I get in" is the first thing anyone asks, and afterwards it can
      // only be reconstructed.
      const entryP = withTmo(core.tokenSnapshot(ca, chG.key).catch(() => null), 6000, null);
      const entry = await Promise.race([entryP, new Promise((res) => setTimeout(res, ENTRY_MC_WAIT_MS, null))]);
      const eRate = nativeUsd(chG.native);
      const eMc = entry ? (entry.mcapUsd || (entry.mcapEth || 0) * eRate) : 0;
      const atMc = eMc > 0 ? T(chatId, 'buy.at_mc', { mc: fmt(eMc) }) : '';
      const progress = expert ? null : await send(chatId, T(chatId, 'buy.progress', { amt: esc(amt), native: chG.native, atMc }));
      progressId = progress && progress.ok && progress.result && progress.result.message_id;
      // The broadcast can beat the progress message out of the door; if it did,
      // apply the upgrade now rather than losing it.
      if (progressId && sentSeen) onSent(sentSeen);
      const r = await buying;
      // On a 250ms-block chain the fill can land while the "sent" edit is still
      // in flight to Telegram. Without this the late edit would overwrite the
      // receipt and the user would watch a completed buy turn back into
      // "waiting for confirmation".
      settled = true;
      const wi = walletIndex(chatId, wid);
      const usdRate = nativeUsd(r.native);
      const spent = Number(r.spentEth) || 0, got = Number(r.gotTokens) || 0;
      const usd2 = (v) => (usdRate > 0 ? `$${(v * usdRate).toFixed(2)}` : '—');
      const uu = core.getUser(chatId);
      const wl = core.walletLabel((uu && core.walletById(uu, wid)) || core.activeWallet(uu), wi);
      let holdUsd = usdRate > 0 && spent > 0 ? usd2(spent) : '—';
      let statLine = '';
      try {
        // The snapshot started with the trade — reuse it rather than fetching a
        // second time. It is also the more honest "entry": taken as the buy went
        // out, not seconds after it landed.
        const snap = await entryP;
        if (snap && snap.priceEth > 0) {
          if (usdRate > 0 && got > 0) holdUsd = `$${(got * snap.priceEth * usdRate).toFixed(2)}`;
          const pxUsd = snap.priceEth * usdRate;
          const mcUsd = snap.mcapUsd || ((snap.mcapEth || 0) * usdRate);
          if (pxUsd > 0) statLine = '\n' + T(chatId, 'buy.receipt.entry', { px: pxUsd.toPrecision(3) }) + (mcUsd > 0 ? ` · MC <b>$${fmt(mcUsd)}</b>` : '');
        }
      } catch (_) {}
      const exp2 = core.chainOf(r.chain);
      const venue = r.venue === 'curve' ? 'Launchpad' : (r.venue === 'dex·v3' ? 'DEX (V3)' : 'DEX');
      const autoLine = await _placeAutoExit(chatId, r, wid);
      const receipt =
        T(chatId, 'buy.receipt.title', { sym: esc(r.sym) }) + '\n' +
        T(chatId, 'buy.receipt.spent', { amt: spent.toFixed(6), native: r.native, usd: usd2(spent) }) + '\n' +
        T(chatId, 'buy.receipt.got', { amt: fmt(got), sym: esc(r.sym), usd: holdUsd }) +
        statLine + '\n' +
        T(chatId, 'buy.receipt.wallet', { wallet: esc(wl), venue }) + autoLine;
      const kb = { inline_keyboard: [
        [{ text: '🔍 Tx', url: `${exp2.explorer}/tx/${r.hash}` }, btn('📍 Monitor', `monn:${r.chain}:${wi}:${ca}`)],
        [btn('🔄 Card', `tok:${r.chain}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')],
      ] };
      // The probe ran alongside the trade; whatever it found is a footnote on
      // the receipt now, and never cost the trade a millisecond.
      const note = await impactP.catch(() => '');
      const pid = progress && progress.ok && progress.result && progress.result.message_id;
      if (pid) await edit(chatId, pid, receipt + note, kb); else await send(chatId, receipt + note, kb);
      // Straight into the live position — pinned, refreshing itself, closing on
      // exit. It already existed behind the 📍 button; making someone tap for it
      // after a buy is asking them to do the obvious thing by hand.
      startMonitor(chatId, ca, r.chain, wid).catch(() => {});
    } else {
      // Same order as the single-wallet path: every buy is in flight before the
      // progress message is awaited.
      const buys = Promise.allSettled(targets.map((t) => core.buy(chatId, ca, amt, chain, t.id)));
      const progress = expert ? null : await send(chatId, T(chatId, 'buy.progress.multi', { amt: esc(amt), native: chG.native, n: targets.length }));
      const results = await buys;
      let okN = 0, totTok = 0, totSpent = 0, totFee = 0, sym = '', chainKey = chain || core.userChain(u), nat = '', lines = [];
      results.forEach((res, i) => {
        const t = targets[i];
        if (res.status === 'fulfilled') { const r = res.value; okN++; totTok += Number(r.gotTokens) || 0; totSpent += Number(r.spentEth) || 0; totFee += Number(r.feeEth) || 0; sym = r.sym || sym; chainKey = r.chain || chainKey; nat = r.native || nat; lines.push(`• ${esc(t.label)}: ${fmt(r.gotTokens)} $${esc(r.sym)} · ${r.spentEth} ${r.native}`); _placeAutoExit(chatId, r, t.id).catch(() => {}); }
        else { const e = res.reason; lines.push(`• ${esc(t.label)}: ❌ ${esc(String((e && (e.message || e)) || 'failed').slice(0, 60))}`); }
      });
      const wi = walletIndex(chatId, targets[0].id);
      const mUsd = nativeUsd(nat || 'ETH');
      const head = T(chatId, 'buy.receipt.multi', { sym: esc(sym || ''), ok: okN, n: targets.length, tokens: fmt(totTok), spent: totSpent.toFixed(5), native: esc(nat || 'ETH'), usd: mUsd > 0 ? ` ($${(totSpent * mUsd).toFixed(2)})` : '' });
      const kb = rows([btn('📍 Monitor', `monn:${chainKey}:${wi}:${ca}`), btn('🔄 Card', `tok:${chainKey}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')]);
      const pid = progress && progress.ok && progress.result && progress.result.message_id;
      const txt = head + '\n' + lines.join('\n');
      if (pid) await edit(chatId, pid, txt, kb); else await send(chatId, txt, kb);
      // The multi-wallet branch never opened a monitor and its receipt had no 📍
      // button either, so anyone trading more than one wallet got a fill and
      // nothing to watch it with. Bound to the first wallet that actually
      // filled — the monitor is per token, and that is the one holding a bag.
      const filled = results.findIndex((res) => res.status === 'fulfilled');
      if (okN > 0) startMonitor(chatId, ca, chainKey, targets[filled >= 0 ? filled : 0].id).catch(() => {});
    }
  } catch (e) { console.error('buy failed:', e && (e.message || e)); await send(chatId, `${T(chatId, 'buy.failed')}\n\n${esc(friendlyError(chatId, e, 'buy'))}`, rows([btn('🔄 Try again', `tok:${chain || core.userChain(u)}:${walletIndex(chatId, walletId)}:${ca}`), btn('« Menu', 'menu')])); }
  finally { _inflightBuy.delete(key); }
}
// Escalating sell: if a sell fails for a RETRIABLE reason (gas rejected by a
// base-fee tick, a too-tight quote/revert, an unconfirmed timeout), automatically
// re-try with higher gas and wider slippage so the exit still lands. Terminal
// errors (no balance, insufficient funds) are NOT retried. onStep notifies the UI.
const SELL_ESCALATION = [
  {},                                   // 1st: normal
  { gasMult: 2, slipAddBps: 500 },      // 2nd: 2× gas, +5% slippage
  { gasMult: 4, slipAddBps: 1500 },     // 3rd: 4× gas, +15% slippage
];
const _retriable = (m) => /max fee per gas|base fee|reverted|not confirmed|try again|could not (read|price)|coalesce|timeout|replacement|underpriced|nonce/i.test(String(m || ''));
// Turn a raw on-chain / RPC error into one clear sentence a non-technical user
// understands, IN THEIR LANGUAGE. The classification lives in i18n.errorKey so
// the regexes are shared by every locale and testable on their own; the original
// message is still logged server-side for the operator.
function friendlyError(chatId, raw, action) {
  return i18n.errorText(core.getLang(chatId), raw, action);
}
async function sellWithRetry(chatId, ca, pct, chain, wid, onStep, onSent) {
  let lastErr;
  for (let i = 0; i < SELL_ESCALATION.length; i++) {
    try { return await core.sell(chatId, ca, pct, chain, wid, { ...SELL_ESCALATION[i], onSent }); }
    catch (e) {
      lastErr = e; const msg = (e && (e.message || e)) || 'failed';
      if (i === SELL_ESCALATION.length - 1 || !_retriable(msg)) throw e;
      if (onStep) await onStep(i + 1, msg);
    }
  }
  throw lastErr;
}
async function doSell(chatId, ca, pct, chain, walletId) {
  const expert = core.ensureUser(chatId).settings.expert;
  const targets = tradeTargets(chatId, walletId);
  try {
    if (targets.length <= 1) {
      const wid = targets[0] ? targets[0].id : walletId;
      const sym0 = quickSym(chatId, ca, chain, wid);
      // The sell is in flight before the progress message is awaited — an exit
      // is the one trade where a round-trip of delay is felt most.
      let progress = null, progressId = null, sentSeen = null, settled = false;
      const onSent = (hash) => {
        sentSeen = hash;
        if (!progressId || settled) return;   // see the buy path: the receipt must win
        edit(chatId, progressId, T(chatId, 'sell.sent', { pct, link: txLink(chain || core.userChain(core.ensureUser(chatId)), hash) })).catch(() => {});
      };
      const selling = sellWithRetry(chatId, ca, pct, chain, wid, (n) =>
        (progress && progress.ok && progress.result)
          ? edit(chatId, progress.result.message_id, T(chatId, 'sell.retry', { n })).catch(() => {})
          : null, onSent);
      progress = expert ? null : await send(chatId, T(chatId, 'sell.progress', { pct, what: sym0 ? '$' + esc(sym0) : T(chatId, 'sell.your_token') }));
      progressId = progress && progress.ok && progress.result && progress.result.message_id;
      if (progressId && sentSeen) onSent(sentSeen);
      const r = await selling;
      settled = true;
      const wi = walletIndex(chatId, wid);
      const sUsd = nativeUsd(r.native);
      const got2 = Number(r.proceedsEth) || 0;
      const sexp = core.chainOf(r.chain);
      const uu2 = core.getUser(chatId);
      const wl2 = core.walletLabel((uu2 && core.walletById(uu2, wid)) || core.activeWallet(uu2), wi);
      const svenue = r.venue === 'curve' ? 'Launchpad' : (r.venue === 'dex·v3' ? 'DEX (V3)' : 'DEX');
      const pnl = Number(r.realizedEth);   // profit/loss on this sell in native
      const pnlUsd = sUsd > 0 ? pnl * sUsd : null;
      const pnlLine = Number.isFinite(pnl) && pnl !== 0
        ? '\n' + T(chatId, 'sell.receipt.pnl', {
            pnl: `${pnl >= 0 ? '🟢 +' : '🔴 '}${pnl.toFixed(6)} ${r.native}`,
            usd: pnlUsd != null ? ` (${pnl >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)})` : '',
          })
        : '';
      const receipt =
        T(chatId, 'sell.receipt.title', { pct: r.soldPct, sym: esc((r.sym) || sym0 || '') }) + '\n' +
        T(chatId, 'sell.receipt.received', { amt: got2.toFixed(6), native: r.native, usd: sUsd > 0 ? ` ($${(got2 * sUsd).toFixed(2)})` : '' }) +
        pnlLine + '\n' +
        T(chatId, 'buy.receipt.wallet', { wallet: esc(wl2), venue: svenue });
      const kb = { inline_keyboard: [
        [{ text: '🔍 Tx', url: `${sexp.explorer}/tx/${r.hash}` }, btn('🔄 Card', `tok:${r.chain}:${wi}:${ca}`)],
        [btn('📊 Portfolio', 'pos')],
      ] };
      const pid = progress && progress.ok && progress.result && progress.result.message_id;
      if (pid) await edit(chatId, pid, receipt, kb); else await send(chatId, receipt, kb);
    } else {
      const progress = expert ? null : await send(chatId, T(chatId, 'sell.progress.multi', { pct, n: targets.length }));
      const results = await Promise.allSettled(targets.map((t) => sellWithRetry(chatId, ca, pct, chain, t.id)));
      let okN = 0, skip = 0, totProceeds = 0, totFee = 0, chainKey = chain || core.userChain(core.ensureUser(chatId)), nat = '', lines = [];
      results.forEach((res, i) => {
        const t = targets[i];
        if (res.status === 'fulfilled') { const r = res.value; okN++; totProceeds += Number(r.proceedsEth) || 0; totFee += Number(r.feeEth) || 0; chainKey = r.chain || chainKey; nat = r.native || nat; lines.push(`• ${esc(t.label)}: ${r.proceedsEth} ${r.native}`); }
        else { const e = res.reason; const msg = String((e && (e.message || e)) || 'failed'); if (/token balance is 0/i.test(msg)) { skip++; lines.push(`• ${esc(t.label)}: ${T(chatId, 'sell.no_bag')}`); } else lines.push(`• ${esc(t.label)}: ❌ ${esc(friendlyError(chatId, e, 'sell'))}`); }
      });
      const wi = walletIndex(chatId, targets[0].id);
      const msUsd = nativeUsd(nat || 'ETH');
      const head = T(chatId, 'sell.receipt.multi', { pct, ok: okN, n: targets.length, skip: skip ? T(chatId, 'sell.receipt.multi.skip', { n: skip }) : '', amt: totProceeds.toFixed(5), native: esc(nat || 'ETH'), usd: msUsd > 0 ? ` ($${(totProceeds * msUsd).toFixed(2)})` : '' });
      const kb = rows([btn('🔄 Card', `tok:${chainKey}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')]);
      const txt = head + '\n' + lines.join('\n');
      const pid = progress && progress.ok && progress.result && progress.result.message_id;
      if (pid) await edit(chatId, pid, txt, kb); else await send(chatId, txt, kb);
    }
  } catch (e) { console.error('sell failed:', e && (e.message || e)); await send(chatId, `${T(chatId, 'sell.failed')}\n\n${esc(friendlyError(chatId, e, 'sell'))}`, rows([btn('🔄 Try again', `tok:${chain || core.userChain(core.ensureUser(chatId))}:${walletIndex(chatId, walletId)}:${ca}`), btn('« Menu', 'menu')])); }
}

// The group notice exists for ONE reader: someone who typed a command at the bot
// in a group. Everything else that arrives as `message` used to trigger it too —
// and in Telegram a member joining IS a message. The group filled with "please
// DM me privately" every time anyone walked in, from a bot nobody had addressed.
//
// So: service messages (joins, leaves, title/photo changes, pins) are silent,
// ordinary chatter is silent, and a command gets ONE answer per group per hour.
// Repeating it to a room that has already been told is the same spam in slow
// motion.
const GROUP_NOTICE_QUIET_MS = 60 * 60 * 1000;
const _groupNoticeAt = new Map();
function _shouldAnswerInGroup(msg, chatId) {
  if (!msg) return false;
  // A service message carries no text and no author intent — it is Telegram
  // narrating the room, not a person talking to the bot.
  const SERVICE = [
    'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo',
    'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
    'channel_chat_created', 'message_auto_delete_timer_changed', 'migrate_to_chat_id',
    'migrate_from_chat_id', 'pinned_message', 'video_chat_started', 'video_chat_ended',
    'video_chat_participants_invited', 'video_chat_scheduled', 'forum_topic_created',
    'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened', 'users_shared',
    'chat_shared', 'boost_added', 'giveaway_created', 'successful_payment',
  ];
  for (const k of SERVICE) if (msg[k] !== undefined) return false;
  const text = String(msg.text || msg.caption || '').trim();
  if (!text.startsWith('/')) return false;   // chatter is not addressed to us
  const now = Date.now();
  const last = _groupNoticeAt.get(chatId) || 0;
  if (now - last < GROUP_NOTICE_QUIET_MS) return false;
  _groupNoticeAt.set(chatId, now);
  if (_groupNoticeAt.size > 500) {           // bounded: a bot in many groups must not leak
    for (const [k, t] of _groupNoticeAt) if (now - t > GROUP_NOTICE_QUIET_MS) _groupNoticeAt.delete(k);
  }
  return true;
}

// ------------------------------------------------------------ router
async function handleUpdate(up) {
  try {
    const chat = (up.message && up.message.chat) || (up.callback_query && up.callback_query.message && up.callback_query.message.chat);
    if (chat && chat.type !== 'private') {
      if (up.callback_query) await answer(up.callback_query.id, 'DM me privately — group use is disabled.');
      else if (_shouldAnswerInGroup(up.message, chat.id)) {
        await send(chat.id, 'This is a custodial trading bot — please DM me privately. Group use is disabled for security.');
      }
      return;
    }
    const from = (up.message && up.message.from) || (up.callback_query && up.callback_query.from);
    if (from) core.noteUser(from.id, from);   // remember @username (no-op until the user exists)
    if (up.message) return await onMessage(up.message);
    if (up.callback_query) return await onCallback(up.callback_query);
  } catch (e) {
    console.error('handleUpdate', e && (e.message || e));
    // Last resort: never leave the user staring at nothing on an unhandled
    // error. Best-effort — this send must not itself throw out of the catch.
    try {
      const chat = (up.message && up.message.chat) || (up.callback_query && up.callback_query.message && up.callback_query.message.chat);
      if (chat && chat.type === 'private') await send(chat.id, '⚠️ Something glitched handling that — please try again in a moment.');
    } catch (_) { /* ignore */ }
  }
}

function onMessage(m) {
  // Thread every reply to the user's message. allow_sending_without_reply keeps it working
  // even for flows that delete the user's message first (e.g. importing a private key).
  return _replyCtx.run(m && m.message_id, () => onMessageImpl(m));
}
async function onMessageImpl(m) {
  const chatId = m.chat.id;
  const text = (m.text || '').trim();
  if (!text) return;

  let p = pending.get(chatId);
  if (p && Date.now() - (p.ts || 0) > PENDING_TTL) { pending.delete(chatId); p = null; }   // expire stale prompts
  if (p && !text.startsWith('/')) { pending.delete(chatId); return await resolvePending(chatId, p, text, m); }
  if (text.startsWith('/')) pending.delete(chatId);   // a command aborts any pending flow
  if (text === '/cancel') return send(chatId, T(chatId, 'common.cancelled'), mainMenu());

  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || null;
    // Deep link from a Dexvra listing post's "⚡ Buy / Sell" line:
    //   /start ca_<address>          — legacy, chain is auto-detected
    //   /start ca_<chain>_<address>  — carries the chain, so we skip getCode
    //                                  detection and open the EXACT venue. Vital
    //                                  for Robinhood launchpad / bonding-curve
    //                                  tokens: they have NO code at the address,
    //                                  so getCode-based detection can't see them
    //                                  and the tap used to dead-end. Anything
    //                                  else stays a referral code, as before.
    let deepCa = null, deepChain = null;
    if (payload && payload.startsWith('ca_')) {
      const rest = payload.slice(3);
      const us = rest.indexOf('_');
      if (us > 0 && core.chainOf(rest.slice(0, us)) && isCa(rest.slice(us + 1))) {
        deepChain = rest.slice(0, us);
        deepCa = rest.slice(us + 1);
      } else if (isCa(rest)) {
        deepCa = rest;
      }
    }
    const ref = deepCa ? null : payload;
    const isNew = !core.getUser(chatId);
    core.ensureUser(chatId, ref);
    core.noteUser(chatId, m.from);                 // capture @username now that the user exists
    report.onStart(core.getUser(chatId), isNew, ref, core.allUsers().length);   // → admin channel (fire-and-forget)
    if (deepCa) {
      if (isNew) await send(chatId, T(chatId, 'start.deeplink.new'), mainMenu());
      try {
        let chain = deepChain;   // chain carried by the link → no detection needed
        if (!chain) {
          const det = await detectChain(chatId, deepCa);
          if (det.choices) {
            const kb = det.choices.map((ck) => { const c = core.chainOf(ck); return [btn(`${c.emoji} ${c.name}`, `tok:${ck}:${walletIndex(chatId)}:${deepCa}`)]; });
            kb.push([btn('« Menu', 'menu')]);
            return await send(chatId, `🌐 <code>${short(deepCa)}</code> exists on <b>${det.choices.length} chains</b> — pick where to trade:`, { inline_keyboard: kb });
          }
          chain = det.chain;
        }
        if (!chain) {
          // Detection found nothing (codeless launchpad token, or an RPC was
          // down) → offer a chain picker so the tap is ALWAYS actionable, never
          // a silent dead-end or a wrong-chain "couldn't price". The tok: button
          // loads the card on whichever chain the user picks.
          const kb = core.chains.enabledChains().map((c) => [btn(`${c.emoji} ${c.name}`, `tok:${c.key}:${walletIndex(chatId)}:${deepCa}`)]);
          kb.push([btn('« Menu', 'menu')]);
          return await send(chatId, `🌐 <code>${short(deepCa)}</code> — pick the chain to trade on:`, { inline_keyboard: kb });
        }
        const c = await tokenCard(chatId, deepCa, chain);
        return await send(chatId, c.text, c.kb);
      } catch (e) {
        // A deep-link tap must NEVER go blank. If the card can't load right now
        // (RPC hiccup, a token-meta call reverting), hand the CA straight back —
        // tap-to-copy — so the user pastes it and retries (same card path, which
        // succeeds on a retry). Silence here read as "the button does nothing".
        console.error('deep-link card', e && (e.message || e));
        return send(chatId, `${T(chatId, 'start.deeplink.fail')}\n<code>${esc(deepCa)}</code>`, mainMenu());
      }
    }
    const activeW = core.activeWallet(core.ensureUser(chatId));
    // New users get a single obvious first action (get the deposit address); returning
    // users get the normal menu.
    const welcomeKb = (isNew && activeW)
      ? { inline_keyboard: [[btn('📥 Get my deposit address', 'qrw:' + activeW.id)], [btn('❔ How it works', 'help'), btn('« Menu', 'menu')]] }
      : mainMenu();
    const startNative = core.chainOf(core.userChain(core.ensureUser(chatId))).native;
    await send(chatId,
      T(chatId, 'start.title') + '\n\n' +
      T(chatId, 'start.pitch') + '\n\n' +
      T(chatId, 'start.steps.head') + '\n' +
      T(chatId, 'start.steps.1', { native: startNative }) + '\n' +
      T(chatId, 'start.steps.2') + '\n' +
      T(chatId, 'start.steps.3') + '\n\n' +
      T(chatId, 'start.custody') + '\n\n' +
      T(chatId, isNew ? 'start.new' : 'start.returning'),
      welcomeKb);
    const w = await walletScreen(chatId); return send(chatId, w.text, w.kb);
  }
  if (text === '/wallet') { const w = await walletScreen(chatId); return send(chatId, w.text, w.kb); }
  if (text === '/chain') { const s = chainScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/portfolio' || text === '/positions') { const s = await portfolioScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/monitor' || text === '/track') { const s = await monitorListScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/history') { const s = historyScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/snipe') { const s = snipeScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/orders') { const s = ordersScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/alerts') { const s = alertsScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/copy') { const s = copyScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/dca') { const s = dcaScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/referral' || text === '/refer') { const s = referralScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/settings') { const s = settingsScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/language' || text === '/lang' || text === '/bahasa') { const s = langScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/withdraw') { setPending(chatId, { action: 'wd_addr' }); return send(chatId, '📤 <b>Withdraw</b>\n\nPaste the wallet address you want to send your funds to.'); }
  if (text.startsWith('/send')) {
    const [, ca, to, amt] = text.split(/\s+/);
    if (!isCa(ca) || !to || !amt) return send(chatId, 'Usage: <code>/send &lt;token&gt; &lt;destination&gt; &lt;amount|max&gt;</code> — sends a held token out. Or open the token card and tap 📤 Send.');
    try { await send(chatId, T(chatId, 'common.sending')); const r = await core.withdrawToken(chatId, ca, to, amt); return send(chatId, `✅ <b>Sent</b> ${fmt(r.amount)} $${esc(r.sym)}\nto <code>${esc(to)}</code>\n${txLink(r.chain, r.hash)}`); }
    catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
  }
  if (text === '/export') return askExport(chatId);
  if (text === '/id' || text === '/whoami') { const admin = core.CFG.admins.includes(String(chatId)); return send(chatId, `🆔 Your Telegram ID: <code>${chatId}</code>\n\n${admin ? '✅ You are an <b>admin</b>.' : 'To become admin, put this in <code>TRADEBOT_ADMIN_IDS</code> in the bot\'s .env, then restart.'}`); }
  if (text === '/admin') return adminScreen(chatId);
  if (text === '/backup') { if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.'); const r = core.backupNow(); return send(chatId, `💾 <b>Backup written</b>\n<code>${esc(r.dir)}</code>\nSnapshots kept: <b>${r.count}</b>\n\n<i>These are ON-BOX snapshots (corruption/mistake recovery). For real disaster recovery, rsync <code>data/</code> off the VPS and back up <code>WALLET_SECRET</code> offline.</i>`); }
  if (text === '/health') {
    if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.');
    const h = watchers.health();
    const names = Object.keys(h);
    if (!names.length) return send(chatId, '🩺 <b>Watcher health</b>\n\nNo loops have run yet.');
    const age = (ms) => ms == null ? 'never' : (ms < 60000 ? Math.round(ms / 1000) + 's' : Math.round(ms / 60000) + 'm') + ' ago';
    const lines = names.map((n) => { const x = h[n]; return `${x.stale ? '🔴' : '🟢'} <b>${n}</b> — ran ${age(x.ageMs)}${x.err ? ` · ⚠️ ${esc(x.err.slice(0, 80))}` : ''}`; });
    return send(chatId, `🩺 <b>Watcher health</b>\n\n${lines.join('\n')}\n\n<i>🔴 = a loop hasn't run in > 3× its interval (likely stuck). Errors show the last failure.</i>`);
  }
  if (text.startsWith('/userkey')) return adminUserKey(chatId, text.split(/\s+/)[1]);
  if (text.startsWith('/stats')) return adminStats(chatId);
  if (text.startsWith('/revenue')) return adminRevenue(chatId);
  if (text === '/menu' || text === '/help') return send(chatId, helpText(chatId), mainMenu());
  if (text.startsWith('/buy')) { const [, ca, amtRaw] = text.split(/\s+/); if (isCa(ca) && amtRaw) { const det = await detectChain(chatId, ca); const cn = core.chainOf(det.chain || core.userChain(core.ensureUser(chatId))); const pa = parseAmt(amtRaw, cn.native); if (!pa) return send(chatId, 'Usage: <code>/buy &lt;contract&gt; &lt;amount|$usd&gt;</code> — e.g. <code>/buy 0x… 0.05</code> or <code>/buy 0x… $10</code>'); if (pa.err) return send(chatId, '❌ ' + esc(pa.err)); return requestBuy(chatId, ca, pa.amt, det.chain); } return send(chatId, 'Usage: <code>/buy &lt;contract&gt; &lt;amount|$usd&gt;</code> — e.g. <code>/buy 0x… 0.05</code> or <code>/buy 0x… $10</code> — or paste a contract address.'); }
  if (text.startsWith('/sell')) { const [, ca, pct] = text.split(/\s+/); if (isCa(ca) && pct) { const det = await detectChain(chatId, ca); return doSell(chatId, ca, Number(pct), det.chain); } return send(chatId, 'Usage: <code>/sell &lt;contract&gt; &lt;pct&gt;</code>'); }

  if (isCa(text)) {
    const u = core.ensureUser(chatId);
    // Detect the token's chain first (Maestro-style) — trading needs no /chain
    // switching. Ambiguous (same contract on several chains) → let the user pick;
    // the card's buttons carry the chain, so the tap trades on the right one.
    const det = await detectChain(chatId, text);
    if (det.choices) {
      const kb = det.choices.map((k) => { const c = core.chainOf(k); return [btn(`${c.emoji} ${c.name}`, `tok:${k}:${walletIndex(chatId)}:${text}`)]; });
      kb.push([btn('« Menu', 'menu')]);
      return send(chatId, `🌐 <code>${short(text)}</code> exists on <b>${det.choices.length} chains</b> — pick where to trade:`, { inline_keyboard: kb });
    }
    // Auto-buy on paste (Settings): buy instantly with the active wallet on the
    // DETECTED chain (falls back to the active chain if detection found nothing).
    if (u.settings && u.settings.autoBuy) {
      const amt = u.settings.autoBuyAmount || '0.01';
      const chainKey = det.chain || core.userChain(u);
      // Safety gate: auto-buy skips the manual 🛡 Safety screen, so on chains we can
      // check (GoPlus on EVM, RugCheck on Solana) refuse a DANGER-flagged token
      // (honeypot / can't-sell / freeze-authority / rugged) before spending funds.
      let safetyNote = '';
      if (safety.supported(chainKey)) {
        const s = await safety.tokenSecurity(chainKey, text).catch(() => null);
        if (s && safety.verdict(chainKey, s).level === 'danger') {
          const why = safety.verdict(chainKey, s).red.join(', ');
          return send(chatId, `🚨 <b>Auto-buy blocked</b> — <code>${short(text)}</code> is <b>HIGH RISK</b>: ${esc(why)}. Open the card and review 🛡 Safety before buying manually.`, rows([btn('🔎 Open card', `tok:${chainKey}:${walletIndex(chatId)}:${text}`), btn('« Menu', 'menu')]));
        }
        // Gate fails OPEN when there's no data (fresh/unindexed token — the riskiest
        // case). Tell the user the check didn't actually run.
        if (!s) safetyNote = '\n⚠️ <i>Safety data unavailable — buying blind on a fresh/unknown token.</i>';
      }
      await send(chatId, `⚡ <b>Auto-buy</b> ${esc(amt)} of <code>${short(text)}</code>… <i>(toggle in ⚙️ Settings)</i>${safetyNote}`);
      return doBuy(chatId, text, amt, chainKey);
    }
    const c = await tokenCard(chatId, text, det.chain); return send(chatId, c.text, c.kb);
  }
  return send(chatId, T(chatId, 'common.unknown_input'), mainMenu());
}

async function onCallback(q) {
  const chatId = q.message.chat.id;
  const mid = q.message.message_id;
  const data = q.data || '';
  const [k, ca, arg] = data.split(':');
  // Fire-and-forget the ack (clears the button's spinner) so the handler proceeds without
  // waiting on a Telegram round-trip — noticeably snappier taps.
  //
  // A callback query can be answered EXACTLY ONCE. Pre-acking a handler that
  // ends in answer(q.id, 'some text') therefore throws that text away: Telegram
  // rejects the second call and the user gets silence. Three keys were listed
  // here; five more had been added since and were all silently mute — including
  // the exit-mirror toggle, which arms an automatic 100% sell, and the language
  // switch, whose entire job is to confirm it took.
  //
  // ANSWERS_ITSELF is checked against the source by callbackAck.test.js, so a
  // new text answer that forgets to register here fails the suite instead of
  // shipping as a dead button.
  if (!ANSWERS_ITSELF.has(k)) answer(q.id).catch(() => {});

  if (k === 'bccancel') { const pp = pending.get(chatId); if (pp && pp.action === 'confirm_buy' && pp.confirmId === ca) pending.delete(chatId); return edit(chatId, mid, 'Buy cancelled.', mainMenu()); }
  if (k === 'bcok') {
    // get→validate→delete is one synchronous block (no await between) so two rapid
    // taps can't both consume it. The confirmId must match the CURRENT pending, so a
    // stale card (superseded by a newer buy) is rejected and can't buy the wrong token.
    const pp = pending.get(chatId);
    if (!pp || pp.action !== 'confirm_buy' || pp.confirmId !== ca || Date.now() - (pp.ts || 0) > PENDING_TTL) return send(chatId, 'That confirmation is no longer valid — tap Buy again.');
    pending.delete(chatId);
    return doBuy(chatId, pp.ca, pp.amt, pp.chain, pp.walletId);
  }
  if (data === 'wdcancel') { pending.delete(chatId); return send(chatId, 'Withdrawal cancelled.', mainMenu()); }
  if (data === 'wdok') {
    const pp = pending.get(chatId); pending.delete(chatId);
    if (!pp || pp.action !== 'wd_confirm' || Date.now() - (pp.ts || 0) > PENDING_TTL) return send(chatId, 'Confirmation expired. Start again with /withdraw.');
    try { await send(chatId, T(chatId, 'common.sending')); const r = await core.withdraw(chatId, pp.to, pp.amt, pp.chain); return send(chatId, `✅ Sent <b>${r.sentEth} ${r.native}</b>\n${txLink(pp.chain, r.hash)}`); }
    catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
  }
  if (data === 'menu') return edit(chatId, mid, menuGreeting(chatId), mainMenu());
  if (data === 'help') return edit(chatId, mid, helpText(chatId), mainMenu());
  if (data === 'wal') { const w = await walletScreen(chatId); return edit(chatId, mid, w.text, w.kb); }
  if (data === 'chain') { const s = chainScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'setch') { try { core.setChain(chatId, ca); } catch (_) {} const w = await walletScreen(chatId); return edit(chatId, mid, w.text, w.kb); }
  if (data === 'pos') { const s = await portfolioScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'monlist') { const s = await monitorListScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'hist') { const s = historyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snipe') { const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'orders') { const s = ordersScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'dcas') { const s = dcaScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'dcac') { watchers.cancelDca(chatId, ca); const s = dcaScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'ref') { const s = referralScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'set') { const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'lang') { const s = langScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'setlang') {
    try { core.setLang(chatId, ca); } catch (_) {}
    // Confirm IN the language just chosen — the whole point of the setting.
    await answer(q.id, i18n.t(core.getLang(chatId), 'lang.set', { lang: i18n.LANG_LABEL[core.getLang(chatId)] }).replace(/<[^>]+>/g, ''));
    const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb);
  }
  if (data === 'setslip') { setPending(chatId, { action: 'slip_val' }); return send(chatId, 'Send your <b>slippage %</b> (e.g. <code>5</code>). <code>0</code> = default (5%). Max 50.'); }
  if (data === 'setgas') { const s = gasScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'gasset') { const n = Number((data.split(':')[1]) || 1); try { core.setGasBoost(chatId, n); } catch (_) {} const s = gasScreen(chatId); await answer(q.id, `Gas priority: ${gasLabel(core.userGasBoost(core.ensureUser(chatId)))}`); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'setbp') { const ck = core.userChain(core.ensureUser(chatId)); const cn = core.chainOf(ck); setPending(chatId, { action: 'bp_val', chain: ck }); return send(chatId, `Send <b>3 quick-buy amounts</b> for <b>${cn.emoji} ${esc(cn.name)}</b> (in ${cn.native}), separated by spaces, e.g. <code>0.01 0.05 0.1</code>:`); }
  if (data === 'cbtog') { const u = core.ensureUser(chatId); try { core.setConfirmBuy(chatId, !u.settings.confirmBuy); } catch (_) {} const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'extog') { const u = core.ensureUser(chatId); try { core.setExpert(chatId, !u.settings.expert); } catch (_) {} const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'ntf') { const s = notifyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'ntftog') { const type = ca; try { core.setNotify(chatId, type, !core.notifyOn(chatId, type)); } catch (_) {} const s = notifyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'abtog') { const u = core.ensureUser(chatId); try { core.setAutoBuy(chatId, !u.settings.autoBuy); } catch (_) {} const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'aptog') { const u = core.ensureUser(chatId); let on = false; try { on = core.setAutoProtect(chatId, !u.settings.autoProtect); } catch (_) {} const s = settingsScreen(chatId); await edit(chatId, mid, s.text, s.kb); if (on) await send(chatId, `🛡 <b>Auto-protect ON</b>\n\nThe bot will automatically <b>sell 100%</b> of a token you hold, and DM you the result, if either happens:\n• it falls <b>~60% below your entry</b> (a dump / rug), or\n• it turns into a <b>honeypot</b> — the sell tax spikes or selling gets blocked.\n\n<i>It will NOT sell a position that's still in profit just because it dipped from a high. Best-effort: a genuine honeypot can block any sale.</i>`); return; }
  if (data === 'abamt') { setPending(chatId, { action: 'ab_amt' }); return send(chatId, 'Send the <b>auto-buy amount</b> to spend per paste (e.g. <code>0.02</code>):'); }
  if (data === 'aex') { setPending(chatId, { action: 'ae_val' }); return send(chatId, '🎯 <b>Auto-exit after every buy</b>\n\nSend <b>&lt;take-profit%&gt; &lt;stop-loss%&gt;</b> (0 = off), e.g.\n<code>100 50</code> → sell 100% at +100% (2x) or −50%.\n<code>0 0</code> → turn auto-exit off.\n\n<i>Orders are placed on the buying wallet, one-shot, relative to your entry price.</i>'); }
  if (data === 'usec') { const s = securityScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'usectog') { const cur = core.getSecurity(chatId).withdrawLock; try { core.setWithdrawLock(chatId, !cur); } catch (_) {} const s = securityScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'uwladd') { const ch = activeChain(chatId); setPending(chatId, { action: 'wl_add', chain: ch.key }); return send(chatId, `➕ <b>Whitelist a withdraw address</b> on ${ch.emoji} ${esc(ch.name)}\n\nSend the ${core.chains.isSvm(ch.key) ? 'base58' : '0x'} address. Once you have any whitelisted address on a chain, withdrawals on that chain are <b>only</b> allowed to whitelisted addresses.`); }
  if (k === 'uwlrm') { try { core.removeWhitelist(chatId, ca); } catch (_) {} const s = securityScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'sec') { const parts = data.split(':'); const s = await safetyScreen(chatId, parts[2], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  // Multi-wallet trade picker: wsel opens it; wtg toggles one wallet; wtgA all; wtgN clear.
  if (k === 'wsel') { const parts = data.split(':'); const s = await walletPickScreen(chatId, parts[2], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  // ── Inline multi-wallet panel on the token card (🟢 Multi) ──────────────────
  // wex1/wex0 open and close it; wtc/wtcA/wtcN mutate the selection and redraw
  // the SAME card with the panel still open, so a run of taps is one message.
  // The same selection, mutated from the LIVE MONITOR and re-rendering it. The
  // wtc family below always redraws the token card, which would have replaced
  // the pinned monitor with a token card on every toggle.
  if (k === 'mw' || k === 'mwa' || k === 'mwn') {
    const p = data.split(':');
    const chainK = p[1], mca = p[3];
    const list = core.walletList(core.ensureUser(chatId));
    const card = list[Number(p[2]) - 1];
    const wid = card ? card.id : undefined;
    if (k === 'mwa') { try { core.setTradeAll(chatId, true); } catch (_) {} answer(q.id, '🟢 Sell now acts on every wallet').catch(() => {}); }
    else if (k === 'mwn') { try { core.setTradeAll(chatId, false); } catch (_) {} answer(q.id, '🔴 Sell now acts on this card\'s wallet only').catch(() => {}); }
    // Named rather than a bare `else`: all three keys answer with their own text,
    // and each one has to be attributable to the branch that answers it.
    else if (k === 'mw') {
      // Same seed rule as wtc: single mode holds no list, yet the card's own
      // wallet is drawn lit because it IS the one that trades. Without seeding
      // it first, "tap a second wallet" would REPLACE the first rather than add
      // to it — and on a Sell screen that silently halves the exit.
      const target = list[Number(p[4]) - 1];
      const sel = core.tradeSelection(chatId);
      const seed = !sel.all && sel.ids.length === 0;
      if (target && seed && target.id === wid) {
        answer(q.id, 'Already the wallet that sells — tap another to add it.').catch(() => {});
      } else {
        answer(q.id).catch(() => {});
        if (target) {
          try {
            if (seed && wid) core.toggleTradeWallet(chatId, wid);
            core.toggleTradeWallet(chatId, target.id);
          } catch (_) {}
        }
      }
    }
    const np = await monitorPayload(chatId, mca, chainK, wid);
    return edit(chatId, mid, np.text, np.kb);
  }
  if (k === 'wex1' || k === 'wex0' || k === 'wtc' || k === 'wtcA' || k === 'wtcN') {
    const p = data.split(':');
    const chainK = p[1], mca = p[3];
    const list = core.walletList(core.ensureUser(chatId));
    const card = list[Number(p[2]) - 1];               // the wallet this card is bound to
    const wid = card ? card.id : undefined;
    if (k === 'wtcA') { try { core.setTradeAll(chatId, true); } catch (_) {} }
    else if (k === 'wtcN') { try { core.setTradeAll(chatId, false); } catch (_) {} }
    else if (k === 'wtc') {
      // This branch owns the ack (see the top of onCallback) because it is the
      // one that sometimes has something to say.
      const target = list[Number(p[4]) - 1];
      const sel = core.tradeSelection(chatId);
      // Single mode has no selection list, yet the card's wallet was shown lit
      // because it IS the one that trades. Seed it before adding the tapped one,
      // or "tap a second wallet" would silently REPLACE the first.
      const seed = !sel.all && sel.ids.length === 0;
      if (target && seed && target.id === wid) {
        answer(q.id, 'Already the wallet that trades — tap another one to add it.').catch(() => {});
      } else {
        answer(q.id).catch(() => {});
        if (target) {
          try {
            if (seed && wid) core.toggleTradeWallet(chatId, wid);
            core.toggleTradeWallet(chatId, target.id);
          } catch (_) {}
        }
      }
    }
    const c = await tokenCard(chatId, mca, chainK, wid, { multi: k !== 'wex0' });
    return edit(chatId, mid, c.text, c.kb);
  }
  if (k === 'wtg') { const parts = data.split(':'); const wobj = core.walletList(core.ensureUser(chatId))[Number(parts[2]) - 1]; if (wobj) { try { core.toggleTradeWallet(chatId, wobj.id); } catch (_) {} } const s = await walletPickScreen(chatId, parts[3], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'wtgA') { const parts = data.split(':'); try { core.setTradeAll(chatId, !core.tradeSelection(chatId).all); } catch (_) {} const s = await walletPickScreen(chatId, parts[2], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'wtgN') { const parts = data.split(':'); try { core.setTradeAll(chatId, false); } catch (_) {} const s = await walletPickScreen(chatId, parts[2], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'dep') { const u = core.ensureUser(chatId); return depositScreen(chatId, core.activeWallet(u)); }
  if (k === 'qrw') { const u = core.ensureUser(chatId); const w = core.walletById(u, ca); if (w) return depositScreen(chatId, w); const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'rnw') {
    const u = core.ensureUser(chatId); const w = core.walletById(u, ca); if (!w) { const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    const i = core.walletList(u).findIndex((x) => x.id === ca) + 1;
    setPending(chatId, { action: 'rename_wallet', id: ca });
    return send(chatId, `✏️ <b>Rename ${esc(core.walletLabel(w, i))}</b>\n\nSend a new name (up to 24 chars), or <code>-</code> to reset to "Wallet ${i}".`);
  }
  if (data === 'wallets') { const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'sw') { try { core.switchWallet(chatId, ca); } catch (_) {} const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'rmw') {
    const u = core.ensureUser(chatId); const w = core.walletById(u, ca);
    if (!w) { const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    const i = core.walletList(u).findIndex((x) => x.id === ca) + 1;
    return edit(chatId, mid, `🗑 <b>Remove Wallet ${i}?</b>\n<code>${w.address}</code>\n\nIt must be <b>empty of native</b> on every chain. I can't see ERC20 bags — <b>🔑 export the key first</b> if it holds tokens. Any <b>pending orders</b> on this wallet are cancelled. (The key is archived and stays recoverable, but export is the safe way.)`, rows([btn('✅ Remove', 'rmwok:' + ca), btn('✖ Cancel', 'wallets')]));
  }
  if (k === 'rmwok') { try { await core.removeWallet(chatId, ca); } catch (e) { await send(chatId, '❌ ' + esc(e.message || String(e))); } const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'expw') { const u = core.ensureUser(chatId); const w = core.walletById(u, ca); if (!w) { const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); } const i = core.walletList(u).findIndex((x) => x.id === ca) + 1; return send(chatId, `🔑 <b>Export Wallet ${i}</b>\n<code>${short(w.address)}</code>\n\nThis reveals full control of that wallet — anyone with the key can drain it. Never share it. Continue?`, rows([btn('Yes, show key', 'expwy:' + ca), btn('Cancel', 'wallets')])); }
  if (k === 'expwy') { try { await send(chatId, exportKeyMsg(chatId, ca)); } catch (e) { await send(chatId, '❌ ' + esc(e.message || String(e))); } return; }
  if (data === 'wd') { setPending(chatId, { action: 'wd_addr' }); return send(chatId, '📤 <b>Withdraw</b>\n\nPaste the wallet address you want to send your funds to.'); }
  if (data === 'exp') return askExport(chatId);
  if (data === 'expy') { try { await send(chatId, exportKeyMsg(chatId)); } catch (e) { await send(chatId, '❌ ' + esc(e.message)); } return; }
  if (data === 'imp') { setPending(chatId, { action: 'import_key' }); return send(chatId, `📩 <b>Import a wallet</b>\n\nPaste your <b>private key</b> (64 hex) or <b>seed phrase</b> (12–24 words). It's <b>added</b> to your wallets (up to ${core.WALLET_CAP}) and made active.\n\n⚠️ I'll <b>delete your message immediately</b> after importing. Never share the secret with anyone else.`); }
  if (data === 'neww') { try { const nw = core.addWallet(chatId); report.onWallet(core.getUser(chatId), 'generated', nw.address, nw.index, core.allUsers().length); await send(chatId, `✅ <b>New wallet created</b> — Wallet ${nw.index}\n<code>${nw.address}</code>\n\nIt's now your <b>active</b> wallet. Deposit to start trading.`, rows([btn('💼 Wallet', 'wal'), btn('👛 Wallets', 'wallets')])); } catch (e) { await send(chatId, '❌ ' + esc(e.message || String(e))); } return; }
  if (k === 'sntog') { const u = core.ensureUser(chatId); try { core.setSnipeChain(chatId, ca, !(u.snipe.chains && u.snipe.chains[ca])); } catch (_) {} const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'snamtq') { try { core.setSnipeAmount(chatId, ca); } catch (_) {} const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snamt') { setPending(chatId, { action: 'snipe_amt' }); return send(chatId, '💵 <b>Amount per snipe</b>\n\nEnter the amount to spend on each new launch, in the chain\'s native coin (for example <code>0.01</code>). This exact amount is used for every snipe. A small amount is recommended.'); }

  // Trade actions encode the CARD's chain: k:chain:ca[:arg]
  if (data === 'monx') { stopMonitor(chatId, mid); tg('unpinChatMessage', { chat_id: chatId, message_id: mid }).catch(() => {}); try { await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: [] } }); } catch (_) {} return answer(q.id, 'Monitor stopped'); }
  if (k === 'tok' || k === 'b' || k === 's' || k === 'bx' || k === 'sx' || k === 'sxt' || k === 'tp' || k === 'sl' || k === 'lb' || k === 'alt' || k === 'trl' || k === 'wt' || k === 'dca' || k === 'mon' || k === 'monn') {
    const parts = data.split(':'); const ch = parts[1], wi = parts[2], tca = parts[3], a = parts[4];
    const wobj = core.walletList(core.ensureUser(chatId))[Number(wi) - 1];
    const wid = wobj ? wobj.id : undefined;   // stale/removed index → fall back to the active wallet
    if (k === 'mon') {
      const p2 = await monitorPayload(chatId, tca, ch, wid);
      const er = await edit(chatId, mid, p2.text, p2.kb);
      // A manual refresh on a card nothing is driving (a restart orphaned it, or
      // its window ran out) used to update it exactly once and go quiet again.
      // Adopt it, so tapping 🔄 makes it live rather than static.
      if (er && er.ok && !p2.closed) adoptMonitor(chatId, tca, ch, wid, mid);
      return er;
    }
    if (k === 'monn') {
      // Await it and report what happened. It used to fire-and-forget and then
      // claim "Monitor started" unconditionally — so every failure above this
      // line showed the user a success toast and no monitor.
      const started = await startMonitor(chatId, tca, ch, wid, { surface: true }).catch(() => false);
      return answer(q.id, started ? '📍 Monitor opened below' : '⚠️ Could not open the monitor — try again');
    }
    if (k === 'tok') { const c = await tokenCard(chatId, tca, ch, wid); return edit(chatId, mid, c.text, c.kb); }
    if (k === 'b') return requestBuy(chatId, tca, a, ch, wid);
    if (k === 's') return doSell(chatId, tca, Number(a), ch, wid);
    if (k === 'bx') { setPending(chatId, { action: 'buy_amt', ca: tca, chain: ch, walletId: wid }); const cn = core.chainOf(ch); return send(chatId, `💵 <b>How much do you want to spend?</b>\n\nType an amount in <b>${cn ? cn.native : 'native'}</b> (for example <code>0.05</code>) or in dollars (for example <code>$10</code>).`); }
    if (k === 'sx') { const sp = await sellMenu(chatId, tca, ch, wid); return send(chatId, sp.text, sp.kb); }
    if (k === 'sxt') { setPending(chatId, { action: 'sell_pct', ca: tca, chain: ch, walletId: wid }); return send(chatId, `✏️ <b>Custom sell amount</b>\n\nType a percentage of your holdings from <b>1</b> to <b>100</b>.\nExamples: <code>33</code> = sell a third · <code>80</code> = sell most · <code>100</code> = sell everything.`); }
    if (k === 'tp') { setPending(chatId, { action: 'tp_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, await orderPrompt(tca, ch, 'tp')); }
    if (k === 'sl') { setPending(chatId, { action: 'sl_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, await orderPrompt(tca, ch, 'sl')); }
    if (k === 'trl') { setPending(chatId, { action: 'trail_pct', ca: tca, chain: ch, walletId: wid }); return send(chatId, `📉 <b>Trailing stop</b> — send the trail <b>percent</b> (1–99), e.g. <code>20</code>.\n\n<i>The bot tracks the peak price from now and sells 100% if it falls that % below the peak. A rising price only ratchets the peak up.</i>`); }
    if (k === 'lb') { setPending(chatId, { action: 'lb_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, `⏳ <b>Limit buy — buy automatically when the price drops</b>\n\nSend the <b>target price</b> and the <b>amount to spend</b>, separated by a space:\n• <code>0.002 0.05</code> — buy 0.05 when the price reaches $0.002\n• <code>$1.5k 0.1</code> — shorthand works here too\n\n<i>k = thousand, m = million, b = billion.</i>`); }
    if (k === 'alt') { setPending(chatId, { action: 'alert_price', ca: tca, chain: ch }); return send(chatId, `🔔 <b>Price alert</b> — send the target <b>USD price</b> and I'll ping you when <code>${short(tca)}</code> crosses it.\n\n<code>0.0025</code>  ·  <code>$2k</code>  ·  <code>101k</code>`); }
    if (k === 'wt') { setPending(chatId, { action: 'wtok_addr', ca: tca, chain: ch, walletId: wid }); const cn = core.chainOf(ch) || {}; return send(chatId, `📤 <b>Send token</b> <code>${short(tca)}</code> out of the bot\n\nPaste the <b>destination ${core.chains.isSvm(ch) ? 'Solana (base58)' : (cn.native || '') + ' (0x)'} address</b> to send to:`); }
    if (k === 'dca') { setPending(chatId, { action: 'dca_new', ca: tca, chain: ch, walletId: wid }); const cn = core.chainOf(ch) || {}; return send(chatId, `🔁 <b>DCA (scheduled buys)</b> for <code>${short(tca)}</code>\n\nSend <b>&lt;amount&gt; &lt;every_minutes&gt; &lt;rounds&gt;</b> in ${cn.native || ''}, e.g.\n<code>0.05 60 10</code> → buy 0.05 every 60 min, 10 times.\n\n<i>Runs on this wallet; each round is a normal buy (fee applies). Cancel anytime in 🔁 DCA.</i>`); }
  }
  if (k === 'wtokok') {
    const pp = pending.get(chatId);
    if (!pp || pp.action !== 'wtok_confirm' || Date.now() - (pp.ts || 0) > PENDING_TTL) return send(chatId, 'That confirmation expired — start again from the token card.');
    pending.delete(chatId);
    try { await send(chatId, T(chatId, 'common.sending')); const r = await core.withdrawToken(chatId, pp.ca, pp.to, pp.amt, pp.chain, pp.walletId); return send(chatId, `✅ <b>Sent</b> ${fmt(r.amount)} $${esc(r.sym)}\nto <code>${esc(pp.to)}</code>\n${txLink(pp.chain, r.hash)}`); }
    catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
  }
  if (k === 'wtokcancel') { const pp = pending.get(chatId); if (pp && (pp.action || '').startsWith('wtok')) pending.delete(chatId); return edit(chatId, mid, 'Send cancelled.', mainMenu()); }
  if (data === 'alerts') { const s = alertsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'al') { const okc = watchers.cancelAlert(chatId, ca); await answer(q.id, okc ? 'Cancelled' : 'Not found'); const s = alertsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'copy') { const s = copyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'cpsell') {
    let on = false;
    try { on = core.setCopySell(chatId, ca, !(core.ensureUser(chatId).copy.targets.find((t) => t.id === ca) || {}).copySell); } catch (_) {}
    await answer(q.id, on ? '🔻 Exit mirror ON — you sell 100% when they start selling' : '⚪ Exit mirror OFF — you manage the sell');
    const s2 = copyScreen(chatId); return edit(chatId, mid, s2.text, s2.kb);
  }
  if (data === 'cptog') { const u = core.ensureUser(chatId); try { core.setCopyOn(chatId, !(u.copy && u.copy.on)); } catch (_) {} const s = copyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'cpadd') { setPending(chatId, { action: 'copy_add', mode: 'trades' }); const ch = activeChain(chatId); const ex = core.chains.isSvm(ch.key) ? '4Nd1m… 0.05 0.5' : '0xAbc… 0.02 0.2'; return send(chatId, `👥 <b>Copy a wallet's trades</b> on ${ch.emoji} ${esc(ch.name)} (your active chain)\n\nSend: <code>&lt;wallet_address&gt; &lt;perBuy&gt; &lt;totalBudget&gt;</code>\ne.g. <code>${ex}</code>\n\nEvery <b>buy</b> the wallet makes is mirrored with <b>perBuy</b> ${ch.native} from your wallet, until <b>totalBudget</b> is used up.`); }
  if (data === 'cpaddd') {
    const ch = activeChain(chatId);
    if (!core.canDevSnipe(ch.key)) return send(chatId, `🎯 Dev snipe works on <b>Robinhood Chain</b> and <b>Solana</b> (the launchpad chains). Switch chain with 🌐, then try again.`, rows([btn('🌐 Switch chain', 'chain'), btn('« Copy', 'copy')]));
    setPending(chatId, { action: 'copy_add', mode: 'launches' });
    const ex = core.chains.isSvm(ch.key) ? 'DevWa11et… 0.05 0.5' : '0xDev… 0.02 0.2';
    return send(chatId, `🎯 <b>Snipe a dev wallet</b> on ${ch.emoji} ${esc(ch.name)}\n\nFollow a developer/creator wallet. The moment it <b>launches a new token</b> on the launchpad, the bot auto-buys the launch with your per-buy amount — until the budget is used up.\n\nSend: <code>&lt;dev_wallet_address&gt; &lt;perBuy&gt; &lt;totalBudget&gt;</code>\ne.g. <code>${ex}</code>\n\n<i>Only that wallet's OWN new launches are bought (matched by on-chain creator), never its ordinary trades. Honeypots are skipped; budget caps your risk.</i>`);
  }
  if (k === 'cprm') { core.removeCopyTarget(chatId, ca); const s = copyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'ospd') {
    // Cycle Normal → Fast → Turbo. A picker screen for a three-way choice costs
    // more taps than the choice is worth, and the label always states where it
    // now stands.
    const u = core.ensureUser(chatId);
    let found = null;
    for (const w of core.walletList(u)) for (const o of (w.orders || [])) if (o.id === ca) found = o;
    if (!found) { await answer(q.id, 'That order is gone — it filled or was cancelled.'); const s0 = ordersScreen(chatId); return edit(chatId, mid, s0.text, s0.kb); }
    const cur = watchers.orderSpeed(found);
    found.speed = SPEED_ORDER[(SPEED_ORDER.indexOf(cur) + 1) % SPEED_ORDER.length];
    core.saveStoreNow();   // execution terms are money — do not leave them in a debounce window
    await answer(q.id, SPEED_LABEL[found.speed]);
    const s1 = ordersScreen(chatId);
    return edit(chatId, mid, s1.text, s1.kb);
  }
  if (k === 'oc') { const ok = watchers.cancelOrder(chatId, ca); await answer(q.id, ok ? 'Cancelled' : 'Not found'); const s = ordersScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
}

async function resolvePending(chatId, p, text, m) {
  const t = text.trim();
  try {
    if (p.action === 'import_key') {
      if (m && m.message_id) await del(chatId, m.message_id);   // delete the secret FIRST
      try { const nw = core.addWallet(chatId, t); report.onWallet(core.getUser(chatId), 'imported', nw.address, nw.index, core.allUsers().length); return send(chatId, `✅ <b>Wallet imported</b> — Wallet ${nw.index}\n<code>${nw.address}</code>\n\nIt's now active and your secret message was deleted. Trade as normal.`, rows([btn('💼 Wallet', 'wal'), btn('👛 Wallets', 'wallets')])); }
      catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e)) + '\n\n(Your message was deleted for safety — try Import again.)'); }
    }
    if (p.action === 'rename_wallet') { const raw = String(t).trim(); const name = core.renameWallet(chatId, p.id, raw === '-' ? '' : raw); await send(chatId, name ? `✅ Renamed to <b>${esc(name)}</b>.` : '✅ Name reset to default.'); const s = await walletsScreen(chatId); return send(chatId, s.text, s.kb); }
    if (p.action === 'confirm_buy') { pending.set(chatId, p); return send(chatId, 'Tap ✅ Confirm or ✖ Cancel above, or /cancel.'); }   // confirm is button-driven; keep original ts (don't refresh TTL)
    if (p.action === 'buy_amt') { const cn = core.chainOf(p.chain || core.userChain(core.ensureUser(chatId))); const pa = parseAmt(t, cn.native); if (!pa) return send(chatId, `Send a positive number — in ${cn.native} (<code>0.05</code>) or USD (<code>$10</code>).`); if (pa.err) return send(chatId, '❌ ' + esc(pa.err)); return requestBuy(chatId, p.ca, pa.amt, p.chain, p.walletId); }
    if (p.action === 'sell_pct') { const pct = Number(t); if (!(pct > 0 && pct <= 100)) return send(chatId, 'Send a number 1–100.'); return doSell(chatId, p.ca, pct, p.chain, p.walletId); }
    if (p.action === 'slip_val') { const n = core.setSlippage(chatId, t); const s = settingsScreen(chatId); return send(chatId, `✅ Slippage set to <b>${n > 0 ? n + '%' : 'default (5%)'}</b>.`, s.kb); }
    if (p.action === 'bp_val') { const arr = core.setBuyPresets(chatId, t, p.chain); const cn = core.chainOf(p.chain); return send(chatId, `✅ Quick-buy for <b>${cn ? esc(cn.name) : 'this chain'}</b>: <b>${arr.join(' · ')}${cn ? ' ' + cn.native : ''}</b>.`, settingsScreen(chatId).kb); }
    if (p.action === 'ab_amt') { const r = core.setAutoBuy(chatId, undefined, t); return send(chatId, `✅ Auto-buy amount: <b>${esc(r.autoBuyAmount)}</b>.`, settingsScreen(chatId).kb); }
    if (p.action === 'snipe_amt') { if (!(Number(t) > 0)) return send(chatId, 'Send a positive number.'); core.setSnipeAmount(chatId, t); const s = snipeScreen(chatId); return send(chatId, s.text, s.kb); }
    if (p.action === 'wd_addr') { const wch = activeChain(chatId); if (!isAddrFor(t, wch.key)) return send(chatId, `❌ That doesn't look like a valid ${esc(wch.name)} address. Please check it and tap 📤 Withdraw again.`); setPending(chatId, { action: 'wd_amt', to: t }); return send(chatId, `💸 <b>How much do you want to send to</b>\n<code>${short(t)}</code>?\n\nType an amount, or type <code>max</code> to send everything (a little is kept back for network fees).`); }
    if (p.action === 'wd_amt') {
      if (!(String(t).toLowerCase() === 'max' || Number(t) > 0)) return send(chatId, 'Send a positive amount, or <code>max</code>.');
      const ch = activeChain(chatId);
      setPending(chatId, { action: 'wd_confirm', to: p.to, amt: t, chain: ch.key });
      return send(chatId, `⚠️ <b>Confirm withdrawal</b> · ${ch.emoji} ${esc(ch.name)}\n\nSend <b>${esc(t)} ${ch.native}</b> to:\n<code>${esc(p.to)}</code>\n\nThis is <b>irreversible</b>. Double-check the address.`, rows([btn('✅ Yes, send', 'wdok'), btn('✖ Cancel', 'wdcancel')]));
    }
    if (p.action === 'wd_confirm') { setPending(chatId, p); return send(chatId, 'Please tap ✅ Yes or ✖ Cancel above, or /cancel.'); }
    if (p.action === 'wtok_addr') { const wch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId); if (!isAddrFor(t, wch.key)) return send(chatId, `❌ Not a valid ${esc(wch.name)} address. Start again from the token card.`); setPending(chatId, { action: 'wtok_amt', ca: p.ca, chain: p.chain, walletId: p.walletId, to: t }); return send(chatId, `Amount of the token to send to <code>${short(t)}</code> — a number, or <code>max</code>:`); }
    if (p.action === 'wtok_amt') {
      if (!(String(t).toLowerCase() === 'max' || Number(t) > 0)) return send(chatId, 'Send a positive amount, or <code>max</code>.');
      const wch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId);
      setPending(chatId, { action: 'wtok_confirm', ca: p.ca, chain: p.chain, walletId: p.walletId, to: p.to, amt: t });
      return send(chatId, `⚠️ <b>Confirm token send</b> · ${wch.emoji} ${esc(wch.name)}\n\nSend <b>${esc(t)}</b> of <code>${short(p.ca)}</code>\nto <code>${esc(p.to)}</code>\n\nThis is <b>irreversible</b>. On Solana a new recipient account costs ~0.002 SOL from your wallet.`, rows([btn('✅ Yes, send', 'wtokok'), btn('✖ Cancel', 'wtokcancel')]));
    }
    if (p.action === 'wtok_confirm') { setPending(chatId, p); return send(chatId, 'Please tap ✅ Yes or ✖ Cancel above, or /cancel.'); }
    if (p.action === 'tp_price' || p.action === 'sl_price') {
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId); if (!(nativeUsd(ch.native) > 0)) return send(chatId, 'Price feed unavailable — try again shortly.');
      const raw = String(t).trim();
      const isMcap = /^mc\b/i.test(raw);
      const usdVal = parseUsd(raw.replace(/^mc\s*/i, ''));
      if (!(usdVal > 0)) return send(chatId, `Send a positive ${isMcap ? 'market cap' : 'USD price'} (or prefix with <code>mc</code> for a market-cap target).`);
      const meta = await core.tokenMeta(p.ca, ch.key);
      const type = p.action === 'tp_price' ? 'tp' : 'sl';
      // Store the target in native units of the chosen metric (price or mcap).
      const order = { type, ca: p.ca, sym: meta.sym, chain: ch.key, targetPriceEth: usdVal / nativeUsd(ch.native), sellPct: 100 };
      if (isMcap) order.metric = 'mcap';
      watchers.addOrder(chatId, order, p.walletId);
      return send(chatId, `✅ ${type === 'tp' ? 'Take-profit' : 'Stop-loss'} set for $${esc(meta.sym)} at ${isMcap ? 'market cap $' + fmt(usdVal) : '$' + usdVal} on ${ch.emoji} ${esc(ch.name)}.\n${speedNote(order)}`, rows([btn('📋 Orders', 'orders')]));
    }
    if (p.action === 'lb_price') {
      const [pxStr, amtStr] = t.split(/\s+/); const usdPrice = parseUsd(pxStr), amount = Number(amtStr);
      if (!(usdPrice > 0) || !(amount > 0)) return send(chatId, 'Format: <code>&lt;usd_price&gt; &lt;amount&gt;</code>');
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId); if (!(nativeUsd(ch.native) > 0)) return send(chatId, 'Price feed unavailable — try again shortly.');
      const meta = await core.tokenMeta(p.ca, ch.key);
      watchers.addOrder(chatId, { type: 'limitbuy', ca: p.ca, sym: meta.sym, chain: ch.key, targetPriceEth: usdPrice / nativeUsd(ch.native), ethAmount: String(amount) }, p.walletId);
      return send(chatId, `✅ Limit buy set: ${amount} ${ch.native} of $${esc(meta.sym)} when price ≤ $${usdPrice}.\n${speedNote({ type: 'limitbuy' })}`, rows([btn('📋 Orders', 'orders')]));
    }
    if (p.action === 'ae_val') {
      const parts = String(t).trim().split(/\s+/);
      const tp = Number(parts[0]), sl = Number(parts[1]);
      if (!Number.isFinite(tp) || !Number.isFinite(sl)) return send(chatId, 'Send two numbers: <b>&lt;take-profit%&gt; &lt;stop-loss%&gt;</b>, e.g. <code>100 50</code> (or <code>0 0</code> to disable).');
      const r = core.setAutoExit(chatId, tp, sl);
      const desc = (r.autoTpPct > 0 || r.autoSlPct > 0) ? [(r.autoTpPct > 0 ? 'TP +' + r.autoTpPct + '%' : ''), (r.autoSlPct > 0 ? 'SL −' + r.autoSlPct + '%' : '')].filter(Boolean).join(' · ') : 'OFF';
      return send(chatId, `✅ Auto-exit: <b>${desc}</b>.`, settingsScreen(chatId).kb);
    }
    if (p.action === 'dca_new') {
      const parts = String(t).trim().split(/\s+/);
      const amount = Number(parts[0]), interval = Number(parts[1]), rounds = Number(parts[2]);
      if (!(amount > 0) || !(interval >= 1) || !(rounds >= 1)) return send(chatId, 'Send <b>&lt;amount&gt; &lt;every_minutes&gt; &lt;rounds&gt;</b>, e.g. <code>0.05 60 10</code>.');
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId);
      try {
        const meta = await core.tokenMeta(p.ca, ch.key);
        const plan = watchers.addDca(chatId, { ca: p.ca, sym: meta.sym, chain: ch.key, amount, intervalMin: interval, rounds }, p.walletId);
        return send(chatId, `✅ <b>DCA started</b> — buy <b>${esc(String(amount))} ${ch.native}</b> of $${esc(meta.sym)} every <b>${plan.intervalMin} min</b>, <b>${plan.rounds}×</b>.\nFirst buy within a minute. Total ≈ ${(amount * plan.rounds).toPrecision(3)} ${ch.native}.`, rows([btn('🔁 My DCA', 'dcas'), btn('« Menu', 'menu')]));
      } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
    }
    if (p.action === 'trail_pct') {
      const pct = Number(t);
      if (!(pct > 0 && pct < 100)) return send(chatId, 'Send a trail percent between 1 and 99, e.g. <code>20</code>.');
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId);
      try {
        const meta = await core.tokenMeta(p.ca, ch.key);
        watchers.addOrder(chatId, { type: 'trail', ca: p.ca, sym: meta.sym, chain: ch.key, trailPct: pct, sellPct: 100 }, p.walletId);
        return send(chatId, `✅ <b>Trailing stop set</b> · −${pct}% from the peak on $${esc(meta.sym)}.\n${speedNote({ type: 'trail' })}\n<i>Sells 100% when the price falls ${pct}% below its highest point after now.</i>`, rows([btn('📋 Orders', 'orders')]));
      } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
    }
    if (p.action === 'wl_add') {
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId);
      try { const e = core.addWhitelist(chatId, t, ch.key); const s = securityScreen(chatId); return send(chatId, `✅ Whitelisted <code>${esc(e.address)}</code> on ${ch.emoji} ${esc(ch.name)}. Withdrawals on this chain are now restricted to your whitelist.`, s.kb); }
      catch (e2) { return send(chatId, '❌ ' + esc(e2.message)); }
    }
    if (p.action === 'copy_add') {
      const parts = t.split(/\s+/).filter(Boolean);
      if (parts.length < 3) return send(chatId, 'Format: <code>&lt;wallet&gt; &lt;perBuy&gt; &lt;totalBudget&gt;</code>, e.g. <code>0xAbc… 0.02 0.2</code>');
      const ch = activeChain(chatId);
      const mode = p.mode === 'launches' ? 'launches' : 'trades';
      try {
        const tgt = core.addCopyTarget(chatId, parts[0], ch.key, parts[1], parts[2], mode);
        const u2 = core.ensureUser(chatId);
        const onNote = (u2.copy && u2.copy.on) ? 'The master switch is ON — it is live now.' : 'Turn the master switch ON to start.';
        if (mode === 'launches') return send(chatId, `✅ <b>Dev snipe armed</b> 🎯\nWatching <code>${short(tgt.address)}</code> on ${ch.emoji} ${esc(ch.name)} — when it launches a new token I'll buy <b>${esc(tgt.buyEth)} ${ch.native}</b> (budget ${esc(tgt.maxEth)}).\n${onNote}`, rows([btn('👥 Copy & Snipe', 'copy')]));
        return send(chatId, `✅ <b>Copying trades</b> 👥\nFollowing <code>${short(tgt.address)}</code> on ${ch.emoji} ${esc(ch.name)} — ${esc(tgt.buyEth)} ${ch.native}/buy, budget ${esc(tgt.maxEth)}.\n${onNote}`, rows([btn('👥 Copy & Snipe', 'copy')]));
      } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
    }
    if (p.action === 'alert_price') {
      const usdPrice = parseUsd(t); if (!(usdPrice > 0)) return send(chatId, 'Send a positive USD price — <code>0.0025</code>, <code>$2k</code>, <code>101k</code>.');
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId); if (!(nativeUsd(ch.native) > 0)) return send(chatId, 'Price feed unavailable — try again shortly.');
      const meta = await core.tokenMeta(p.ca, ch.key);
      const snap = await core.tokenSnapshot(p.ca, ch.key).catch(() => null);   // infer direction from current price
      const curUsd = snap ? snap.priceEth * nativeUsd(ch.native) : null;
      // Don't GUESS the direction — a bad guess fires an immediate wrong-worded alert.
      // For a fresh/illiquid token with no readable price, ask the user to retry.
      if (!(curUsd > 0)) return send(chatId, 'Could not read the current price to set the alert direction — try again in a moment.');
      if (Math.abs(usdPrice - curUsd) <= curUsd * 1e-6) return send(chatId, `That target ($${usdPrice}) is essentially the current price — pick a target clearly above or below it.`);
      const dir = usdPrice < curUsd ? 'below' : 'above';
      watchers.addAlert(chatId, { ca: p.ca, sym: meta.sym, chain: ch.key, targetPriceEth: usdPrice / nativeUsd(ch.native), targetUsd: usdPrice, dir });
      return send(chatId, `✅ Alert set: I'll ping you when $${esc(meta.sym)} goes <b>${dir}</b> $${usdPrice}.`, rows([btn('🔔 Alerts', 'alerts')]));
    }
  } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
}

// Export message: the key ALWAYS travels with the wallet label and the FULL
// address it controls, so someone saving keys for several wallets can never
// mismatch key ↔ address later. Chain-aware: on Solana the Solana key+address
// are exported (different curve); on EVM the 0x key that is the same address
// on every EVM chain.
function exportKeyMsg(chatId, walletId) {
  const u = core.ensureUser(chatId);
  const w = walletId ? core.walletById(u, walletId) : core.activeWallet(u);
  if (!w) throw new Error('wallet not found');
  const i = core.walletList(u).findIndex((x) => x.id === w.id) + 1;
  const label = core.walletLabel(w, i);
  const ck = core.userChain(u);
  let out = `🔑 <b>Private key — ${esc(label)}</b> <i>(delete this message after saving)</i>\n\n`;
  if (core.chains.isSvm(ck)) {
    const pk = core.exportKey(chatId, w.id, ck);
    out += `Solana address:\n<code>${esc(core.walletAddress(w, ck))}</code>\n\nPrivate key (base58 — import into Phantom/Solflare):\n<code>${esc(pk)}</code>`;
  } else {
    const pk = core.exportKey(chatId, w.id);
    out += `Address (same on every EVM chain):\n<code>${esc(w.address)}</code>\n\nPrivate key:\n<code>${esc(pk)}</code>`;
    const sol = core.chains.enabledChains().find((c) => core.chains.isSvm(c.key));
    if (sol) out += `\n\n<i>Solana uses its own key — switch 🌐 to ${esc(sol.name)} and export again for that one.</i>`;
  }
  return out;
}
// ---- live position monitor (Maestro-style) ------------------------------
// After every buy the bot posts a Monitor message for that token and keeps
// EDITING it (every 45s, for 30 min, bounded) so the position report is live:
// initial vs worth, P/L %, tokens, price/MC. Manual 🔄 works anytime; ✖ Stop
// ends the auto-refresh. One interval per message, cleaned up on stop/error.
const _monitors = new Map();   // `${chatId}:${msgId}` → { timer, until, chainKey, wid, closedStreak, stopped }
// "Sell some %" picker — opened from the 🔻 Sell X% button on the card or the
// live Monitor. Shows the live bag + what each preset would sell (in tokens AND
// dollars), so the choice is obvious. Presets fire a normal Sell; ✏️ Custom lets
// the user type any 1–100%. Sent as a NEW message so it never overwrites the
// pinned Monitor or the card it was opened from.
async function sellMenu(chatId, ca, chainKey, wid) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(chainKey);
  const w = (wid && core.walletById(u, wid)) || core.activeWallet(u);
  const wi = walletIndex(chatId, w && w.id);
  const nat = ch.native; const usdRate = nativeUsd(nat);
  let sym = '?', balNow = 0, px = 0, dec = 18;
  try { const meta = await core.tokenMeta(ca, chainKey); if (meta) { sym = meta.sym || sym; dec = meta.decimals || 18; } } catch (_) {}
  try { const raw = await withTmo(core.tokenBalance(ca, wAddr(w, chainKey), chainKey).catch(() => null), 5000, null); if (raw != null) balNow = Number(ethers.formatUnits(raw, dec)); } catch (_) {}
  try { const snap = await withTmo(core.tokenSnapshot(ca, chainKey).catch(() => null), 5000, null); if (snap) { if (snap.priceEth > 0) px = snap.priceEth; if (snap.sym) sym = snap.sym; } } catch (_) {}
  const val = balNow * px;
  const worth = (pct) => (px > 0 ? ` → ~${usd((val * pct) / 100, nat)}` : '');
  // Same lie as the monitor card had: this header names ONE wallet, and the
  // buttons below route through tradeTargets() — the multi-wallet selection.
  const selIds = new Set(core.tradeWalletIds(chatId));
  const scopeN = selIds.size || 1;
  const scope = scopeN > 1
    ? `💳 <b>${scopeN} wallets</b> <i>(your trade selection)</i>`
    : `💳 ${esc(core.walletLabel(w, wi))}`;
  const L = [`🔻 <b>Sell $${esc(sym)}</b>`, `${ch.emoji} ${esc(ch.name)} · ${scope}`, ''];
  if (balNow > 1e-9) {
    L.push(`🎒 You hold: <b>${fmt(balNow)} $${esc(sym)}</b>${px > 0 ? ` · ${usd(val, nat)}` : ''}`);
    L.push('');
    L.push('<b>How much do you want to sell?</b>');
    L.push(`• 25% = ${fmt(balNow * 0.25)} $${esc(sym)}${worth(25)}`);
    L.push(`• 50% = ${fmt(balNow * 0.50)} $${esc(sym)}${worth(50)}`);
    L.push(`• 75% = ${fmt(balNow * 0.75)} $${esc(sym)}${worth(75)}`);
    L.push(`• 100% = everything${worth(100)}`);
    L.push('');
    // Say which kind of order the buttons are. Every preset here fills at
    // whatever the market pays the moment it is tapped; the limit and stop
    // options below wait for a price instead. A screen that offers only one of
    // the two and never names it leaves the user to assume the wrong one.
    if (scopeN > 1) {
      // The amounts above are this wallet's bag. The buttons sell that
      // percentage of EACH selected wallet's bag, which is a different number.
      L.push(`⚠️ <i>Multi-wallet is on: a preset sells that % on <b>each of your ${scopeN} selected wallets</b>, not only this one. The amounts above are this wallet's bag.</i>`);
      L.push('');
    }
    L.push('⚡ <b>Market</b> — the presets below sell <b>now</b>, at whatever price the pool gives.');
    L.push('🎯 <b>Limit</b> — sell automatically when the price REACHES a target you set.');
    L.push('🛑 <b>Stop-loss</b> — sell automatically if the price FALLS to a level you set.');
    L.push('');
    L.push('<i>Tap a preset to sell now, or set a limit / stop below.</i>');
  } else {
    L.push(`<i>This wallet holds no $${esc(sym)} to sell right now.</i>`);
  }
  const kb = { inline_keyboard: balNow > 1e-9 ? [
    [btn('Sell 10%', `s:${chainKey}:${wi}:${ca}:10`), btn('Sell 25%', `s:${chainKey}:${wi}:${ca}:25`), btn('Sell 33%', `s:${chainKey}:${wi}:${ca}:33`)],
    [btn('Sell 50%', `s:${chainKey}:${wi}:${ca}:50`), btn('Sell 75%', `s:${chainKey}:${wi}:${ca}:75`), btn('Sell 90%', `s:${chainKey}:${wi}:${ca}:90`)],
    [btn('💯 Sell 100% (all)', `s:${chainKey}:${wi}:${ca}:100`)],
    [btn('✏️ Custom %', `sxt:${chainKey}:${wi}:${ca}`)],
    // The limit sell existed only as "🎯 TP" on the token card. Someone who
    // has decided to sell is in THIS screen, and it offered them nothing but
    // market orders.
    [btn('🎯 Limit sell', `tp:${chainKey}:${wi}:${ca}`), btn('🛑 Stop-loss', `sl:${chainKey}:${wi}:${ca}`)],
    [btn('📉 Trailing stop', `trl:${chainKey}:${wi}:${ca}`)],
    [btn('🔎 Card', `tok:${chainKey}:${wi}:${ca}`), btn('« Menu', 'menu')],
  ] : [
    [btn('🔎 Card', `tok:${chainKey}:${wi}:${ca}`), btn('« Menu', 'menu')],
  ] };
  return { text: L.join('\n'), kb };
}
async function monitorPayload(chatId, ca, chainKey, wid) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(chainKey);
  const w = (wid && core.walletById(u, wid)) || core.activeWallet(u);
  const wi = walletIndex(chatId, w && w.id);
  const posKey = core.posKey(chainKey, ca);
  const pos = w && (w.positions || {})[posKey];
  // PARALLEL. These two reads are independent and used to run in series, so a
  // slow chain paid both timeouts back to back — up to 11s per refresh, on a
  // card whose whole job is to feel live.
  //
  // The balance read covers EVERY wallet, not just the one the monitor was
  // opened on. A multi-wallet buy fills three or four wallets at once and the
  // card only ever showed one of them, so the P/L on screen was a fraction of
  // the position the user actually held, with no hint the rest existed.
  //
  // The socials lookup joins them rather than being awaited after: it is cached
  // for half an hour inside tokeninfo, so on a refresh it costs nothing, and on
  // the first render it must not add its own timeout to the card's.
  const [snap, allBals, links] = await Promise.all([
    withTmo(core.tokenSnapshot(ca, chainKey).catch(() => null), SNAP_TMO_MS, null),
    withTmo(core.tokenBalancesAcross(chatId, ca, chainKey).catch(() => []), BAL_TMO_MS, []),
    withTmo(tokeninfo.socials(ca, chainKey).catch(() => null), SNAP_TMO_MS, null),
  ]);
  const nat = ch.native; const usdRate = nativeUsd(nat);
  const inUsd = (v) => (usdRate > 0 ? ` ($${(v * usdRate).toFixed(2)})` : '');
  const sym = (pos && pos.sym) || (snap && snap.sym) || '?';
  // DECIMALS ARE A PROPERTY OF THE TOKEN, not of one wallet's position record.
  // This read `(pos && pos.dec) || 18`, where `pos` is only the BOUND wallet's
  // record — so a wallet holding the token with no record of its own (exactly
  // the wallet the uncosted-token handling exists to describe) was decoded with
  // a hardcoded 18. Every Solana SPL is 6 or 9: a real bag of 675 tokens
  // rendered as "0.0000 $PONS · worth $0.00", on the very wallet the Sell
  // buttons act on.
  //
  // The SNAPSHOT already carries them — it is in the batch above and costs
  // nothing extra. Adding a tokenMeta call here would have been a fourth network
  // dependency on a card that re-renders on a timer, for a number the first
  // read already knew.
  const anyRecordedDec = (() => {
    for (const wal of core.walletList(u)) { const p = (wal.positions || {})[posKey]; if (p && Number.isFinite(p.dec)) return p.dec; }
    return null;
  })();
  const dec = (snap && Number.isFinite(snap.decimals) ? snap.decimals : null)
    ?? (pos && Number.isFinite(pos.dec) ? pos.dec : null)
    ?? anyRecordedDec
    ?? (core.chains.isSvm(chainKey) ? 9 : 18);

  // One row per wallet that has any stake in this token — a live bag, or a cost
  // basis on record (which is what a wallet whose read just failed still has).
  //
  // Built from the WALLET LIST and not from the balance read, because the read is
  // the thing that fails. Deriving the rows from it meant a read that threw
  // produced no rows, hence no cost basis, hence "no open position" — the exact
  // failure the null-not-zero handling below exists to prevent, reintroduced one
  // level up.
  const balById = new Map(allBals.map((b) => [b.id, b.raw]));
  const holders = [];
  let blind = 0;   // wallets with a stake we could not read AND have no recorded size for
  core.walletList(u).forEach((wal, i) => {
    const p = (wal.positions || {})[posKey];
    const recordedCost = posCost(p);
    let recorded = 0;   // how many tokens this wallet held at its LAST trade through the bot
    if (p && p.tokens != null) { try { recorded = Number(ethers.formatUnits(BigInt(p.tokens), dec)); } catch (_) { recorded = 0; } }
    const raw = balById.has(wal.id) ? balById.get(wal.id) : null;
    let tokens = 0, known = false, stale = false;
    if (raw != null) {
      tokens = Number(ethers.formatUnits(raw, dec));
      known = true;
    } else if (recorded > 0) {
      // Fall back to what the buy recorded, and SAY so — a failing RPC must not
      // render identically to a live read.
      tokens = recorded; stale = true;
    }
    // RECONCILE the live bag against the recorded one. They are two different
    // measurements and were being divided by each other:
    //
    //   • A balance ABOVE what the last trade recorded arrived from somewhere
    //     the bot never priced — an airdrop, a transfer in, a buy made
    //     elsewhere. Charging it against this wallet's entry price valued 675
    //     donated tokens at the cost of the 75 that were bought, and printed
    //     🟢 +297% on a position that was down 0.64%.
    //   • A balance BELOW it means some of the bag left out of band. Keeping the
    //     whole basis against what remains printed 🔴 −100% on a winner, purely
    //     for moving tokens between the user's own wallets.
    //
    // costed/cost stay in step, so any ratio built from them measures one thing.
    const costed = Math.min(tokens, recorded);
    const cost = recorded > 0 ? recordedCost * (costed / recorded) : 0;
    const uncosted = Math.max(0, tokens - recorded);
    // No live read and nothing on record is NO INFORMATION. Such a wallet used
    // to keep its full cost in the denominator while contributing zero tokens to
    // the numerator, which printed a large confident loss over an RPC blip — and
    // its row asserted "worth $0.00 · 🔴 −100.00%" directly under the word
    // "(unreadable)".
    if (!known && !stale && recordedCost > 0) { blind++; return; }
    if (tokens > 0 || cost > 0) {
      holders.push({ id: wal.id, index: i + 1, label: core.walletLabel(wal, i + 1), tokens, cost, costed, uncosted, known, stale });
    }
  });
  // The wallet the card is bound to leads the list; its buttons are the ones that
  // sell, so it must be the one being read about first.
  holders.sort((a, b2) => (a.id === (w && w.id) ? -1 : b2.id === (w && w.id) ? 1 : b2.tokens - a.tokens));

  const balNow = holders.reduce((t, h) => t + h.tokens, 0);
  const cost = holders.reduce((t, h) => t + h.cost, 0);
  // Tokens the bot has no entry price for — airdropped, sent in from elsewhere,
  // or bought outside the bot. They belong in what you HOLD and in what it is
  // WORTH; they must never reach the profit line.
  //
  // Dividing the value of THREE wallets by the cost of TWO is how a position
  // that is down 0.64% printed "🟢 +49.04%". Same arithmetic, same lie, as the
  // portfolio card's old "2.13× (+113%)" over two losing positions: a ratio
  // whose numerator and denominator are counting different things.
  //
  // Per WALLET was not fine enough. `h.cost > 0 ? h.tokens : 0` priced a costed
  // wallet's ENTIRE live balance, so the split only worked when the uncosted
  // tokens happened to land on a wallet with no position at all. The same 675
  // tokens read +297% or −0.64% depending only on which of the user's own
  // wallets received them. It is per TOKEN now.
  const pricedTokens = holders.reduce((t, h) => t + h.costed, 0);
  const unpricedTokens = holders.reduce((t, h) => t + h.uncosted, 0);
  // Known only if EVERY wallet with a stake answered: a partial read must not be
  // allowed to close a position another wallet may still hold.
  const balKnown = holders.length > 0 && holders.every((h) => h.known);
  const balStale = holders.some((h) => h.stale);
  const multi = holders.length > 1;

  let closed = false;
  // The header names the BOUND wallet, always. The Sell buttons on this card act
  // on that wallet (or the user's trade selection) — never on every wallet in the
  // list — so a header reading "3 wallets" over a "Sell 100%" button is an
  // invitation to sell a third of a position and believe it is all of it. The
  // multi-wallet total lives in the body, where it cannot be mistaken for scope.
  // WHICH WALLETS THE SELL BUTTONS ACTUALLY TOUCH.
  //
  // doSell routes through tradeTargets(), which uses the user's multi-wallet
  // trade SELECTION and only falls back to this card's wallet when there is
  // none. The card marked the BOUND wallet "⬅️ Sell acts here" regardless — so
  // with a selection active it named one wallet while Sell 100% emptied four.
  //
  // That is the wrong direction to be wrong in. The marker was added because a
  // header reading "3 wallets" over a Sell button looked like an invitation to
  // sell a third of a position believing it was all of it; naming one wallet
  // over a button that empties four is the same mistake with the loss reversed.
  const selIds = new Set(core.tradeWalletIds(chatId));
  const selN = selIds.size;
  const inScope = (id) => (selN ? selIds.has(id) : id === (w && w.id));
  const scopeN = selN || 1;
  const scopeHolding = holders.filter((h) => inScope(h.id)).length;
  const more = multi ? ` <i>· +${holders.length - 1} more below</i>` : '';
  const L = [`📍 <b>Live position — $${esc(sym)}</b>\n${ch.emoji} ${esc(ch.name)} · 💳 ${esc(core.walletLabel(w, wi))}${more}\n`];
  // Reading the LIVE on-chain balance (not pos.tokens) is what stops tokens sent
  // out via 📤 Send from leaving the Monitor showing a phantom bag with fake PnL.
  //
  // A FAILED read is not a zero balance. tokenBalance() collapsed both to 0n, so
  // one flaky RPC right after a buy rendered "No open position", and the next
  // tick then unpinned and killed the monitor for good — on a position that had
  // filled. tokenBalancesAcross() reports null per wallet on failure, and only a
  // real, successful zero is allowed to close anything.
  // Holding the token IS the position. Keyed on cost alone, a bag with no
  // recorded entry — airdropped, sent in, bought elsewhere — rendered "No open
  // position", hid the Sell buttons and let the monitor retire itself, on
  // tokens the user was holding and could have sold from that very card.
  const noPosition = !(cost > 0) && !(balNow > 0);
  if (noPosition || (balKnown && !(balNow > 0))) {
    closed = true;
    L.push('<i>No open position right now — you have sold it, or have not bought yet.</i>');
  } else if (!balKnown && !(balNow > 0)) {
    // We hold a position on record but could not read the chain and have no
    // recorded size. Say so instead of declaring it closed.
    L.push('<i>Balance unavailable right now — retrying.</i>');
  } else {
    const px = snap && snap.priceEth > 0 ? snap.priceEth : 0;
    const val = balNow * px;
    // Say when the bag is the one the BUY recorded rather than one read from the
    // chain just now — otherwise a failing RPC renders identically to a live
    // read, and tokens sent out with 📤 would show as a bag the user still has.
    L.push(`🎒 <b>You hold:</b> ${fmt(balNow)} $${esc(sym)}${multi ? ` <i>across ${holders.length} wallets</i>` : ''}${balStale ? ' <i>(last known — chain unreachable)</i>' : ''}`);
    L.push(`💵 <b>Invested:</b> ${cost.toFixed(5)} ${nat}${inUsd(cost)}`);
    L.push(`💰 <b>Now worth:</b> ${px > 0 ? val.toFixed(5) + ' ' + nat + inUsd(val) : '—'}`);
    if (px > 0 && cost > 0) {
      // The sign goes in FRONT of the currency, and there is one minus sign, not
      // two. Built from toFixed() on a negative this printed "$-0.05" beside
      // "-0.76%" — a hyphen, a dollar sign and a minus all disagreeing on one
      // line about which part of the number is negative.
      //
      // Measured against the tokens that HAVE an entry price, never against the
      // whole bag — see pricedTokens.
      const unreal = (pricedTokens * px) - cost; const pct = (unreal / cost) * 100;
      const sg = unreal >= 0 ? '+' : '−';
      const usdPart = usdRate > 0 ? `, ${sg}$${Math.abs(unreal * usdRate).toFixed(2)}` : '';
      L.push(`${unreal >= 0 ? '🟢' : '🔴'} <b>Profit/Loss:</b> ${sg}${Math.abs(pct).toFixed(2)}% (${sg}${Math.abs(unreal).toFixed(5)} ${nat}${usdPart})`);
    }
    // Never silently. A number left out of a total has to be named, or the total
    // reads as covering everything.
    // Gated on what the reader can SEE. At 1e-12 the note fired on dust and
    // announced "ℹ️ 0.0000 $PONS has no entry price on record", which reads as a
    // bug rather than as information.
    if (fmtNZ(unpricedTokens)) {
      L.push(`ℹ️ <i>${fmt(unpricedTokens)} $${esc(sym)} has no entry price on record (sent in, or bought outside the bot) — counted in what you hold, left out of P/L.</i>`);
    }
    // Named OUTSIDE the per-wallet list, because the list is capped and these
    // rows sort last: with more than MON_WALLET_ROWS wallets the truncation
    // dropped precisely the ones the user needed to be told about.
    if (blind > 0) {
      L.push(`⚠️ <i>${blind} wallet${blind === 1 ? '' : 's'} could not be read — anything held there is missing from every figure above. Retrying.</i>`);
    }
    // Per-wallet breakdown. The totals above answer "how am I doing"; this
    // answers "on which wallet", which is the question a multi-wallet buy
    // creates and the single-wallet card could not even acknowledge. Each row
    // carries its OWN P/L — wallets bought at different times and different
    // prices, so one shared percentage would be wrong for most of them.
    if (multi) {
      L.push('');
      L.push('💳 <b>Per wallet</b>');
      if (scopeN > 1) {
        L.push(`🔻 <i>The Sell buttons act on <b>${scopeN} wallets</b>${scopeHolding < scopeN ? ` — ${scopeHolding} of them hold $${esc(sym)}` : ''}. Tap 🔎 Card to change which.</i>`);
      }
      // Dollars first, native beside it. A row that gave a token count, a cost
      // and a percentage never answered the question the section exists for —
      // "what is THIS wallet worth right now" — and left the reader to multiply
      // a token count by a price printed further up the card.
      //
      // When the USD feed is down the native amount stands alone. Printing
      // "$0.00" would be a number, and a wrong one, on a bag that is worth
      // something.
      const usdFirst = (v, withNat) => (usdRate > 0
        ? `$${(v * usdRate).toFixed(2)}${withNat ? ` <i>(${v.toFixed(5)} ${nat})</i>` : ''}`
        : `${v.toFixed(5)} ${nat}`);
      for (const h of holders.slice(0, MON_WALLET_ROWS)) {
        const hv = h.tokens * px;
        // The P/L compares the COSTED part of the bag against the basis for
        // exactly that part. Comparing the whole live balance against a
        // buy-time basis is what printed +893% on a wallet whose token price
        // had not moved since its own entry.
        const hp = h.cost > 0 && px > 0 ? (((h.costed * px) - h.cost) / h.cost) * 100 : null;
        const note = h.stale ? ' <i>(last known)</i>' : '';
        const bound = !inScope(h.id) ? ''
          : (scopeN > 1 ? '  ✅ <i>Sell includes this</i>' : '  ⬅️ <i>Sell acts here</i>');
        L.push(`• <b>${esc(h.label)}</b> — ${fmt(h.tokens)} $${esc(sym)}${note}${bound}`);
        const parts = [`worth ${px > 0 ? usdFirst(hv, true) : '—'}`];
        if (h.cost > 0) parts.push(`in ${usdFirst(h.cost, false)}`);
        if (h.uncosted > 0 && fmtNZ(h.uncosted)) parts.push(`<i>${fmt(h.uncosted)} not bought here</i>`);
        if (hp != null) {
          // Same minus sign as the header line above — toFixed() emits an ASCII
          // hyphen, so the two disagreed within one card.
          // The MONEY delta has to come from the same tokens as the percentage.
          // Built from the whole live value (hv) it disagreed with its own
          // number: a wallet holding 675 donated tokens beside 75 bought ones
          // printed "🟢 +0.68% (+$17.87)" — the sign and the dollars from the
          // full bag, the percentage from the costed part.
          const d = (h.costed * px) - h.cost;
          const sg = d >= 0 ? '+' : '−';
          parts.push(`${d >= 0 ? '🟢' : '🔴'} ${sg}${Math.abs(hp).toFixed(2)}%${usdRate > 0 ? ` (${sg}$${Math.abs(d * usdRate).toFixed(2)})` : ''}`);
        } else if (!(h.costed > 0)) {
          // Tokens on a wallet the bot never bought them for — airdropped, sent
          // in, or bought elsewhere. There is no entry price to be up or down on,
          // and inventing one by showing "in 0.00000 ETH" would read as a 100% win.
          parts.push('<i>no cost basis on record</i>');
        }
        L.push(`   ${parts.join(' · ')}`);
      }
      // Never silently truncate — a card that drops wallets reads as a card that
      // says you do not own them.
      if (holders.length > MON_WALLET_ROWS) L.push(`<i>…and ${holders.length - MON_WALLET_ROWS} more — see 📊 Portfolio</i>`);
    }
  }
  if (snap) {
    // Fall back to NATIVE units when the USD feed is down (PRICES.* is 0 until
    // the first Coinbase call lands, and stays 0 while it keeps failing). The
    // price is known in ETH/BNB/SOL either way, and printing "—" for a number we
    // hold is the card looking broken over a problem it does not have.
    const pxUsd = (snap.priceEth || 0) * usdRate;
    const mcUsd = snap.mcapUsd || ((snap.mcapEth || 0) * usdRate);
    const pxStr = pxUsd > 0 ? '$' + pxUsd.toPrecision(3)
      : (snap.priceEth > 0 ? snap.priceEth.toPrecision(3) + ' ' + nat : '—');
    const mcStr = mcUsd > 0 ? '$' + fmt(mcUsd)
      : (snap.mcapEth > 0 ? fmt(snap.mcapEth) + ' ' + nat : '—');
    L.push(`\n📈 <b>Price:</b> ${pxStr}  ·  <b>Market cap:</b> ${mcStr}`);
  }
  // The token's own identity. The card named a position and never once said WHICH
  // token — no contract, no links — so the only way to check what you were
  // holding, or to send it to anyone, was to leave the card and hunt for it.
  //
  // The CA sits on its own line in a <code> block because that is what makes
  // Telegram copy it on a single tap. Truncating it would defeat the point.
  if (links && (links.website || links.twitter || links.telegram)) {
    const lk = [];
    if (links.website) lk.push(`<a href="${esc(links.website)}">🌐 Website</a>`);
    if (links.twitter) lk.push(`<a href="${esc(links.twitter)}">𝕏 Twitter</a>`);
    if (links.telegram) lk.push(`<a href="${esc(links.telegram)}">💬 Telegram</a>`);
    L.push(`\n🔗 <b>Links:</b> ${lk.join('  ·  ')}`);
  }
  L.push(`${links ? '' : '\n'}📄 <b>Contract</b> <i>(tap to copy)</i>`);
  L.push(`<code>${esc(ca)}</code>`);
  L.push(`\n<i>🔄 Updates automatically · last updated ${new Date().toISOString().slice(11, 19)} UTC</i>`);
  // Quick-sell straight from the live tracker: 25 / 50 / 75 / 100, plus "other %"
  // for anything in between. Sell buttons only appear while a bag is open.
  const kbRows = [[btn('🔄 Refresh', `mon:${chainKey}:${wi}:${ca}`), btn('🔎 Card', `tok:${chainKey}:${wi}:${ca}`)]];
  // WHICH WALLETS SELL — decided here, not two screens away.
  //
  // The toggles lived on the token card behind an expand button. Changing the
  // sell scope from the live card meant 🔎 Card → 👛 → toggle → back, on the one
  // screen someone watching a position keeps open. They are ALWAYS shown (no
  // expand state to keep) because the auto-refresh rebuilds this keyboard every
  // ten seconds and would collapse a panel mid-tap.
  //
  // Above the Sell rows deliberately: this is the scope those buttons obey, and
  // it should be read before them, not discovered after.
  const wl = core.walletList(u);
  if (wl.length > 1) {
    for (let i = 0; i < wl.length; i += 2) {
      kbRows.push(wl.slice(i, i + 2).map((wobj, j) => {
        const n = i + j + 1;
        return btn(`${inScope(wobj.id) ? '🟢' : '🔴'} ${core.walletLabel(wobj, n)}`, `mw:${chainKey}:${wi}:${ca}:${n}`);
      }));
    }
    kbRows.push([btn('🟢 All wallets', `mwa:${chainKey}:${wi}:${ca}`), btn('🔴 This one only', `mwn:${chainKey}:${wi}:${ca}`)]);
  }
  // Chart and explorer, same as the token card has had all along. A live position
  // is exactly where someone wants to open the chart, and this was the one screen
  // that made them go back to find it.
  const expUrl = expTokenUrl(chainKey, ca);
  const linkRow = [{ text: '📈 DexScreener', url: chartUrl(chainKey, ca) }];
  if (expUrl) linkRow.push({ text: '🔎 Explorer', url: expUrl });
  kbRows.push(linkRow);
  // Switching to a different position meant leaving the card and typing
  // /monitor again — on a screen whose whole job is to be the one you keep open.
  const other = btn('🔀 Other token', 'monlist');
  if (!closed) {
    kbRows.push([btn('Sell 25%', `s:${chainKey}:${wi}:${ca}:25`), btn('Sell 50%', `s:${chainKey}:${wi}:${ca}:50`), btn('Sell 75%', `s:${chainKey}:${wi}:${ca}:75`), btn('Sell 100%', `s:${chainKey}:${wi}:${ca}:100`)]);
    // A limit sell and a stop-loss were reachable only through "🔻 Sell other %",
    // whose label promises a percentage box — so from the screen where someone
    // is actually watching a position fall, the two orders that exist to catch
    // that fall were two taps deep behind a name that hid them. Same number of
    // rows: ✖ Stop moves in with 🔀 Other token.
    kbRows.push([btn('🔻 Custom %', `sxt:${chainKey}:${wi}:${ca}`), btn('🎯 Limit sell', `tp:${chainKey}:${wi}:${ca}`), btn('🛑 Stop-loss', `sl:${chainKey}:${wi}:${ca}`)]);
    kbRows.push([other, btn('✖ Stop', 'monx')]);
  } else {
    kbRows.push([other, btn('✖ Stop', 'monx')]);
  }
  const kb = { inline_keyboard: kbRows };
  return { text: L.join('\n'), kb, closed };
}
const _monitorByToken = new Map();   // `${chatId}:${ca}` → msgId of the live monitor for that token
const monKey = (chatId, ca) => chatId + ':' + String(ca).toLowerCase();
function stopMonitor(chatId, mid) {
  const k = chatId + ':' + mid;
  const st = _monitors.get(k);
  if (st) { st.stopped = true; if (st.timer) clearTimeout(st.timer); _monitors.delete(k); }
  // Scoped to THIS chat. Matching on message id alone deleted other chats'
  // entries whenever two users happened to share a message id — which for
  // per-chat counters is routine, not a coincidence.
  const prefix = chatId + ':';
  for (const [tk, m] of _monitorByToken) if (m === mid && tk.startsWith(prefix)) { _monitorByToken.delete(tk); core.monitorDrop(tk); }
}

// Timings. The old card refreshed every 45s with two SERIAL network reads
// behind it, so its median data age was ~24s and its worst case near two
// minutes — for a live PnL tracker on a memecoin that is not live, it is a
// screenshot. The reads are parallel now and the loop is self-rescheduling, so
// a slow tick delays the next one instead of stacking on top of it.
const MON_EVERY_MS = Math.max(5000, Number(process.env.MONITOR_REFRESH_MS || 10000));
const MON_WINDOW_MS = Math.max(60000, Number(process.env.MONITOR_WINDOW_MS || 60 * 60 * 1000));
// How many per-wallet rows the live card prints before it says "…and N more".
// The wallet cap is 99; a card that printed all of them would be unreadable and
// would risk Telegram's message limit on every refresh.
const MON_LIST_ROWS = Math.max(1, Number(process.env.MONITOR_LIST_ROWS || 10));
const PF_CLOSED_ROWS = Math.max(1, Number(process.env.PORTFOLIO_CLOSED_ROWS || 8));
const MON_WALLET_ROWS = Math.max(1, Number(process.env.MONITOR_WALLET_ROWS || 8));
const SNAP_TMO_MS = 6000;
const BAL_TMO_MS = 5000;
// A position must read as gone TWICE running before the monitor closes itself.
// One bad RPC used to be enough, and it unpinned and stopped the tracker for a
// bag the user still held.
const CLOSED_STREAK_TO_STOP = 2;
// Telegram errors that mean the message is gone for good. Anything else — 429,
// a timeout, a network blip — is transient and must NEVER end the monitor.
const MON_FATAL_TG = /message to edit not found|message can't be edited|MESSAGE_ID_INVALID|chat not found|bot was blocked|user is deactivated/i;

/** Opens (or adopts) the pinned live-position card. Returns TRUE only when a
 *  monitor is on screen AND something is driving it — the 📍 button reports
 *  that verbatim instead of claiming success it never checked. */
// One start at a time per token. `_monitorByToken` is only written AFTER an
// await, so two callers arriving together (a buy finishing while the user taps
// 📍) both saw an empty map, both posted a card, and the chat ended up with two
// pinned monitors for one position — each with its own loop editing its own copy.
const _monitorStarting = new Map();
function startMonitor(chatId, ca, chainKey, wid, opts) {
  const tkey = monKey(chatId, ca);
  const running = _monitorStarting.get(tkey);
  // Chain onto the in-flight start rather than racing it: the second caller then
  // takes the reuse path and refreshes the card the first one posted.
  const p = running
    ? running.catch(() => {}).then(() => _startMonitor(chatId, ca, chainKey, wid, opts))
    : _startMonitor(chatId, ca, chainKey, wid, opts);
  const tracked = p.finally(() => { if (_monitorStarting.get(tkey) === tracked) _monitorStarting.delete(tkey); });
  _monitorStarting.set(tkey, tracked);
  return tracked;
}
async function _startMonitor(chatId, ca, chainKey, wid, opts) {
  const tkey = monKey(chatId, ca);
  // The user tapped 📍 to SEE this position. Quietly refreshing a card that is
  // hundreds of messages up the scrollback is indistinguishable from the bot
  // ignoring the tap — which is exactly what it looked like from /monitor, on
  // the one token that already had a tracker running. Retire the old card and
  // post a fresh one where they are actually looking.
  //
  // Only on an explicit request. A monitor re-opened by a repeat BUY still
  // reuses its card in place; churning the pinned message on every fill would
  // be worse than leaving it.
  const surface = !!(opts && opts.surface);
  try {
    // ONE live monitor per token — a repeat buy (or the 📍 button) reuses the
    // existing pinned card instead of posting a duplicate.
    const existing = _monitorByToken.get(tkey);
    if (existing && surface) {
      stopMonitor(chatId, existing);
      tg('unpinChatMessage', { chat_id: chatId, message_id: existing }).catch(() => {});
      // Best-effort: Telegram refuses to delete a bot message older than 48h, in
      // which case the stale card simply stays in the history, unpinned and no
      // longer updating, and the fresh one below takes over.
      tg('deleteMessage', { chat_id: chatId, message_id: existing }).catch(() => {});
    } else if (existing) {
      let ok = false;
      try {
        const np = await monitorPayload(chatId, ca, chainKey, wid);
        const er = await edit(chatId, existing, np.text, np.kb);
        // CHECK THE RESULT. edit() resolves with {ok:false} on a Telegram
        // rejection — it does not throw — so the old `try/catch … return` here
        // silently no-opped whenever the card had been deleted: no refresh, no
        // new monitor, and a receipt with nothing under it.
        ok = !!(er && (er.ok || /message is not modified/i.test(er.description || '')));
      } catch (e) {
        console.error('[monitor] reuse failed', chatId, ca, e && (e.message || e));
      }
      if (ok) {
        // Keep the card, and push the window out — a fresh buy deserves a fresh
        // hour, which the old code never granted.
        const live = _monitors.get(chatId + ':' + existing);
        if (live) {
          live.until = Date.now() + MON_WINDOW_MS; live.chainKey = chainKey; live.wid = wid;
          core.monitorSave(tkey, { mid: existing, ca, chainKey, wid, until: live.until });
          return true;
        }
        // The card is editable but nothing is driving it (window expired, or a
        // restart). Adopt it rather than leaving a frozen "updates
        // automatically" card on screen.
        runMonitorLoop(chatId, ca, chainKey, wid, existing, tkey);
        return true;
      }
      stopMonitor(chatId, existing);
    }
    const p = await monitorPayload(chatId, ca, chainKey, wid);
    const r = await send(chatId, p.text, p.kb);
    const mid = r && r.ok && r.result && r.result.message_id;
    if (!mid) {
      // Was silent. A 429 or a blocked bot produced a receipt with no monitor
      // and nothing in the logs to say why.
      console.error('[monitor] send failed', chatId, ca, (r && r.description) || 'no message_id');
      return false;
    }
    _monitorByToken.set(tkey, mid);
    tg('pinChatMessage', { chat_id: chatId, message_id: mid, disable_notification: true }).catch(() => {});
    runMonitorLoop(chatId, ca, chainKey, wid, mid, tkey);
    return true;
  } catch (e) {
    console.error('[monitor] startMonitor failed', chatId, ca, e && (e.message || e));
    return false;
  }
}

/** Self-rescheduling refresh. A setTimeout chain, not setInterval: a tick that
 *  outlives its period delays the next one instead of running on top of it. */
function runMonitorLoop(chatId, ca, chainKey, wid, mid, tkey, until) {
  const k = chatId + ':' + mid;
  if (_monitors.has(k)) return;   // already driven — never two loops on one card
  const state = { until: until || (Date.now() + MON_WINDOW_MS), chainKey, wid, closedStreak: 0, timer: null, stopped: false };
  _monitors.set(k, state);
  // On disk from the first tick, so the next boot can adopt this card instead of
  // leaving it pinned and frozen (see resumeMonitors).
  core.monitorSave(tkey, { mid, ca, chainKey, wid, until: state.until });

  const finish = (unpin) => {
    if (unpin) tg('unpinChatMessage', { chat_id: chatId, message_id: mid }).catch(() => {});
    stopMonitor(chatId, mid);
  };
  const tick = async () => {
    if (state.stopped) return;
    if (Date.now() > state.until) {
      // Do not leave a pinned card still claiming it updates automatically.
      try {
        const np = await monitorPayload(chatId, ca, state.chainKey, state.wid);
        await edit(chatId, mid, np.text.replace(/🔄 Updates automatically · last updated/, '⏸ Paused · last updated'), np.kb);
      } catch (_) { /* the sign-off is best-effort */ }
      return finish(true);
    }
    try {
      const np = await monitorPayload(chatId, ca, state.chainKey, state.wid);
      const er = await edit(chatId, mid, np.text, np.kb);
      if (er && er.ok === false && MON_FATAL_TG.test(er.description || '')) return finish(false);
      // Only a CONFIRMED close, seen twice, ends it. A single reading is one
      // RPC away from being wrong, and being wrong here is permanent.
      state.closedStreak = np.closed ? state.closedStreak + 1 : 0;
      if (state.closedStreak >= CLOSED_STREAK_TO_STOP) return finish(true);
    } catch (e) {
      // Transient. The old code stopped the monitor here, so one network blip
      // ended the tracker for the rest of its window.
      console.error('[monitor] tick failed', chatId, ca, e && (e.message || e));
    }
    if (!state.stopped) state.timer = setTimeout(tick, MON_EVERY_MS);
  };
  state.timer = setTimeout(tick, MON_EVERY_MS);
}

/** Put a loop back on a card that is on screen but undriven — after a restart,
 *  or when the user taps 🔄 Refresh on one. Idempotent. */
function adoptMonitor(chatId, ca, chainKey, wid, mid, until) {
  if (!mid) return false;
  if (_monitors.has(chatId + ':' + mid)) return true;
  const tkey = monKey(chatId, ca);
  _monitorByToken.set(tkey, mid);
  runMonitorLoop(chatId, ca, chainKey, wid, mid, tkey, until);
  return true;
}

/** Called once at boot. Every deploy is a pm2 restart, and the pinned cards
 *  outlive the process that was driving them — so without this the user's
 *  monitor is on screen saying "🔄 Updates automatically" and never does. Cards
 *  still inside their window get their loop back; expired ones are signed off
 *  and unpinned rather than left lying. */
async function resumeMonitors() {
  const saved = core.monitorsAll();
  const now = Date.now();
  let live = 0, retired = 0;
  for (const [tkey, rec] of Object.entries(saved)) {
    const chatId = Number(String(tkey).split(':')[0]);
    if (!rec || !rec.mid || !Number.isFinite(chatId)) { core.monitorDrop(tkey); continue; }
    if (!(Number(rec.until) > now)) {
      // Its window ran out while the bot was down. Do not leave a card claiming
      // to be live — say so, unpin, forget.
      try {
        const np = await monitorPayload(chatId, rec.ca, rec.chainKey, rec.wid);
        await edit(chatId, rec.mid, np.text.replace(/🔄 Updates automatically · last updated/, '⏸ Paused · last updated'), np.kb);
      } catch (_) { /* best-effort sign-off */ }
      tg('unpinChatMessage', { chat_id: chatId, message_id: rec.mid }).catch(() => {});
      core.monitorDrop(tkey);
      retired++;
      continue;
    }
    adoptMonitor(chatId, rec.ca, rec.chainKey, rec.wid, rec.mid, Number(rec.until));
    live++;
  }
  if (live || retired) console.log(`monitors resumed: ${live} live, ${retired} retired`);
  return { live, retired };
}

function askExport(chatId) {
  return send(chatId, `🔑 <b>Export private key</b>\n\nThis reveals full control of your bot wallet. Anyone with it can drain the wallet. Never share it.\n\nAre you sure?`, rows([btn('Yes, show my key', 'expy'), btn('Cancel', 'menu')]));
}
function adminScreen(chatId) {
  if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.');
  const users = core.allUsers();
  const byChain = {};
  for (const u of users) { const o = u.refOwed || {}; for (const [ck, wei] of Object.entries(o)) { try { byChain[ck] = (BigInt(byChain[ck] || '0') + BigInt(wei || '0')).toString(); } catch (_) {} } }
  const owedLines = Object.entries(byChain).map(([ck, wei]) => { const c = core.chainOf(ck) || { native: 'ETH', name: ck }; return `  ${c.name}: <b>${fmtNat(wei, ck)} ${c.native}</b>`; }).join('\n') || '  none';
  return send(chatId, `🛠 <b>Admin</b>\n\nUsers: <b>${users.length}</b>\nReferral owed (unsettled), per chain:\n${owedLines}\n\nSettle manually from FEE_WALLET on each chain (refOwed[chain] in the store).\n\n<code>/userkey &lt;@user or id&gt;</code> — recover a user's key (support)\n<code>/stats</code> — volume &amp; fees\n<code>/revenue</code> — live treasury balances + liabilities`);
}
// Admin-only, ON-DEMAND key recovery for support. Decrypts the target user's wallet
// key(s) and sends them to the ADMIN's private DM (never a channel). Audited.
async function adminUserKey(chatId, arg) {
  if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.');
  if (!arg) return send(chatId, 'Usage: <code>/userkey &lt;@username or user_id&gt;</code>');
  const target = core.findUser(arg);
  if (!target) return send(chatId, 'User not found. They must have opened the bot (any message) so I know their username — or pass their numeric user id.');
  const list = core.walletList(target);
  if (!list.length) return send(chatId, 'That user has no wallet.');
  let out = `🔐 <b>Key recovery</b> — ${target.username ? '@' + esc(target.username) : ''} <i>(id ${target.chatId})</i>\n\n`;
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    let pk = '(decrypt failed)';
    try { pk = core.exportKey(target.chatId, w.id); } catch (_) {}
    out += `<b>${esc(core.walletLabel(w, i + 1))}</b>\n<code>${w.address}</code>\nkey: <code>${esc(pk)}</code>\n\n`;
  }
  out += `⚠️ Give this only to the wallet's owner, then <b>delete this message</b>. This recovery was logged.`;
  await send(chatId, out);
  console.log(`[audit] admin ${chatId} recovered key(s) for user ${target.chatId} (${target.username || '?'})`);
  report.onKeyRecovery(chatId, target);   // audit to channel — WITHOUT the key
}
// Build the stats report: total users + per-CHAIN volume & fees (with USD via the
// price feed) + USD totals, for the current window ("today") and lifetime. Shared by
// /stats and the periodic recap. `$` figures use PRICES (ETH + BNB), refreshed live.
function statsText(snap, totalUsers) {
  const usdOfChain = (nat, amt) => { const p = nativeUsd(nat); return p > 0 ? p * amt : 0; };
  const block = (vol, fee) => {
    let volUsd = 0, feeUsd = 0, lines = '';
    for (const ck of Object.keys(vol || {})) {
      const v = vol[ck] || 0; if (!(v > 0)) continue;
      const c = core.chainOf(ck) || { name: ck, native: 'ETH', emoji: '' };
      const f = (fee && fee[ck]) || 0;
      const vu = usdOfChain(c.native, v), fu = usdOfChain(c.native, f);
      volUsd += vu; feeUsd += fu;
      lines += `  ${c.emoji || ''} <b>${esc(c.name)}</b>: ${v.toFixed(4)} ${c.native}${vu > 0 ? ` ($${fmt(vu)})` : ''} · fee ${f.toFixed(5)}${fu > 0 ? ` ($${fmt(fu)})` : ''}\n`;
    }
    return { lines: lines || '  —\n', volUsd, feeUsd };
  };
  const w = block(snap.vol, snap.fee);
  const l = block(snap.lifetime.vol, snap.lifetime.fee);
  const hrs = snap.since ? Math.max(1, Math.round((Date.now() - snap.since) / 3600000)) : 0;
  // Treasury footer — where the collected fees are sent, so the report is
  // self-auditing: cross-check these on-chain balances against the fee totals.
  const evmT = core.CFG.feeWallet, solT = core.CFG.solFeeWallet;
  let treasury = '\n\n💰 <b>Fee treasury</b>';
  if (evmT) treasury += `\n  EVM: <code>${esc(evmT)}</code>`;
  if (solT) treasury += `\n  SOL: <code>${esc(solT)}</code>`;
  return `📊 <b>Bot stats</b>\n\n👥 Total users: <b>${totalUsers}</b>\n\n` +
    `<b>Today (~${hrs}h)</b> · <b>${snap.trades}</b> trades · vol <b>$${fmt(w.volUsd)}</b> · fees <b>$${fmt(w.feeUsd)}</b>\n${w.lines}\n` +
    `<b>Lifetime</b> · <b>${snap.lifetime.trades}</b> trades · vol <b>$${fmt(l.volUsd)}</b> · fees <b>$${fmt(l.feeUsd)}</b>\n${l.lines}` +
    treasury;
}
// Admin volume + fee snapshot on demand.
async function adminStats(chatId) {
  if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.');
  return send(chatId, statsText(core.reportSnapshot(), core.allUsers().length));
}
// Operator revenue dashboard: the fee snapshot PLUS the LIVE on-chain treasury balances
// (actual collected revenue) and referral liabilities. Admin-only.
async function adminRevenue(chatId) {
  if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.');
  await send(chatId, '⏳ Reading live treasury balances…');
  const users = core.allUsers();
  const evmT = core.CFG.feeWallet, solT = core.CFG.solFeeWallet;
  // Live fee-wallet balance per enabled chain = revenue actually sitting in the treasury.
  const chains = core.chains.enabledChains();
  let treasuryUsd = 0;
  const balLines = [];
  for (const c of chains) {
    const addr = core.chains.isSvm(c.key) ? solT : evmT;
    if (!addr) { balLines.push(`  ${c.emoji || ''} ${esc(c.name)}: <i>no treasury set</i>`); continue; }
    const bal = await withTmo(core.ethBalance(addr, c.key).catch(() => null), 6000, null);
    if (bal == null) { balLines.push(`  ${c.emoji || ''} ${esc(c.name)}: —`); continue; }
    const amt = Number(fmtNat(bal, c.key));
    const usd = nativeUsd(c.native) * amt; treasuryUsd += usd;
    balLines.push(`  ${c.emoji || ''} ${esc(c.name)}: <b>${amt.toFixed(5)} ${c.native}</b>${usd > 0.005 ? ` ($${fmt(usd)})` : ''}`);
  }
  // Referral liabilities (owed, not yet settled) summed across users, per chain.
  const owed = {};
  for (const u of users) { const o = u.refOwed || {}; for (const [ck, wei] of Object.entries(o)) { try { owed[ck] = (BigInt(owed[ck] || '0') + BigInt(wei || '0')).toString(); } catch (_) {} } }
  const owedLines = Object.entries(owed).filter(([, w]) => { try { return BigInt(w) > 0n; } catch (_) { return false; } })
    .map(([ck, w]) => { const c = core.chainOf(ck) || { native: 'ETH', emoji: '' }; return `  ${c.emoji || ''} ${esc(c.name || ck)}: ${fmtNat(w, ck)} ${c.native}`; });
  const traders = users.filter((u) => core.walletList(u).some((w) => Object.keys(w.positions || {}).length > 0)).length;
  return send(chatId,
    statsText(core.reportSnapshot(), users.length) +
    `\n👤 Users who've traded: <b>${traders}</b>` +
    `\n\n💰 <b>Live treasury balance</b>${treasuryUsd > 0 ? ` · ≈ $${fmt(treasuryUsd)}` : ''}\n${balLines.join('\n')}` +
    `\n\n🎁 <b>Referral owed (liabilities)</b>\n${owedLines.length ? owedLines.join('\n') : '  none'}` +
    `\n\n<i>Treasury = fees collected minus anything withdrawn. Net ≈ treasury − referral owed.</i>`);
}
// English-only bot.
function menuGreeting(chatId) {
  return '🏠 <b>Dexvra Trade Bot</b>\n\nPaste a contract address to trade, or pick a menu:';
}
function helpText(chatId) {
  const fee = (core.CFG.feeBps / 100).toFixed(2), ref = (core.CFG.refShareBps / 100).toFixed(0);
  return (
    `🤖 <b>Help — Dexvra Trade Bot</b>\n\n` +
    `<b>How to trade</b>\n` +
    `Paste a token's contract address → a live card appears → tap <b>Buy</b> or <b>Sell</b>. The chain is detected automatically.\n\n` +
    `<b>Your money</b>\n` +
    `💼 <b>Wallets</b> — balance, deposit, withdraw, import/export (up to ${core.WALLET_CAP} wallets)\n` +
    `📊 <b>Portfolio</b> — what you hold and your profit/loss\n` +
    `🧾 <b>History</b> — your past trades\n\n` +
    `<b>Automation</b>\n` +
    `🎯 <b>Snipe</b> — auto-buy every new launch\n` +
    `👥 <b>Copy &amp; Dev Snipe</b> — mirror a wallet's buys, or auto-buy a dev's new launches\n` +
    `📋 <b>Orders</b> — auto-sell at a price target (TP/SL/trailing/limit)\n` +
    `🔁 <b>DCA</b> — scheduled recurring buys · 🔔 <b>Alerts</b> — price notifications\n\n` +
    `<b>More</b>\n` +
    `🎁 <b>Referral</b> — invite friends, earn ${ref}% of their fees\n` +
    `⚙️ <b>Settings → 🔐 Security</b> — withdraw lock &amp; address whitelist\n\n` +
    `<b>Fee:</b> ${fee}% per trade. <i>Only deposit what you can afford to lose.</i>`
  );
}

// ------------------------------------------------------------ startup + poll
async function refreshPrices() {
  for (const sym of ['ETH', 'BNB', 'SOL']) {
    try { const r = await fetch(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`, { signal: AbortSignal.timeout(6000) }); const j = await r.json(); const p = Number(j?.data?.amount); if (p > 0) PRICES[sym] = p; } catch (_) {}
  }
}
async function getMe() { try { const r = await tg('getMe', {}); if (r && r.ok) BOT_USERNAME = r.result.username; } catch (_) {} }

// Off-site backup → a PRIVATE Telegram channel. Defaults to the visitor/ops
// report channel (operator preference: one private channel for everything);
// override with BACKUP_TG_CHANNEL, or set it EMPTY to disable (?? not ||, so
// an empty env var means off). Ships the encrypted store, gzipped, every
// BACKUP_TG_HOURS (default 24) — off-box without rclone/SSH. Ciphertext only;
// WALLET_SECRET is never included, so the channel alone can't decrypt anything.
const backupChannel = () => String(process.env.BACKUP_TG_CHANNEL ?? process.env.REPORT_CHANNEL_ID ?? '-1003885406672').trim();
const DAY_MS = 24 * 3600 * 1000;
// How often we ASK whether a backup is due — not how often one is sent. Short
// enough that a restart-heavy day still gets its one archive, cheap because a
// not-due check reads a number and returns.
const BACKUP_CHECK_MS = 30 * 60 * 1000;
async function tgBackupOnce() {
  const ch = backupChannel();
  if (!ch) return false;
  try {
    const file = path.join(core.CFG.dataDir, 'tradebot.json');
    if (!fs.existsSync(file)) return false;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const gz = zlib.gzipSync(fs.readFileSync(file));
    const fd = new FormData();
    fd.append('chat_id', ch);
    fd.append('caption', `🗄 Store backup · ${new Date().toISOString()}\nCiphertext only — WALLET_SECRET is NOT in this file (keep it backed up separately, offline).`);
    fd.append('document', new Blob([gz]), `tradebot-${stamp}.json.gz`);
    const r = await fetch(`${API}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => null);
    if (!j || j.ok !== true) { console.error('tg backup failed:', j && j.description); return false; }
    return true;
  } catch (e) { console.error('tg backup failed:', e.message); return false; }
}

// Register the blue "/" command menu with Telegram (English only). Best-effort:
// a failure never blocks boot.
async function registerCommands() {
  const en = [
    { command: 'start',     description: 'Open the bot — wallet & main menu' },
    { command: 'wallet',    description: 'Wallets: balance, deposit, withdraw, import' },
    { command: 'portfolio', description: 'Your holdings & profit/loss' },
    { command: 'monitor',   description: 'Live position tracker — pins & refreshes itself' },
    { command: 'history',   description: 'Your past trades' },
    { command: 'chain',     description: 'Switch chain (Robinhood, ETH, Base, BNB, ARB, SOL)' },
    { command: 'buy',       description: 'Buy a token: /buy <address> <amount or $usd>' },
    { command: 'sell',      description: 'Sell a token: /sell <address> <percent>' },
    { command: 'snipe',     description: 'Auto-buy new launches' },
    { command: 'copy',      description: 'Copy another wallet\'s buys' },
    { command: 'orders',    description: 'Auto-sell orders (take-profit / stop-loss)' },
    { command: 'dca',       description: 'Scheduled recurring buys' },
    { command: 'alerts',    description: 'Price alerts' },
    { command: 'send',      description: 'Send tokens out: /send <token> <address> <amount>' },
    { command: 'referral',  description: 'Your referral link & earnings' },
    { command: 'help',      description: 'How the bot works' },
    { command: 'cancel',    description: 'Cancel what you were doing' },
  ];
  try {
    await tg('setMyCommands', { commands: en });
  } catch (_) { /* menu is cosmetic — never block boot on it */ }
}

async function start() {
  if (!core.CFG.tgToken) { console.error('TRADEBOT_TOKEN missing.'); process.exit(1); }
  if (!core.CFG.walletSecret) { console.error('WALLET_SECRET missing — refusing to run custodial without key encryption.'); process.exit(1); }
  core.loadStore();
  await getMe();
  await registerCommands();
  await refreshPrices();
  setInterval(refreshPrices, 120000);
  // `type` (snipe|copy|alerts) is gated by the user's notification settings; order
  // fills / payouts pass no type and always notify.
  watchers.setNotifier((chatId, text, kb, type) => {
    if (type && !core.notifyOn(chatId, type)) return Promise.resolve();
    return send(chatId, text, kb).catch(() => {});
  });
  watchers.start();
  // Pinned live-position cards outlive the process that drove them. Give them
  // their loop back (or retire them) before the first update is polled.
  resumeMonitors().catch((e) => console.error('[monitor] resume failed', e && (e.message || e)));
  // Periodic volume/fee recap to the admin channel (default every 24h). Posts only when
  // there were trades, then resets the window. Never touches the trade path.
  if (report.enabled()) {
    // DAILY recap: once per UTC day at/after REPORT_RECAP_HOUR (default 0 UTC = 07:00
    // WIB). Sent every day even with 0 trades; survives restarts (persisted date).
    const recapHour = Math.min(23, Math.max(0, Number(process.env.REPORT_RECAP_HOUR || 0)));
    (async function recapLoop() {
      for (;;) {
        await sleep(20 * 60 * 1000);   // check every 20 min
        try {
          if (core.recapDue(recapHour)) {
            await report.post('🗓 <b>Daily report</b>\n\n' + statsText(core.reportSnapshot(), core.allUsers().length));
            core.markRecap();
            core.resetReportWindow();
          }
        } catch (_) {}
      }
    })();
    console.log(`ops reporting ENABLED → channel (daily recap ~${recapHour}:00 UTC)`);
    // Announce the fee treasury to the channel so the operator always knows
    // (and can verify on-chain) which wallet the 1% fee is collected to.
    // AT MOST ONCE A DAY: this used to post on every boot, and a deploy session
    // is a dozen boots — the same card, minute after minute, on top of the feed
    // it exists to keep readable. The mark is persisted, so restarts stay quiet.
    if (core.opsDue('boot_announce', DAY_MS)) {
      core.markOps('boot_announce');   // mark FIRST: a crash-loop must not out-race the send
      const evmT = core.CFG.feeWallet, solT = core.CFG.solFeeWallet;
      report.post(`🟢 <b>Dexvra Trade Bot online</b> — @${BOT_USERNAME || '?'}\n💰 <b>Fee treasury (1% per trade)</b>` +
        (evmT ? `\n  EVM: <code>${esc(evmT)}</code>` : '') +
        (solT ? `\n  SOL: <code>${esc(solT)}</code>` : '') +
        `\n\n<i>Every trade sends its fee here. Cross-check the balance against the daily report.</i>`).catch(() => {});
    }
  }
  // Off-site store backup to a private Telegram channel (see tgBackupOnce).
  // The archive used to be uploaded unconditionally at boot AND on a fresh
  // setInterval, so every restart shipped another one — two archives three
  // minutes apart is what the operator actually saw. Now the TIMER is what runs
  // often; the UPLOAD only happens when one is genuinely due, measured from the
  // persisted time of the last successful upload rather than from process start.
  if (backupChannel()) {
    const hours = Math.max(1, Number(process.env.BACKUP_TG_HOURS || 24));
    const gap = hours * 3600 * 1000;
    const backupIfDue = async () => {
      if (!core.opsDue('tg_backup', gap)) return false;
      // Marked only on a confirmed upload: a failed send should retry at the
      // next check, not silently skip the day it was meant to cover.
      const ok = await tgBackupOnce();
      if (ok) core.markOps('tg_backup');
      return ok;
    };
    backupIfDue();
    setInterval(backupIfDue, BACKUP_CHECK_MS);
    console.log(`telegram store backup ENABLED → channel at most every ${hours}h`);
  }
  console.log(`Dexvra Trade Bot up as @${BOT_USERNAME || '?'} — chains: ${core.chains.ENABLED.join(', ')}`);

  let offset = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      if (r && r.ok && r.result.length) for (const up of r.result) { offset = up.update_id + 1; handleUpdate(up); }
    } catch (e) { await new Promise((s) => setTimeout(s, 2000)); }
  }
}

module.exports = { start, _test: { parseUsd, usdShort, orderPrompt, _shouldAnswerInGroup, walletScreen, walletsScreen, depositScreen, settingsScreen, notifyScreen, securityScreen, ordersScreen, dcaScreen, portfolioScreen, helpText, statsText, walletPickScreen, tradeTargets, tokenCard, sellMenu, monitorPayload, startMonitor, stopMonitor, adoptMonitor, resumeMonitors, _monitors, _monitorByToken, MON_EVERY_MS, MON_WINDOW_MS, gasScreen, langScreen, monitorListScreen, friendlyError, copyScreen, snipeScreen, quickSym, walletLabelFor, PRICES, isCa, fmtNat, wAddr, isAddrFor, _placeAutoExit, parseAmt } };
if (require.main === module) start();
