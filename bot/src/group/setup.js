// Group buy-bot setup commands (run inside a project's group chat, by a group
// admin): /settoken, /setchain, /setminbuy, /buybot on|off, /buybot (status).
// A project adds @dexvrabot to their group and points it at their token.
const { Markup } = require("telegraf");
const cfg = require("./config");
const gt = require("./gtPairs");
const holdings = require("./walletHoldings");
const { CHAIN_IDS, chainOf } = require("../config/chains");
const whaleCfg = require("../services/whaleConfig");
const tpl = require("../templates");
const premium = require("../premium");
const { payloadArgs } = require("../helpers/message");
const log = require("../helpers/logger");

/**
 * Reply with an admin-editable template.
 *
 * Every user-facing string in this file goes through here. They used to be HTML
 * literals, which meant the copy a paying project reads while wiring the bot up
 * — the whole first-run experience — was the one part of the bot an operator
 * could not touch without a deploy.
 *
 * Always .catch(): a group that removed the bot mid-command must not throw.
 */
function say(ctx, key, vars) {
  const { text, extra } = payloadArgs(tpl.render(key, vars), false);
  return ctx.reply(text, { ...extra, disable_web_page_preview: true }).catch(() => {});
}

// Only a group admin/creator may configure the buy bot.
async function isGroupAdmin(ctx) {
  try {
    if (ctx.chat.type === "private") return true; // solo testing
    const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return m && (m.status === "administrator" || m.status === "creator");
  } catch {
    return false;
  }
}

const isGroup = (ctx) => ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup");
const arg = (ctx) => (ctx.message.text || "").split(/\s+/).slice(1).join(" ").trim();

// Candidate chains to probe for a pasted address, by shape. Ordered so the most
// likely wins first; the FIRST chain with a live pool is chosen.
function candidateChains(address) {
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return ["ethereum", "bsc", "base", "robinhood", "plasma"];
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return ["tron"];
  if (/^(EQ|UQ|0:)/.test(address)) return ["ton"];
  if (/^0x[a-fA-F0-9]+::/.test(address)) return ["sui"];
  return ["solana"]; // base58 mint
}

/** Probe candidate chains for a live pool; return {chain, pool} or null. */
async function resolveToken(address) {
  for (const chain of candidateChains(address)) {
    const pool = await gt.fetchPool(chain, address).catch(() => null);
    if (pool && pool.poolAddress) return { chain, pool };
  }
  return null;
}

const usd$ = (n) => "$" + Number(n).toLocaleString("en-US");

async function settoken(ctx) {
  if (!isGroup(ctx)) return say(ctx, "setup_group_only");
  if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
  const address = arg(ctx);
  if (!address) return say(ctx, "settoken_usage");
  await say(ctx, "settoken_resolving");
  const res = await resolveToken(address);
  if (!res) return say(ctx, "settoken_not_found");
  // One extra lookup, once, for the token's NAME — the pool listing only knows
  // the PAIR ("HOPPY / WETH"), and the name is what headlines every alert.
  const info = await gt.fetchTokenInfo(res.chain, address).catch(() => null);
  const sym = (info && info.symbol) || res.pool.symbol || "";
  const name = (info && info.name) || res.pool.name || "";
  await cfg.upsert(ctx.chat.id, {
    chain: res.chain,
    address,
    pairAddress: res.pool.poolAddress,
    // Without these every alert reads "$TOKEN" — the placeholder the renderer
    // falls back to. Nothing else in the bot ever learns a group's ticker.
    sym,
    name,
    on: true,
  });
  await say(ctx, "settoken_ok", {
    chain: chainOf(res.chain).label,
    // The token's own name and ticker come from a third-party feed, so they go
    // through the same sanitiser the alert cards use — a token literally named
    // "[click](url)" would otherwise inject a link into the group's setup reply.
    name: premium.sanitizeVar(name || "your token"),
    symbol: premium.sanitizeVar(sym ? `$${String(sym).replace(/^\$/, "")}` : ""),
    address,
  });
  log.info(`[group] ${ctx.chat.id} set token ${res.chain}/${address} pool ${res.pool.poolAddress}`);
}

