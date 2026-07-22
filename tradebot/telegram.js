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

// ------------------------------------------------------------ telegram api
async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  return r.json();
}
function send(chatId, text, kb) { const rt = _replyCtx.getStore(); return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}), ...(rt ? { reply_to_message_id: rt, allow_sending_without_reply: true } : {}) }); }
function edit(chatId, mid, text, kb) { return tg('editMessageText', { chat_id: chatId, message_id: mid, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}) }); }
function answer(id, text) { return tg('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }); }
function del(chatId, mid) { return tg('deleteMessage', { chat_id: chatId, message_id: mid }).catch(() => {}); }
function sendPhoto(chatId, photo, caption, kb) { return tg('sendPhoto', { chat_id: chatId, photo, ...(caption ? { caption, parse_mode: 'HTML' } : {}), ...(kb ? { reply_markup: kb } : {}) }); }
// Deposit QR image (Telegram fetches the URL server-side; the address is public, so no
// secret leaves the bot). Configurable / disable-able via QR_API. Returns '' if disabled.
const QR_API = (process.env.QR_API === undefined ? 'https://api.qrserver.com/v1/create-qr-code' : process.env.QR_API).replace(/\/+$/, '');
const qrUrl = (data) => QR_API ? `${QR_API}/?size=320x320&margin=10&data=${encodeURIComponent(data)}` : '';
const rows = (...r) => ({ inline_keyboard: r });
const btn = (text, data) => ({ text, callback_data: data });

// ------------------------------------------------------------ helpers
// Escape ALL five HTML-sensitive chars — including " and ' — so a creator-set
// value (e.g. a token's website URL) can't break out of an href="..." attribute.
// &quot; and &#39; are both valid Telegram-HTML entities and render as the literal
// quote in text, so this is safe everywhere esc() is used.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
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
const DS_SLUG = { ethereum: 'ethereum', base: 'base', bsc: 'bsc', arbitrum: 'arbitrum', solana: 'solana' };
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
  const walletUsd = matrix.map(usdOfRow);
  const grandUsd = walletUsd.reduce((a, b) => a + b, 0);
  const anyFunds = matrix.some((row) => row.some((b, i) => b != null && Number(fmtNat(b, allChains[i].key)) > 0));
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
    body += `${active ? '✅' : '▫️'} <b>${esc(label)}</b>${active ? ' <i>· active</i>' : ''} · <b>≈ $${fmt(walletUsd[i])}</b> all chains${nOrders ? ' · ' + nOrders + ' order' + (nOrders > 1 ? 's' : '') : ''}\n`;
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
  const head = `💼 <b>Your Wallets</b> · ${ch.emoji} ${esc(ch.name)}\n${list.length}/${core.WALLET_CAP} wallets · total <b>≈ $${fmt(grandUsd)}</b> across ${allChains.length} chains\n\n`
    + `🌐 <b>${esc(core.walletLabel(list[awIdx], awIdx + 1))} — all chains</b>${walletUsd[awIdx] > 0.005 ? ` · ≈ $${fmt(walletUsd[awIdx])}` : ''}\n${chainBlock}\n`;
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
async function tokenCard(chatId, ca, chainKey, walletId) {
  const u = core.ensureUser(chatId);
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
  const SEP = '━━━━━━━━━━━━━━━━';
  // ── Header: name · symbol, then chain · live trading venue, then the contract ──
  const statusBadge = info.dex ? `◆ DEX${info.dexVenue === 'v3' ? ' · V3 pool' : ''}` : (info.graduated ? '◆ Graduated' : `◈ Bonding curve · ${(info.progressPct || 0).toFixed(0)}%`);
  L.push(`<b>${esc(name)}</b> · <b>$${esc(sym)}</b>`);
  L.push(`${ch.emoji} ${esc(ch.name)}  ·  ${statusBadge}`);
  L.push(`<code>${ca}</code>`);
  if (sec) { const v = safety.verdict(chainKey, sec); if (v.level === 'danger') L.push(`🚨 <b>HIGH RISK</b> — ${esc(v.red.join(', '))}`); else if (v.level === 'warn') L.push(`⚠️ <b>Caution</b> — ${esc(v.warn.join(', '))}`); }
  // ── Market stats (compact: paired values per line, minimal icons) ──
  L.push(SEP);
  const mkt = info.market;
  const mcapUsd = (api && api.marketCapUsd) || (info.mcapEth * nativeUsd(nat));
  const priceStr = priceUsd > 0 ? '$' + priceUsd.toPrecision(3) : px.toExponential(2) + ' ' + nat;
  const mcapStr = mcapUsd > 0 ? '$' + fmt(mcapUsd) : usd(info.mcapEth, nat);
  L.push(`Price <b>${priceStr}</b>  ·  MC <b>${mcapStr}</b>`);
  // Liquidity / Raised · Vol 24h
  const line2 = [];
  if (info.liquidityNative != null) line2.push(`Liq <b>${info.liquidityNative.toFixed(2)} ${nat}</b> (${usd(info.liquidityNative, nat)})`);
  else if (info.raised != null) line2.push(`Raised <b>${info.raised.toFixed(2)}/${(info.target || 0).toFixed(1)} ${nat}</b>`);
  const vol24 = (api && api.volume && api.volume.h24Usd != null) ? api.volume.h24Usd : (mkt && mkt.volH24Usd != null ? mkt.volH24Usd : null);
  if (vol24 != null) line2.push(`Vol 24h <b>$${fmt(vol24)}</b>`);
  if (line2.length) L.push(line2.join('  ·  '));
  // Thin-pool warning: indexer sees far deeper liquidity than the pool the bot can trade.
  if (info.liquidityNative != null && mkt && mkt.liqUsd > 0) {
    const poolUsd = info.liquidityNative * nativeUsd(nat);
    if (mkt.liqUsd > Math.max(poolUsd, 1) * 5) L.push(`⚠️ Thin tradeable pool — market liq <b>$${fmt(mkt.liqUsd)}</b> sits on a pool this bot can't reach; buys move the price hard.`);
  }
  // Change · Txns
  if (mkt) {
    const chg = (v) => (v == null ? null : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`);
    const c1 = chg(mkt.chgH1), c24 = chg(mkt.chgH24);
    const line3 = [];
    if (c1 != null || c24 != null) line3.push([c1 != null ? `1h ${c1}` : null, c24 != null ? `24h ${c24}` : null].filter(Boolean).join(' · '));
    if (mkt.buysH24 != null || mkt.sellsH24 != null) line3.push(`${mkt.buysH24 || 0} buys / ${mkt.sellsH24 || 0} sells`);
    if (line3.length) L.push(line3.join('  ·  '));
  }
  // Holders · LP · Tax · flags · Age (one line)
  const line4 = [];
  if (sec && sec.holders != null) line4.push(`${sec.holders} holders`);
  if (sec && sec.lpLockedPct != null) line4.push(`LP ${Math.round(sec.lpLockedPct)}% locked`);
  else if (ch.curve && info.graduated) line4.push('LP burned');
  if (sec) line4.push(`Tax ${taxStr(sec.buyTaxPct)}/${taxStr(sec.sellTaxPct)}`);
  if (sec && sec.honeypot) line4.push('🔴 HONEYPOT');
  if (sec && sec.openSource === false) line4.push('closed-source');
  const created = (api && api.createdAt) || (mkt && mkt.createdAt);
  if (created) line4.push(`Age ${fmtAge(created)}`);
  if (line4.length) L.push(line4.join('  ·  '));
  else if (ch.curve && !sec) L.push(`Fair-launch · 0% tax · LP burned on graduation`);
  if (api && api.links) { const lk = []; if (api.links.website) lk.push(`<a href="${esc(api.links.website)}">Web</a>`); if (api.links.twitter) lk.push(`<a href="${esc(api.links.twitter)}">X</a>`); if (api.links.telegram) lk.push(`<a href="${esc(api.links.telegram)}">TG</a>`); if (lk.length) L.push(lk.join(' · ')); }
  const valueEth = bal * px;
  const sel = core.tradeSelection(chatId);
  const selIds = new Set(core.tradeWalletIds(chatId));
  const selN = selIds.size;
  const usdOf = (tokens) => (priceUsd > 0 ? '$' + fmt(tokens * priceUsd) : '—');   // USD worth of a token bag
  if (list.length > 1) {
    // Per-wallet balance table (Maestro "Balance" panel): ✅ marks the wallet(s) a
    // Buy/Sell will act on (single, a selected subset, or ALL). Shows each bag's USD worth.
    L.push(SEP);
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
    if (sel.all) L.push(`<i>Trading all ${list.length} wallets — tap 👛 below to change.</i>`);
    else if (selN >= 1) L.push(`<i>Trading ${selN} selected wallet${selN > 1 ? 's' : ''} — tap 👛 below to change.</i>`);
    else L.push(`<i>Trading ${esc(core.walletLabel(w, wi))}${autoSwitched ? ' (holds this token)' : ''} — tap 👛 to use several.</i>`);
  } else {
    // Single wallet: ALWAYS show the bag (even "none") and the wallet's native
    // balance, so the card answers "what do I hold and what can I spend" at a glance.
    L.push(SEP);
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
  // Multi-wallet users get a picker row: choose one / several / ALL wallets to trade from.
  const selLabel = sel.all ? `👛 Trading: ALL ${list.length} wallets` : (selN >= 1 ? `👛 Trading: ${selN} wallet${selN > 1 ? 's' : ''}` : `👛 Trade from: ${core.walletLabel(w, wi)}`);
  const walletRow = list.length > 1 ? [[btn(selLabel, `wsel:${chainKey}:${ca}`)]] : [];
  const ikb = [
    ...walletRow,
    [btn(`Buy ${bp[0]}`, `b:${chainKey}:${wi}:${ca}:${bp[0]}`), btn(`Buy ${bp[1]}`, `b:${chainKey}:${wi}:${ca}:${bp[1]}`), btn(`Buy ${bp[2]}`, `b:${chainKey}:${wi}:${ca}:${bp[2]}`), btn('Buy X', `bx:${chainKey}:${wi}:${ca}`)],
    [btn('Sell 25%', `s:${chainKey}:${wi}:${ca}:25`), btn('Sell 50%', `s:${chainKey}:${wi}:${ca}:50`), btn('Sell 75%', `s:${chainKey}:${wi}:${ca}:75`), btn('Sell 100%', `s:${chainKey}:${wi}:${ca}:100`)],
    [btn('🔻 Sell other %', `sx:${chainKey}:${wi}:${ca}`), btn('🎯 TP', `tp:${chainKey}:${wi}:${ca}`), btn('🛑 SL', `sl:${chainKey}:${wi}:${ca}`), btn('📉 Trail', `trl:${chainKey}:${wi}:${ca}`), btn('⏳ Limit', `lb:${chainKey}:${wi}:${ca}`)],
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
async function portfolioScreen(chatId) {
  const pf = await core.portfolioAll(chatId);   // aggregated across ALL wallets (Maestro style)
  const nat = pf.native || 'ETH';
  if (!pf.rows.length) return { text: `📊 <b>Portfolio</b> · ${pf.chain ? pf.chain.emoji + ' ' + esc(pf.chain.name) : ''}\n\nNo holdings on this chain across your wallets. Paste a token contract to buy, or switch chain.`, kb: rows([btn('🌐 Chain', 'chain'), btn('« Menu', 'menu')]) };
  let body = '', totalUnreal = 0, totalIn = 0, totalOut = 0;
  for (const r of pf.rows) {
    totalUnreal += r.unrealizedEth; totalIn += r.ethIn; totalOut += r.ethOut;
    // x-multiple on invested = (what it's worth now + what you've already taken out) / put in.
    const mult = r.ethIn > 0 ? (r.valueEth + r.ethOut) / r.ethIn : 0;
    const multStr = mult > 0 ? mult.toFixed(2) + '×' : '—';
    const pnlPct = r.ethIn > 0 ? (mult - 1) * 100 : 0;
    const who = (r.holders && r.holders.length) ? r.holders.map((h) => `${esc(h.label)} ${fmt(h.tokens)}`).join(', ') : '—';
    body += `<b>$${esc(r.sym)}</b> · ${usd(r.valueEth, nat)} · <b>${multStr}</b> ${r.ethIn > 0 ? `(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(0)}%)` : ''}\n   ${fmt(r.tokens)} · in ${r.ethIn.toFixed(4)} → now ${r.valueEth.toFixed(4)} ${nat} · PnL <b>${r.unrealizedEth >= 0 ? '+' : ''}${r.unrealizedEth.toFixed(4)}</b>\n   held: ${who}\n   <code>${r.ca}</code>\n`;
  }
  const pMult = totalIn > 0 ? (pf.totalValueEth + totalOut) / totalIn : 0;
  const pPct = totalIn > 0 ? (pMult - 1) * 100 : 0;
  const text = `📊 <b>Portfolio</b> · ${pf.chain.emoji} ${esc(pf.chain.name)} · all wallets\n` +
    `Value <b>${usd(pf.totalValueEth, nat)}</b> · ${pf.totalValueEth.toFixed(4)} ${nat}${totalIn > 0 ? ` · <b>${pMult.toFixed(2)}×</b> (${pPct >= 0 ? '+' : ''}${pPct.toFixed(0)}%)` : ''}\n\n${body}\n` +
    `Invested <b>${totalIn.toFixed(4)}</b> · out <b>${totalOut.toFixed(4)}</b> ${nat}\nUnrealized PnL: <b>${totalUnreal >= 0 ? '+' : ''}${totalUnreal.toFixed(4)} ${nat}</b> (${usd(Math.abs(totalUnreal), nat)})`;
  return { text, kb: rows([btn('🔄 Refresh', 'pos'), btn('🧾 History', 'hist'), btn('🌐 Chain', 'chain'), btn('« Menu', 'menu')]) };
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
  return { text: `🧾 <b>History</b> · Wallet ${wi} · ${ch.emoji} ${esc(ch.name)}\nNet PnL (this chain): <b>${rp} ${ch.native}</b>\n<i>proceeds − total cost; a partly-sold bag reads low until fully exited</i>\n\n${body}`, kb: rows([btn('🔄 Refresh', 'hist'), btn('📊 Portfolio', 'pos'), btn('« Menu', 'menu')]) };
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
    body += `${c.emoji} <b>${label}</b> $${esc(o.sym || '')} @ ${tgt}${tail}${wtag}\n`;
    kbRows.push([btn(`✖ Cancel ${label} $${o.sym || ''}${multi ? ' (W' + wi + ')' : ''}`, `oc:${o.id}`)]);
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
    `Master switch: <b>${c.on ? '🟢 ON' : '⚪ OFF'}</b>\n\n`;
  const kbRows = [[btn(c.on ? '🔴 Turn OFF' : '🟢 Turn ON', 'cptog')]];
  if (!list.length) body += '<i>No wallets followed yet — add one below.</i>\n';
  else {
    body += '<b>Following:</b>\n';
    for (const t of list) {
      const ch = core.chainOf(t.chain) || { emoji: '' };
      const badge = (t.mode === 'launches') ? '🎯 dev snipe' : '👥 copy trades';
      const spent = Number(t.spentEth).toFixed(3), max = esc(t.maxEth);
      body += `${ch.emoji} <code>${short(t.address)}</code> · <b>${badge}</b>\n    ${esc(t.buyEth)}/buy · used ${spent}/${max} ${ch.native || ''}\n`;
      kbRows.push([btn(`✖ Remove ${t.mode === 'launches' ? '🎯' : '👥'} ${short(t.address)}`, `cprm:${t.id}`)]);
    }
  }
  if (list.length < core.MAX_COPY_TARGETS) {
    kbRows.push([btn('➕ Copy trades', 'cpadd')]);
    // Dev snipe is only offered when the active chain is a launchpad chain.
    if (core.canDevSnipe(ach.key)) kbRows.push([btn('🎯 Snipe a dev wallet', 'cpaddd')]);
  }
  kbRows.push([btn('« Menu', 'menu')]);
  body += `\n<i>Both modes skip honeypots and are capped by your budget. You manage sells. Turn the master switch ON to start. ⚠️ High risk — DYOR.</i>`;
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
      `Active chain: <b>${ch.emoji} ${esc(ch.name)}</b>\n` +
      `Slippage: <b>${esc(String(slip))}</b>\n` +
      `Gas priority: <b>${esc(gasName)}</b>\n` +
      `Quick-buy (${esc(ch.name)}): <b>${esc(bp)} ${ch.native}</b>${perChain}\n` +
      `Confirm before buy: <b>${onoff(s.confirmBuy)}</b>\n` +
      `Fast mode: <b>${onoff(s.expert)}</b>\n` +
      `Auto-buy on paste: <b>${s.autoBuy ? '🟢 ON · ' + esc(s.autoBuyAmount) + ' ' + ch.native : '⚪ OFF'}</b>\n` +
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
      [btn('❔ Help', 'help'), btn('« Menu', 'menu')],
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
async function doBuy(chatId, ca, amt, chain, walletId) {
  const u = core.ensureUser(chatId);
  // HARD thin-pool block (operator rule: the bot must NEVER buy into a small
  // LP). Estimated V2 impact = amt / (poolNativeReserve + amt); at or above
  // PRICE_IMPACT_MAX_PCT (default 10%) the buy is refused — no override
  // button. Covers every manual path incl. auto-buy-on-paste, since they all
  // execute through doBuy. Fails open only if the pool can't be read at all.
  const chG = core.chainOf(chain) || core.chainOf(core.userChain(u));
  if (!core.chains.isSvm(chG.key)) {
    try {
      // Depth of the venue the trade would ACTUALLY use (V2 pair or deepest V3
      // pool) — so deep-V3 tokens aren't falsely blocked by a dusty V2 pair.
      const pick = await withTmo(core.bestDexVenue(ca, chG.key).catch(() => null), 6000, null);
      const liq = pick && pick.wethBal != null ? Number(ethers.formatEther(pick.wethBal)) * 2 : null;
      if (liq != null && liq >= 0) {
        const amtN = Number(amt) || 0;
        const impact = (amtN / (liq / 2 + amtN)) * 100;
        const maxAt = Math.max(1, Number(process.env.PRICE_IMPACT_MAX_PCT || 10));
        if (impact >= maxAt) {
          const maxSafe = (maxAt / 100) * (liq / 2) / (1 - maxAt / 100);
          return send(chatId,
            `🚫 <b>Buy blocked — thin pool</b>\n\nTradeable liquidity for <code>${short(ca)}</code> is only <b>${liq.toFixed(3)} ${chG.native}</b> (${usd(liq, chG.native)}). A <b>${esc(String(amt))} ${chG.native}</b> buy would move the price ~<b>${impact.toFixed(0)}%</b> — over the ${maxAt}% limit, so the bot refuses to fill it.` +
            `${maxSafe > 0.00001 ? `\n\nLargest buy within the limit: ~<b>${maxSafe.toFixed(5)} ${chG.native}</b>.` : ''}` +
            `\nIf the token's real depth sits on a V3 pool, this bot can't trade it — use the DEX directly for this one.`,
            rows([btn('🔄 Card', `tok:${chG.key}:${walletIndex(chatId, walletId)}:${ca}`), btn('« Menu', 'menu')]));
        }
      }
    } catch (_) {}
  }
  const key = chatId + ':' + (chain || core.userChain(u)) + ':' + String(ca).toLowerCase();
  if (_inflightBuy.has(key)) return send(chatId, '⏳ Already buying that token — wait for the result before buying again.');
  _inflightBuy.add(key);
  const expert = u.settings.expert;
  const targets = tradeTargets(chatId, walletId);
  try {
    if (targets.length <= 1) {
      const wid = targets[0] ? targets[0].id : walletId;
      // One message: a short "Buying…" that we EDIT into the receipt (no second message).
      const progress = expert ? null : await send(chatId, `⏳ <b>Buying ${esc(amt)} ${chG.native}…</b>`);
      const r = await core.buy(chatId, ca, amt, chain, wid);
      const wi = walletIndex(chatId, wid);
      const usdRate = nativeUsd(r.native);
      const spent = Number(r.spentEth) || 0, got = Number(r.gotTokens) || 0;
      const usd2 = (v) => (usdRate > 0 ? `$${(v * usdRate).toFixed(2)}` : '—');
      const uu = core.getUser(chatId);
      const wl = core.walletLabel((uu && core.walletById(uu, wid)) || core.activeWallet(uu), wi);
      let holdUsd = usdRate > 0 && spent > 0 ? usd2(spent) : '—';
      let statLine = '';
      try {
        const snap = await withTmo(core.tokenSnapshot(ca, r.chain).catch(() => null), 4000, null);
        if (snap && snap.priceEth > 0) {
          if (usdRate > 0 && got > 0) holdUsd = `$${(got * snap.priceEth * usdRate).toFixed(2)}`;
          const pxUsd = snap.priceEth * usdRate;
          const mcUsd = snap.mcapUsd || ((snap.mcapEth || 0) * usdRate);
          if (pxUsd > 0) statLine = `\nEntry: <b>$${pxUsd.toPrecision(3)}</b>${mcUsd > 0 ? ` · MC <b>$${fmt(mcUsd)}</b>` : ''}`;
        }
      } catch (_) {}
      const exp2 = core.chainOf(r.chain);
      const venue = r.venue === 'curve' ? 'Launchpad' : (r.venue === 'dex·v3' ? 'DEX (V3)' : 'DEX');
      const autoLine = await _placeAutoExit(chatId, r, wid);
      const receipt =
        `✅ <b>Bought $${esc(r.sym)}</b>\n` +
        `Spent: <b>${spent.toFixed(6)} ${r.native}</b> (${usd2(spent)})\n` +
        `Got: <b>${fmt(got)} $${esc(r.sym)}</b> (${holdUsd})` +
        statLine +
        `\nWallet: ${esc(wl)} · ${venue}` + autoLine;
      const kb = { inline_keyboard: [
        [{ text: '🔍 Tx', url: `${exp2.explorer}/tx/${r.hash}` }, btn('📍 Monitor', `monn:${r.chain}:${wi}:${ca}`)],
        [btn('🔄 Card', `tok:${r.chain}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')],
      ] };
      const pid = progress && progress.ok && progress.result && progress.result.message_id;
      if (pid) await edit(chatId, pid, receipt, kb); else await send(chatId, receipt, kb);
    } else {
      const progress = expert ? null : await send(chatId, `⏳ <b>Buying ${esc(amt)} ${chG.native} on ${targets.length} wallets…</b>`);
      const results = await Promise.allSettled(targets.map((t) => core.buy(chatId, ca, amt, chain, t.id)));
      let okN = 0, totTok = 0, totSpent = 0, totFee = 0, sym = '', chainKey = chain || core.userChain(u), nat = '', lines = [];
      results.forEach((res, i) => {
        const t = targets[i];
        if (res.status === 'fulfilled') { const r = res.value; okN++; totTok += Number(r.gotTokens) || 0; totSpent += Number(r.spentEth) || 0; totFee += Number(r.feeEth) || 0; sym = r.sym || sym; chainKey = r.chain || chainKey; nat = r.native || nat; lines.push(`• ${esc(t.label)}: ${fmt(r.gotTokens)} $${esc(r.sym)} · ${r.spentEth} ${r.native}`); _placeAutoExit(chatId, r, t.id).catch(() => {}); }
        else { const e = res.reason; lines.push(`• ${esc(t.label)}: ❌ ${esc(String((e && (e.message || e)) || 'failed').slice(0, 60))}`); }
      });
      const wi = walletIndex(chatId, targets[0].id);
      const mUsd = nativeUsd(nat || 'ETH');
      const head = `✅ <b>Bought $${esc(sym || '')}</b> · ${okN}/${targets.length} wallets\nTotal: <b>${fmt(totTok)} $${esc(sym || '')}</b> · spent <b>${totSpent.toFixed(5)} ${esc(nat || 'ETH')}</b>${mUsd > 0 ? ` ($${(totSpent * mUsd).toFixed(2)})` : ''}`;
      const kb = rows([btn('🔄 Card', `tok:${chainKey}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')]);
      const pid = progress && progress.ok && progress.result && progress.result.message_id;
      const txt = head + '\n' + lines.join('\n');
      if (pid) await edit(chatId, pid, txt, kb); else await send(chatId, txt, kb);
    }
  } catch (e) { console.error('buy failed:', e && (e.message || e)); await send(chatId, `❌ <b>Buy didn't go through</b>\n\n${esc(friendlyError(e, 'buy'))}`, rows([btn('🔄 Try again', `tok:${chain || core.userChain(u)}:${walletIndex(chatId, walletId)}:${ca}`), btn('« Menu', 'menu')])); }
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
// Turn a raw on-chain / RPC error into one clear, professional sentence a
// non-technical user understands. Falls back to a generic line. The original
// message is still logged server-side for the operator.
function friendlyError(raw, action) {
  const m = String(raw && (raw.message || raw) || '').toLowerCase();
  const act = action || 'transaction';
  if (/token balance is 0|no bag/.test(m)) return `You don't hold any of this token to sell.`;
  if (/insufficient|need ~|exceeds balance/.test(m)) return `Not enough balance to cover this ${act} plus network gas. Top up and try again.`;
  if (/max fee per gas|base fee|underpriced|replacement|nonce/.test(m)) return `The network gas price just moved. Please tap ${act === 'buy' ? 'Buy' : 'Sell'} again — it usually goes through on the next try.`;
  if (/thin pool|price impact|slippage|reverted|IIA|too little received/.test(m)) return `The price moved faster than your slippage allows, so the ${act} didn't go through. Try again, or raise your slippage in ⚙️ Settings.`;
  if (/not confirmed|timeout|pending/.test(m)) return `The network is slow right now — your ${act} may still complete. Check your wallet before trying again.`;
  if (/could not (read|price)|pool read|quote|no pool|no liquidity/.test(m)) return `Couldn't read live pricing for this token right now. Please try again in a moment.`;
  if (/private beta|not allowed|notallowed/.test(m)) return `This token can't be traded yet (it may be restricted). Try a different token.`;
  return `The ${act} didn't go through. Please try again in a moment.`;
}
async function sellWithRetry(chatId, ca, pct, chain, wid, onStep) {
  let lastErr;
  for (let i = 0; i < SELL_ESCALATION.length; i++) {
    try { return await core.sell(chatId, ca, pct, chain, wid, SELL_ESCALATION[i]); }
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
      const progress = expert ? null : await send(chatId, `⏳ <b>Selling ${pct}% of ${sym0 ? '$' + esc(sym0) : 'your token'}…</b>`);
      const r = await sellWithRetry(chatId, ca, pct, chain, wid, (n) => (progress && progress.ok && progress.result) ? edit(chatId, progress.result.message_id, `⚙️ <b>Retry ${n}/2</b> — raising gas &amp; slippage to complete the sell…`).catch(() => {}) : null);
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
        ? `\nP/L: <b>${pnl >= 0 ? '🟢 +' : '🔴 '}${pnl.toFixed(6)} ${r.native}</b>${pnlUsd != null ? ` (${pnl >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)})` : ''}`
        : '';
      const receipt =
        `✅ <b>Sold ${r.soldPct}% of $${esc((r.sym) || sym0 || '')}</b>\n` +
        `Received: <b>${got2.toFixed(6)} ${r.native}</b>${sUsd > 0 ? ` ($${(got2 * sUsd).toFixed(2)})` : ''}` +
        pnlLine +
        `\nWallet: ${esc(wl2)} · ${svenue}`;
      const kb = { inline_keyboard: [
        [{ text: '🔍 Tx', url: `${sexp.explorer}/tx/${r.hash}` }, btn('🔄 Card', `tok:${r.chain}:${wi}:${ca}`)],
        [btn('📊 Portfolio', 'pos')],
      ] };
      const pid = progress && progress.ok && progress.result && progress.result.message_id;
      if (pid) await edit(chatId, pid, receipt, kb); else await send(chatId, receipt, kb);
    } else {
      const progress = expert ? null : await send(chatId, `⏳ <b>Selling ${pct}% on ${targets.length} wallets…</b>`);
      const results = await Promise.allSettled(targets.map((t) => sellWithRetry(chatId, ca, pct, chain, t.id)));
      let okN = 0, skip = 0, totProceeds = 0, totFee = 0, chainKey = chain || core.userChain(core.ensureUser(chatId)), nat = '', lines = [];
      results.forEach((res, i) => {
        const t = targets[i];
        if (res.status === 'fulfilled') { const r = res.value; okN++; totProceeds += Number(r.proceedsEth) || 0; totFee += Number(r.feeEth) || 0; chainKey = r.chain || chainKey; nat = r.native || nat; lines.push(`• ${esc(t.label)}: ${r.proceedsEth} ${r.native}`); }
        else { const e = res.reason; const msg = String((e && (e.message || e)) || 'failed'); if (/token balance is 0/i.test(msg)) { skip++; lines.push(`• ${esc(t.label)}: — no bag`); } else lines.push(`• ${esc(t.label)}: ❌ ${esc(msg.slice(0, 60))}`); }
      });
      const wi = walletIndex(chatId, targets[0].id);
      const msUsd = nativeUsd(nat || 'ETH');
      const head = `✅ <b>Sold ${pct}%</b> · ${okN}/${targets.length} wallets${skip ? ` (${skip} had no bag)` : ''}\nTotal received: <b>${totProceeds.toFixed(5)} ${esc(nat || 'ETH')}</b>${msUsd > 0 ? ` ($${(totProceeds * msUsd).toFixed(2)})` : ''}`;
      const kb = rows([btn('🔄 Card', `tok:${chainKey}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')]);
      const txt = head + '\n' + lines.join('\n');
      const pid = progress && progress.ok && progress.result && progress.result.message_id;
      if (pid) await edit(chatId, pid, txt, kb); else await send(chatId, txt, kb);
    }
  } catch (e) { console.error('sell failed:', e && (e.message || e)); await send(chatId, `❌ <b>Sell didn't go through</b>\n\n${esc(friendlyError(e, 'sell'))}`, rows([btn('🔄 Try again', `tok:${chain || core.userChain(core.ensureUser(chatId))}:${walletIndex(chatId, walletId)}:${ca}`), btn('« Menu', 'menu')])); }
}

// ------------------------------------------------------------ router
async function handleUpdate(up) {
  try {
    const chat = (up.message && up.message.chat) || (up.callback_query && up.callback_query.message && up.callback_query.message.chat);
    if (chat && chat.type !== 'private') {
      if (up.callback_query) await answer(up.callback_query.id, 'DM me privately — group use is disabled.');
      else if (up.message) await send(chat.id, 'This is a custodial trading bot — please DM me privately. Group use is disabled for security.');
      return;
    }
    const from = (up.message && up.message.from) || (up.callback_query && up.callback_query.from);
    if (from) core.noteUser(from.id, from);   // remember @username (no-op until the user exists)
    if (up.message) return await onMessage(up.message);
    if (up.callback_query) return await onCallback(up.callback_query);
  } catch (e) { console.error('handleUpdate', e.message); }
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
  if (text === '/cancel') return send(chatId, 'Cancelled.', mainMenu());

  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || null;
    // Deep link from the Dexvra channels' "⚡ Trade" line: /start ca_<address>
    // opens the token card directly (chain auto-detected). Anything else stays
    // a referral code, exactly as before.
    const deepCa = (payload && payload.startsWith('ca_') && isCa(payload.slice(3))) ? payload.slice(3) : null;
    const ref = deepCa ? null : payload;
    const isNew = !core.getUser(chatId);
    core.ensureUser(chatId, ref);
    core.noteUser(chatId, m.from);                 // capture @username now that the user exists
    report.onStart(core.getUser(chatId), isNew, ref, core.allUsers().length);   // → admin channel (fire-and-forget)
    if (deepCa) {
      if (isNew) await send(chatId, `👋 <b>Welcome to Dexvra Trade Bot</b>\n\nA wallet was just created for you. To start trading, tap 💼 Wallets → 📥 to get your deposit address and add some funds. Here's the token you tapped 👇`, mainMenu());
      const det = await detectChain(chatId, deepCa);
      if (det.choices) {
        const kb = det.choices.map((ck) => { const c = core.chainOf(ck); return [btn(`${c.emoji} ${c.name}`, `tok:${ck}:${walletIndex(chatId)}:${deepCa}`)]; });
        kb.push([btn('« Menu', 'menu')]);
        return send(chatId, `🌐 <code>${short(deepCa)}</code> exists on <b>${det.choices.length} chains</b> — pick where to trade:`, { inline_keyboard: kb });
      }
      const c = await tokenCard(chatId, deepCa, det.chain);
      return send(chatId, c.text, c.kb);
    }
    const activeW = core.activeWallet(core.ensureUser(chatId));
    // New users get a single obvious first action (get the deposit address); returning
    // users get the normal menu.
    const welcomeKb = (isNew && activeW)
      ? { inline_keyboard: [[btn('📥 Get my deposit address', 'qrw:' + activeW.id)], [btn('❔ How it works', 'help'), btn('« Menu', 'menu')]] }
      : mainMenu();
    await send(chatId,
      `👋 <b>Welcome to Dexvra Trade Bot</b>\n\n` +
      `Buy and sell tokens right here in Telegram — no website, no wallet app, no extension.\n\n` +
      `<b>Get started in 3 steps</b>\n` +
      `1️⃣ <b>Add funds.</b> Tap <b>📥 Get my deposit address</b> below and send some ${core.chainOf(core.userChain(core.ensureUser(chatId))).native} to it.\n` +
      `2️⃣ <b>Pick a token.</b> Paste its contract address here — you'll get a live card with price, safety and your holdings.\n` +
      `3️⃣ <b>Trade.</b> Tap Buy or Sell. That's it.\n\n` +
      `<i>Your wallet is created and secured for you — only you can withdraw. Never share your private key with anyone.</i>\n\n` +
      (isNew ? `👇 A wallet was just created for you. Add funds to begin.` : `👇 Here's your wallet.`),
      welcomeKb);
    const w = await walletScreen(chatId); return send(chatId, w.text, w.kb);
  }
  if (text === '/wallet') { const w = await walletScreen(chatId); return send(chatId, w.text, w.kb); }
  if (text === '/chain') { const s = chainScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/portfolio' || text === '/positions') { const s = await portfolioScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/history') { const s = historyScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/snipe') { const s = snipeScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/orders') { const s = ordersScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/alerts') { const s = alertsScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/copy') { const s = copyScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/dca') { const s = dcaScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/referral' || text === '/refer') { const s = referralScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/settings') { const s = settingsScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/withdraw') { setPending(chatId, { action: 'wd_addr' }); return send(chatId, '📤 <b>Withdraw</b>\n\nPaste the wallet address you want to send your funds to.'); }
  if (text.startsWith('/send')) {
    const [, ca, to, amt] = text.split(/\s+/);
    if (!isCa(ca) || !to || !amt) return send(chatId, 'Usage: <code>/send &lt;token&gt; &lt;destination&gt; &lt;amount|max&gt;</code> — sends a held token out. Or open the token card and tap 📤 Send.');
    try { await send(chatId, '⏳ Sending…'); const r = await core.withdrawToken(chatId, ca, to, amt); return send(chatId, `✅ <b>Sent</b> ${fmt(r.amount)} $${esc(r.sym)}\nto <code>${esc(to)}</code>\n${txLink(r.chain, r.hash)}`); }
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
  return send(chatId, `🤔 I didn't recognise that.\n\nTo trade a token, paste its <b>contract address</b> here. Or tap a button below.`, mainMenu());
}

async function onCallback(q) {
  const chatId = q.message.chat.id;
  const mid = q.message.message_id;
  const data = q.data || '';
  const [k, ca, arg] = data.split(':');
  // Fire-and-forget the ack (clears the button's spinner) so the handler proceeds without
  // waiting on a Telegram round-trip — noticeably snappier taps. 'oc'/'al' answer with text.
  if (k !== 'oc' && k !== 'al') answer(q.id).catch(() => {});

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
    try { await send(chatId, '⏳ Sending…'); const r = await core.withdraw(chatId, pp.to, pp.amt, pp.chain); return send(chatId, `✅ Sent <b>${r.sentEth} ${r.native}</b>\n${txLink(pp.chain, r.hash)}`); }
    catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
  }
  if (data === 'menu') return edit(chatId, mid, menuGreeting(chatId), mainMenu());
  if (data === 'help') return edit(chatId, mid, helpText(chatId), mainMenu());
  if (data === 'wal') { const w = await walletScreen(chatId); return edit(chatId, mid, w.text, w.kb); }
  if (data === 'chain') { const s = chainScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'setch') { try { core.setChain(chatId, ca); } catch (_) {} const w = await walletScreen(chatId); return edit(chatId, mid, w.text, w.kb); }
  if (data === 'pos') { const s = await portfolioScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'hist') { const s = historyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snipe') { const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'orders') { const s = ordersScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'dcas') { const s = dcaScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'dcac') { watchers.cancelDca(chatId, ca); const s = dcaScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'ref') { const s = referralScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'set') { const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
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
    if (k === 'mon') { const p2 = await monitorPayload(chatId, tca, ch, wid); return edit(chatId, mid, p2.text, p2.kb); }
    if (k === 'monn') { startMonitor(chatId, tca, ch, wid); return answer(q.id, '📍 Monitor started'); }
    if (k === 'tok') { const c = await tokenCard(chatId, tca, ch, wid); return edit(chatId, mid, c.text, c.kb); }
    if (k === 'b') return requestBuy(chatId, tca, a, ch, wid);
    if (k === 's') return doSell(chatId, tca, Number(a), ch, wid);
    if (k === 'bx') { setPending(chatId, { action: 'buy_amt', ca: tca, chain: ch, walletId: wid }); const cn = core.chainOf(ch); return send(chatId, `💵 <b>How much do you want to spend?</b>\n\nType an amount in <b>${cn ? cn.native : 'native'}</b> (for example <code>0.05</code>) or in dollars (for example <code>$10</code>).`); }
    if (k === 'sx') { const sp = await sellMenu(chatId, tca, ch, wid); return send(chatId, sp.text, sp.kb); }
    if (k === 'sxt') { setPending(chatId, { action: 'sell_pct', ca: tca, chain: ch, walletId: wid }); return send(chatId, `✏️ <b>Custom sell amount</b>\n\nType a percentage of your holdings from <b>1</b> to <b>100</b>.\nExamples: <code>33</code> = sell a third · <code>80</code> = sell most · <code>100</code> = sell everything.`); }
    if (k === 'tp') { setPending(chatId, { action: 'tp_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, `🎯 <b>Take-profit — sell automatically when the price goes UP</b>\n\nTell me the target and the bot sells 100% of this token when it's reached:\n• A <b>price in dollars</b> — for example <code>0.0025</code>\n• Or a <b>market cap</b> — type <code>mc</code> first, for example <code>mc 1000000</code>`); }
    if (k === 'sl') { setPending(chatId, { action: 'sl_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, `🛑 <b>Stop-loss — sell automatically when the price goes DOWN</b>\n\nTell me the target and the bot sells 100% of this token to limit your loss when it's reached:\n• A <b>price in dollars</b> — for example <code>0.0008</code>\n• Or a <b>market cap</b> — type <code>mc</code> first, for example <code>mc 250000</code>`); }
    if (k === 'trl') { setPending(chatId, { action: 'trail_pct', ca: tca, chain: ch, walletId: wid }); return send(chatId, `📉 <b>Trailing stop</b> — send the trail <b>percent</b> (1–99), e.g. <code>20</code>.\n\n<i>The bot tracks the peak price from now and sells 100% if it falls that % below the peak. A rising price only ratchets the peak up.</i>`); }
    if (k === 'lb') { setPending(chatId, { action: 'lb_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, `Limit buy: send <b>&lt;usd_price&gt; &lt;amount&gt;</b> (e.g. <code>0.002 0.05</code>) — buy when price drops to that:`); }
    if (k === 'alt') { setPending(chatId, { action: 'alert_price', ca: tca, chain: ch }); return send(chatId, `🔔 Alert: send the target <b>USD price</b> — I'll ping you when <code>${short(tca)}</code> crosses it:`); }
    if (k === 'wt') { setPending(chatId, { action: 'wtok_addr', ca: tca, chain: ch, walletId: wid }); const cn = core.chainOf(ch) || {}; return send(chatId, `📤 <b>Send token</b> <code>${short(tca)}</code> out of the bot\n\nPaste the <b>destination ${core.chains.isSvm(ch) ? 'Solana (base58)' : (cn.native || '') + ' (0x)'} address</b> to send to:`); }
    if (k === 'dca') { setPending(chatId, { action: 'dca_new', ca: tca, chain: ch, walletId: wid }); const cn = core.chainOf(ch) || {}; return send(chatId, `🔁 <b>DCA (scheduled buys)</b> for <code>${short(tca)}</code>\n\nSend <b>&lt;amount&gt; &lt;every_minutes&gt; &lt;rounds&gt;</b> in ${cn.native || ''}, e.g.\n<code>0.05 60 10</code> → buy 0.05 every 60 min, 10 times.\n\n<i>Runs on this wallet; each round is a normal buy (fee applies). Cancel anytime in 🔁 DCA.</i>`); }
  }
  if (k === 'wtokok') {
    const pp = pending.get(chatId);
    if (!pp || pp.action !== 'wtok_confirm' || Date.now() - (pp.ts || 0) > PENDING_TTL) return send(chatId, 'That confirmation expired — start again from the token card.');
    pending.delete(chatId);
    try { await send(chatId, '⏳ Sending…'); const r = await core.withdrawToken(chatId, pp.ca, pp.to, pp.amt, pp.chain, pp.walletId); return send(chatId, `✅ <b>Sent</b> ${fmt(r.amount)} $${esc(r.sym)}\nto <code>${esc(pp.to)}</code>\n${txLink(pp.chain, r.hash)}`); }
    catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
  }
  if (k === 'wtokcancel') { const pp = pending.get(chatId); if (pp && (pp.action || '').startsWith('wtok')) pending.delete(chatId); return edit(chatId, mid, 'Send cancelled.', mainMenu()); }
  if (data === 'alerts') { const s = alertsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'al') { const okc = watchers.cancelAlert(chatId, ca); await answer(q.id, okc ? 'Cancelled' : 'Not found'); const s = alertsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'copy') { const s = copyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
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
      const usdVal = Number(raw.replace(/^mc\s*/i, ''));
      if (!(usdVal > 0)) return send(chatId, `Send a positive ${isMcap ? 'market cap' : 'USD price'} (or prefix with <code>mc</code> for a market-cap target).`);
      const meta = await core.tokenMeta(p.ca, ch.key);
      const type = p.action === 'tp_price' ? 'tp' : 'sl';
      // Store the target in native units of the chosen metric (price or mcap).
      const order = { type, ca: p.ca, sym: meta.sym, chain: ch.key, targetPriceEth: usdVal / nativeUsd(ch.native), sellPct: 100 };
      if (isMcap) order.metric = 'mcap';
      watchers.addOrder(chatId, order, p.walletId);
      return send(chatId, `✅ ${type === 'tp' ? 'Take-profit' : 'Stop-loss'} set for $${esc(meta.sym)} at ${isMcap ? 'market cap $' + fmt(usdVal) : '$' + usdVal} on ${ch.emoji} ${esc(ch.name)}.`, rows([btn('📋 Orders', 'orders')]));
    }
    if (p.action === 'lb_price') {
      const [pxStr, amtStr] = t.split(/\s+/); const usdPrice = Number(pxStr), amount = Number(amtStr);
      if (!(usdPrice > 0) || !(amount > 0)) return send(chatId, 'Format: <code>&lt;usd_price&gt; &lt;amount&gt;</code>');
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId); if (!(nativeUsd(ch.native) > 0)) return send(chatId, 'Price feed unavailable — try again shortly.');
      const meta = await core.tokenMeta(p.ca, ch.key);
      watchers.addOrder(chatId, { type: 'limitbuy', ca: p.ca, sym: meta.sym, chain: ch.key, targetPriceEth: usdPrice / nativeUsd(ch.native), ethAmount: String(amount) }, p.walletId);
      return send(chatId, `✅ Limit buy set: ${amount} ${ch.native} of $${esc(meta.sym)} when price ≤ $${usdPrice}.`, rows([btn('📋 Orders', 'orders')]));
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
        return send(chatId, `✅ <b>Trailing stop set</b> · −${pct}% from the peak on $${esc(meta.sym)}.\n<i>Sells 100% when the price falls ${pct}% below its highest point after now.</i>`, rows([btn('📋 Orders', 'orders')]));
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
      const usdPrice = Number(t); if (!(usdPrice > 0)) return send(chatId, 'Send a positive USD price.');
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
const _monitors = new Map();   // `${chatId}:${msgId}` → interval timer
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
  const L = [`🔻 <b>Sell $${esc(sym)}</b>`, `${ch.emoji} ${esc(ch.name)} · 💳 ${esc(core.walletLabel(w, wi))}`, ''];
  if (balNow > 1e-9) {
    L.push(`🎒 You hold: <b>${fmt(balNow)} $${esc(sym)}</b>${px > 0 ? ` · ${usd(val, nat)}` : ''}`);
    L.push('');
    L.push('<b>How much do you want to sell?</b>');
    L.push(`• 25% = ${fmt(balNow * 0.25)} $${esc(sym)}${worth(25)}`);
    L.push(`• 50% = ${fmt(balNow * 0.50)} $${esc(sym)}${worth(50)}`);
    L.push(`• 75% = ${fmt(balNow * 0.75)} $${esc(sym)}${worth(75)}`);
    L.push(`• 100% = everything${worth(100)}`);
    L.push('');
    L.push('<i>Tap a preset below, or ✏️ Custom % to type any amount from 1 to 100.</i>');
  } else {
    L.push(`<i>This wallet holds no $${esc(sym)} to sell right now.</i>`);
  }
  const kb = { inline_keyboard: balNow > 1e-9 ? [
    [btn('Sell 10%', `s:${chainKey}:${wi}:${ca}:10`), btn('Sell 25%', `s:${chainKey}:${wi}:${ca}:25`), btn('Sell 33%', `s:${chainKey}:${wi}:${ca}:33`)],
    [btn('Sell 50%', `s:${chainKey}:${wi}:${ca}:50`), btn('Sell 75%', `s:${chainKey}:${wi}:${ca}:75`), btn('Sell 90%', `s:${chainKey}:${wi}:${ca}:90`)],
    [btn('💯 Sell 100% (all)', `s:${chainKey}:${wi}:${ca}:100`)],
    [btn('✏️ Custom %', `sxt:${chainKey}:${wi}:${ca}`)],
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
  const pos = w && (w.positions || {})[core.posKey(chainKey, ca)];
  const snap = await withTmo(core.tokenSnapshot(ca, chainKey).catch(() => null), 6000, null);
  const nat = ch.native; const usdRate = nativeUsd(nat);
  const inUsd = (v) => (usdRate > 0 ? ` ($${(v * usdRate).toFixed(2)})` : '');
  const sym = (pos && pos.sym) || (snap && snap.sym) || '?';
  let closed = false;
  const L = [`📍 <b>Live position — $${esc(sym)}</b>\n${ch.emoji} ${esc(ch.name)} · 💳 ${esc(core.walletLabel(w, wi))}\n`];
  // Read the LIVE on-chain balance (not pos.tokens) so tokens sent out via 📤
  // Send don't leave the Monitor showing a phantom bag with fake PnL.
  let balNow = 0;
  try { const raw = await withTmo(core.tokenBalance(ca, wAddr(w, chainKey), chainKey).catch(() => null), 5000, null); if (raw != null) balNow = Number(ethers.formatUnits(raw, (pos && pos.dec) || 18)); else if (pos && pos.tokens != null) balNow = Number(ethers.formatUnits(BigInt(pos.tokens), pos.dec || 18)); } catch (_) {}
  const cost = posCost(pos);
  if (!pos || !(cost > 0) || !(balNow > 0)) {
    closed = true;
    L.push('<i>No open position right now — you have sold it, or have not bought yet.</i>');
  } else {
    const px = snap && snap.priceEth > 0 ? snap.priceEth : 0;
    const val = balNow * px;
    L.push(`🎒 <b>You hold:</b> ${fmt(balNow)} $${esc(sym)}`);
    L.push(`💵 <b>Invested:</b> ${cost.toFixed(5)} ${nat}${inUsd(cost)}`);
    L.push(`💰 <b>Now worth:</b> ${px > 0 ? val.toFixed(5) + ' ' + nat + inUsd(val) : '—'}`);
    if (px > 0 && cost > 0) {
      const unreal = val - cost; const pct = (unreal / cost) * 100;
      L.push(`${unreal >= 0 ? '🟢' : '🔴'} <b>Profit/Loss:</b> ${unreal >= 0 ? '+' : ''}${pct.toFixed(2)}% (${unreal >= 0 ? '+' : ''}${unreal.toFixed(5)} ${nat}${usdRate > 0 ? ', ' + (unreal >= 0 ? '+' : '') + '$' + (unreal * usdRate).toFixed(2) : ''})`);
    }
  }
  if (snap) {
    const pxUsd = (snap.priceEth || 0) * usdRate;
    const mcUsd = snap.mcapUsd || ((snap.mcapEth || 0) * usdRate);
    L.push(`\n📈 <b>Price:</b> ${pxUsd > 0 ? '$' + pxUsd.toPrecision(3) : '—'}  ·  <b>Market cap:</b> ${mcUsd > 0 ? '$' + fmt(mcUsd) : '—'}`);
  }
  L.push(`<i>🔄 Updates automatically · last updated ${new Date().toISOString().slice(11, 16)} UTC</i>`);
  // Quick-sell straight from the live tracker: 25 / 50 / 75 / 100, plus "other %"
  // for anything in between. Sell buttons only appear while a bag is open.
  const kbRows = [[btn('🔄 Refresh', `mon:${chainKey}:${wi}:${ca}`), btn('🔎 Card', `tok:${chainKey}:${wi}:${ca}`)]];
  if (!closed) {
    kbRows.push([btn('Sell 25%', `s:${chainKey}:${wi}:${ca}:25`), btn('Sell 50%', `s:${chainKey}:${wi}:${ca}:50`), btn('Sell 75%', `s:${chainKey}:${wi}:${ca}:75`), btn('Sell 100%', `s:${chainKey}:${wi}:${ca}:100`)]);
    kbRows.push([btn('🔻 Sell other %', `sx:${chainKey}:${wi}:${ca}`), btn('✖ Stop', 'monx')]);
  } else {
    kbRows.push([btn('✖ Stop', 'monx')]);
  }
  const kb = { inline_keyboard: kbRows };
  return { text: L.join('\n'), kb, closed };
}
const _monitorByToken = new Map();   // `${chatId}:${ca}` → msgId of the live monitor for that token
function stopMonitor(chatId, mid) {
  const k = chatId + ':' + mid; const t = _monitors.get(k);
  if (t) { clearInterval(t); _monitors.delete(k); }
  for (const [tk, m] of _monitorByToken) if (m === mid) _monitorByToken.delete(tk);
}
async function startMonitor(chatId, ca, chainKey, wid) {
  try {
    // ONE live monitor per token — a repeat buy (or the 📍 button) reuses/replaces
    // the existing pinned monitor instead of spamming a new message each time.
    const tkey = chatId + ':' + String(ca).toLowerCase();
    const existing = _monitorByToken.get(tkey);
    if (existing) {
      // refresh the existing monitor in place and keep it; don't post a duplicate.
      try { const np = await monitorPayload(chatId, ca, chainKey, wid); await edit(chatId, existing, np.text, np.kb); return; } catch (_) { stopMonitor(chatId, existing); }
    }
    const p = await monitorPayload(chatId, ca, chainKey, wid);
    const r = await send(chatId, p.text, p.kb);
    const mid = r && r.ok && r.result && r.result.message_id;
    if (!mid) return;
    _monitorByToken.set(tkey, mid);
    // Pin it (silently) so it stays at the top of the chat as a live position tracker.
    tg('pinChatMessage', { chat_id: chatId, message_id: mid, disable_notification: true }).catch(() => {});
    const until = Date.now() + 30 * 60 * 1000;
    const timer = setInterval(async () => {
      if (Date.now() > until) return stopMonitor(chatId, mid);
      try {
        const np = await monitorPayload(chatId, ca, chainKey, wid);
        const er = await edit(chatId, mid, np.text, np.kb);
        if (er && er.ok === false && /not found|can't be edited/i.test(er.description || '')) return stopMonitor(chatId, mid);
        if (np.closed) { tg('unpinChatMessage', { chat_id: chatId, message_id: mid }).catch(() => {}); stopMonitor(chatId, mid); }   // position gone → unpin + freeze
      } catch (_) { stopMonitor(chatId, mid); }
    }, 45000);
    _monitors.set(chatId + ':' + mid, timer);
  } catch (_) {}
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
  return `📊 <b>Bot stats</b>\n👥 Total users: <b>${totalUsers}</b>\n\n` +
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
// BACKUP_TG_HOURS (default 6) — off-box without rclone/SSH. Ciphertext only;
// WALLET_SECRET is never included, so the channel alone can't decrypt anything.
const backupChannel = () => String(process.env.BACKUP_TG_CHANNEL ?? process.env.REPORT_CHANNEL_ID ?? '-1003885406672').trim();
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
    // Announce the fee treasury to the channel at boot so the operator always
    // knows (and can verify on-chain) which wallet the 1% fee is collected to.
    const evmT = core.CFG.feeWallet, solT = core.CFG.solFeeWallet;
    report.post(`🟢 <b>Dexvra Trade Bot online</b> — @${BOT_USERNAME || '?'}\n💰 <b>Fee treasury (1% per trade)</b>` +
      (evmT ? `\n  EVM: <code>${esc(evmT)}</code>` : '') +
      (solT ? `\n  SOL: <code>${esc(solT)}</code>` : '') +
      `\n\n<i>Every trade sends its fee here. Cross-check the balance against the daily report.</i>`).catch(() => {});
  }
  // Off-site store backup to a private Telegram channel (see tgBackupOnce).
  if (backupChannel()) {
    const hours = Math.max(1, Number(process.env.BACKUP_TG_HOURS || 6));
    tgBackupOnce();   // one at boot so a fresh deploy is covered immediately
    setInterval(tgBackupOnce, hours * 3600 * 1000);
    console.log(`telegram store backup ENABLED → channel every ${hours}h`);
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

module.exports = { start, _test: { walletScreen, walletsScreen, depositScreen, settingsScreen, notifyScreen, securityScreen, ordersScreen, dcaScreen, portfolioScreen, helpText, statsText, walletPickScreen, tradeTargets, tokenCard, sellMenu, monitorPayload, gasScreen, copyScreen, snipeScreen, quickSym, walletLabelFor, PRICES, isCa, fmtNat, wAddr, isAddrFor, _placeAutoExit, parseAmt } };
if (require.main === module) start();