async function setchain(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
  const chain = arg(ctx).toLowerCase();
  if (!CHAIN_IDS.includes(chain)) return say(ctx, "setchain_unknown", { chains: CHAIN_IDS.join(", ") });
  const g = cfg.get(ctx.chat.id);
  if (!g || !g.address) return say(ctx, "setchain_need_token");
  // re-resolve the pool on the NEW chain (used to leave a stale wrong-chain pair)
  const pool = await gt.fetchPool(chain, g.address).catch(() => null);
  await cfg.upsert(ctx.chat.id, { chain, pairAddress: pool ? pool.poolAddress : null });
  await say(ctx, pool ? "setchain_ok" : "setchain_ok_nopool", { chain: chainOf(chain).label });
}

// Preset floors for the /setminbuy picker. Round numbers a project actually
// chooses — the point is that this setting costs one tap, not a decision about
// which number to type into a command.
//
// It starts at the $10 minimum, not at "every buy": a chat of $0.40 alerts
// reads as a dead token, and the project wearing that is the one paying for the
// bot. See cfg.MIN_BUY_FLOOR_USD.
const MIN_BUY_PRESETS = [cfg.MIN_BUY_FLOOR_USD, 25, 50, 100, 250, 500, 1000, 5000];

/** The picker's keyboard, with a ✓ on whatever the group is currently set to. */
function minBuyKeyboard(current) {
  const btn = (n) => Markup.button.callback(usd$(n) + (Number(current) === n ? " ✓" : ""), `mb_${n}`);
  const rows = [];
  for (let i = 0; i < MIN_BUY_PRESETS.length; i += 3) rows.push(MIN_BUY_PRESETS.slice(i, i + 3).map(btn));
  return Markup.inlineKeyboard(rows);
}

/** Picker text + keyboard for THIS group's current floor. Built in one place so
 *  the first send and every in-place refresh after a tap cannot drift apart. */
function minBuyPanel(chatId) {
  const current = cfg.minBuyOf(cfg.get(chatId));
  const { text, extra } = payloadArgs(tpl.render("setminbuy_panel", { usd: usd$(current) }), false);
  return { text, extra: { ...extra, disable_web_page_preview: true, ...minBuyKeyboard(current) } };
}

async function setminbuy(ctx) {
  if (!isGroup(ctx)) return say(ctx, "setup_group_only");
  if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
  const raw = arg(ctx).replace(/[$,_]/g, "");
  // A bare /setminbuy opens the picker. It used to fall straight through to
  // Number("") — which is 0, and finite, and >= 0 — so tapping the command in
  // Telegram's menu silently set the floor to $0 and answered "Floor set". A
  // command with no argument is a question, not an instruction.
  if (!raw) {
    const p = minBuyPanel(ctx.chat.id);
    return ctx.reply(p.text, p.extra).catch(() => {});
  }
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) return say(ctx, "setminbuy_usage");
  // Below the floor is not an error — it is someone asking for every buy. They
  // get the floor and a line saying so, rather than a refusal to act.
  const floored = Math.max(usd, cfg.MIN_BUY_FLOOR_USD);
  await cfg.upsert(ctx.chat.id, { minBuyUsd: floored });
  await say(ctx, usd < floored ? "setminbuy_min" : "setminbuy_ok", { usd: usd$(floored) });
}

/**
 * A preset tapped on the /setminbuy picker.
 *
 * Refreshes the panel in place rather than replying, so a second adjustment is
 * another single tap on the same message instead of a new card each time.
 */
async function minBuyPick(ctx) {
  const usd = Math.max(Number((ctx.match && ctx.match[1]) || 0), cfg.MIN_BUY_FLOOR_USD);
  if (!isGroup(ctx)) return ctx.answerCbQuery().catch(() => {});
  // The picker sits in a group where anyone can tap it, so the admin check has
  // to happen HERE too — the one on /setminbuy only covers who opened it.
  if (!(await isGroupAdmin(ctx)))
    return ctx.answerCbQuery(tpl.t("setup_admin_only"), { show_alert: true }).catch(() => {});
  await cfg.upsert(ctx.chat.id, { minBuyUsd: usd });
  await ctx.answerCbQuery(tpl.t("setminbuy_toast", { usd: usd$(usd) })).catch(() => {});
  const p = minBuyPanel(ctx.chat.id);
  // Re-tapping the active preset edits a message to its own contents, which
  // Telegram answers with "message is not modified". Nothing to do about it and
  // nothing to say about it — the toast above already confirmed the value.
  await ctx.editMessageText(p.text, p.extra).catch(() => {});
}

/** `/setwhale 50000` — the holding that makes a buyer a whale here, or `off`. */
async function setwhale(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
  const raw = arg(ctx).toLowerCase();
  if (raw === "off") {
    await cfg.upsert(ctx.chat.id, { whales: false });
    return say(ctx, "setwhale_off");
  }
  const usd = Number(raw.replace(/[$,_]/g, ""));
  if (!Number.isFinite(usd) || usd <= 0) return say(ctx, "setwhale_usage");
  await cfg.upsert(ctx.chat.id, { whales: true, whaleWalletUsd: usd });
  const chain = (cfg.get(ctx.chat.id) || {}).chain;
  const label = chainOf(chain)?.label || "this network";
  // Its OWN template, spliced in as raw MARKUP (not t(), which strips it — the
  // **bold** chain name reached the group as plain text), so an operator can
  // reword or delete the caveat without touching the confirmation around it.
  const unsupported = holdings.supports(chain) ? "" : tpl.markup("setwhale_unsupported", { chain: label });
  await say(ctx, "setwhale_ok", { usd: usd$(usd), chain: label, unsupported });
}

/** `/buybot pin on|off` — whether whale alerts are pinned in this group. */
async function setPin(ctx, on) {
  await cfg.upsert(ctx.chat.id, { pin: on });
  return say(ctx, on ? "pin_on" : "pin_off");
}

async function buybot(ctx) {
  if (!isGroup(ctx)) return;
  const a = arg(ctx).toLowerCase();
  const g = cfg.get(ctx.chat.id);
  if (a === "pin on" || a === "pin off") {
    if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
    return setPin(ctx, a === "pin on");
  }
  if (a === "on" || a === "off") {
    if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
    if (!g || !g.address) return say(ctx, "buybot_need_token");
    await cfg.upsert(ctx.chat.id, { on: a === "on" });
    return say(ctx, a === "on" ? "buybot_on" : "buybot_off");
  }
  // status
  if (!g || !g.address) return say(ctx, "buybot_need_token");
  await say(ctx, "buybot_status", {
    address: g.address,
    chain: chainOf(g.chain)?.label || g.chain,
    pool: g.pairAddress ? "resolved ✓" : "—",
    minBuy: usd$(g.minBuyUsd || 0),
    // The GLOBAL bar is read live, so a group that never ran /setwhale sees
    // whatever the operator currently has set — not the value baked into .env
    // at boot, which is what this line used to print.
    whale:
      g.whales === false
        ? "off"
        : usd$(g.whaleWalletUsd || whaleCfg.get().walletUsd) + (holdings.supports(g.chain) ? "" : " (not readable on this network)"),
    pin: g.pin === false ? "off" : "on",
    state: g.on ? "🟢 ON" : "🔴 OFF",
  });
}

module.exports = {
  settoken,
  setchain,
  setminbuy,
  minBuyPick,
  setwhale,
  buybot,
  setPin,
  resolveToken,
  candidateChains,
  MIN_BUY_PRESETS,
};
