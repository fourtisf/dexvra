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

// chatId → the outstanding "paste your contract address" prompt: the message it
// is waiting on a reply to, and who asked for it. In memory only — a prompt
// nobody answered before a restart is re-opened by running /settoken again,
// which is one tap, and persisting it would mean a stale prompt swallowing an
// unrelated reply days later.
const pendingToken = new Map();

/**
 * Ask for the contract address with force_reply, so the group member's keyboard
 * opens already pointed at this prompt.
 *
 * selective + a reply to their own command aims the forced reply at the admin
 * who ran it. Without that, every member of the group gets an input box shoved
 * in front of them by a setting that is not theirs to change.
 */
async function promptForToken(ctx, replyTo) {
  const { text, extra } = payloadArgs(tpl.render("settoken_prompt"), false);
  const sent = await ctx
    .reply(text, {
      ...extra,
      disable_web_page_preview: true,
      reply_to_message_id: replyTo,
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: "Contract address" },
    })
    .catch(() => null);
  if (sent) pendingToken.set(String(ctx.chat.id), { messageId: sent.message_id, userId: ctx.from.id });
}

/**
 * A reply to the force_reply prompt above IS the contract address.
 *
 * Middleware, so anything that is not that reply falls through untouched: this
 * sits in front of the private-chat text router and sees every message in every
 * group the bot is in.
 */
async function groupTokenReply(ctx, next) {
  if (!isGroup(ctx)) return next();
  const replyTo = ctx.message && ctx.message.reply_to_message;
  const pending = pendingToken.get(String(ctx.chat.id));
  if (!replyTo || !pending || replyTo.message_id !== pending.messageId) return next();
  // Whoever opened the prompt answers it. A different member replying to the
  // same message is just chat, and was never admin-checked.
  if (!ctx.from || ctx.from.id !== pending.userId) return next();
  pendingToken.delete(String(ctx.chat.id));
  const address = String((ctx.message.text || "").trim().split(/\s+/)[0] || "");
  if (!address) return say(ctx, "settoken_not_found");
  return applyToken(ctx, address);
}

async function settoken(ctx) {
  if (!isGroup(ctx)) return say(ctx, "setup_group_only");
  if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
  const address = arg(ctx);
  // A bare /settoken — the version Telegram's command menu sends — asks for the
  // address instead of printing syntax. One tap, then paste.
  if (!address) return promptForToken(ctx, ctx.message && ctx.message.message_id);
  return applyToken(ctx, address);
}

async function applyToken(ctx, address) {
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
 * Every button in this file guards the same way.
 *
 * The panels live in a GROUP chat, where any member can reach the buttons long
 * after an admin opened them. The check on the command only covers who opened
 * it, so it has to be repeated on each tap.
 */
async function tapAllowed(ctx) {
  if (!isGroup(ctx)) {
    await ctx.answerCbQuery().catch(() => {});
    return false;
  }
  if (!(await isGroupAdmin(ctx))) {
    await ctx.answerCbQuery(tpl.t("setup_admin_only"), { show_alert: true }).catch(() => {});
    return false;
  }
  return true;
}

/** Re-render a panel over the message that was tapped. Re-tapping the active
 *  preset edits a message to its own contents, which Telegram answers with
 *  "message is not modified" — nothing to do, and the toast already confirmed
 *  the value, so the failure is swallowed on purpose. */
const repaint = (ctx, panel) => ctx.editMessageText(panel.text, panel.extra).catch(() => {});

/**
 * A preset tapped on the /setminbuy picker.
 *
 * Refreshes the panel in place rather than replying, so a second adjustment is
 * another single tap on the same message instead of a new card each time.
 */
async function minBuyPick(ctx) {
  if (!(await tapAllowed(ctx))) return;
  const usd = Math.max(Number((ctx.match && ctx.match[1]) || 0), cfg.MIN_BUY_FLOOR_USD);
  await cfg.upsert(ctx.chat.id, { minBuyUsd: usd });
  await ctx.answerCbQuery(tpl.t("setminbuy_toast", { usd: usd$(usd) })).catch(() => {});
  await repaint(ctx, minBuyPanel(ctx.chat.id));
}

// Whale bars, for the picker behind 🐋 Whale bar. Coarser than the buy floor
// because it measures a BAG, not a trade: the gap between a $10k holder and a
// $50k holder is a different kind of holder, not a rounder number.
const WHALE_PRESETS = [10000, 25000, 50000, 100000, 250000];

function whaleKeyboard(g) {
  const on = g.whales !== false;
  const current = on ? Number(g.whaleWalletUsd || whaleCfg.get().walletUsd) : null;
  const btn = (n) => Markup.button.callback(usd$(n) + (current === n ? " ✓" : ""), `wb_${n}`);
  const rows = [];
  for (let i = 0; i < WHALE_PRESETS.length; i += 3) rows.push(WHALE_PRESETS.slice(i, i + 3).map(btn));
  rows.push([Markup.button.callback(on ? "🚫 Turn off" : "🚫 Off ✓", "wb_off")]);
  return Markup.inlineKeyboard(rows);
}

function whalePanel(chatId) {
  const g = cfg.get(chatId) || {};
  const on = g.whales !== false;
  const label = chainOf(g.chain)?.label || "this network";
  const { text, extra } = payloadArgs(
    tpl.render("setwhale_panel", {
      usd: on ? usd$(g.whaleWalletUsd || whaleCfg.get().walletUsd) : tpl.t("setwhale_state_off"),
      chain: label,
      // Same caveat the /setwhale confirmation carries, spliced in as raw markup
      // so the **bold** chain name survives. A group on a chain whose balances
      // cannot be read must not be shown a bar that will never fire.
      unsupported: holdings.supports(g.chain) ? "" : tpl.markup("setwhale_unsupported", { chain: label }),
    }),
    false,
  );
  return { text, extra: { ...extra, disable_web_page_preview: true, ...whaleKeyboard(g) } };
}

async function whalePick(ctx) {
  if (!(await tapAllowed(ctx))) return;
  const raw = (ctx.match && ctx.match[1]) || "off";
  if (raw === "off") {
    await cfg.upsert(ctx.chat.id, { whales: false });
    await ctx.answerCbQuery(tpl.t("setwhale_off")).catch(() => {});
  } else {
    await cfg.upsert(ctx.chat.id, { whales: true, whaleWalletUsd: Number(raw) });
    await ctx.answerCbQuery(tpl.t("setwhale_toast", { usd: usd$(Number(raw)) })).catch(() => {});
  }
  await repaint(ctx, whalePanel(ctx.chat.id));
}

/** `/setwhale 50000` — the holding that makes a buyer a whale here, or `off`. */
async function setwhale(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
  const raw = arg(ctx).toLowerCase();
  // Bare /setwhale opens the picker, same as /setminbuy — the command menu
  // sends it with no argument, and a syntax note is a worse answer than a row
  // of bars to tap.
  if (!raw) {
    const p = whalePanel(ctx.chat.id);
    return ctx.reply(p.text, p.extra).catch(() => {});
  }
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
  const p = statusPanel(ctx.chat.id);
  await ctx.reply(p.text, p.extra).catch(() => {});
}

/**
 * /buybot with no argument: the settings hub.
 *
 * It was a read-only status card, which meant a project could SEE every setting
 * and change none of them — each one was a separate command they had to know
 * the name and the argument shape of. Same card, now with a button per row of
 * it, so setting the bot up never requires typing anything but the contract
 * address.
 */
function settingsKeyboard(g) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📄 Token", "bs_token"), Markup.button.callback("💲 Min buy", "bs_minbuy")],
    [
      Markup.button.callback("🐋 Whale bar", "bs_whale"),
      Markup.button.callback(g.pin === false ? "📌 Pin: off" : "📌 Pin: on", "bs_pin"),
    ],
    [Markup.button.callback(g.on ? "🔴 Turn the buy bot off" : "🟢 Turn the buy bot on", "bs_power")],
  ]);
}

function statusPanel(chatId) {
  const g = cfg.get(chatId);
  // Nothing set up yet — the only button that means anything is the one that
  // starts it. Offering "min buy" on a group with no token is a dead end.
  if (!g || !g.address) {
    const { text, extra } = payloadArgs(tpl.render("buybot_need_token"), false);
    const kb = Markup.inlineKeyboard([[Markup.button.callback("📄 Set token", "bs_token")]]);
    return { text, extra: { ...extra, disable_web_page_preview: true, ...kb } };
  }
  const { text, extra } = payloadArgs(
    tpl.render("buybot_status", {
      address: g.address,
      chain: chainOf(g.chain)?.label || g.chain,
      pool: g.pairAddress ? "resolved ✓" : "—",
      minBuy: usd$(cfg.minBuyOf(g)),
      // The GLOBAL bar is read live, so a group that never ran /setwhale sees
      // whatever the operator currently has set — not the value baked into .env
      // at boot, which is what this line used to print.
      whale:
        g.whales === false
          ? tpl.t("setwhale_state_off")
          : usd$(g.whaleWalletUsd || whaleCfg.get().walletUsd) +
            (holdings.supports(g.chain) ? "" : " (not readable on this network)"),
      pin: g.pin === false ? "off" : "on",
      state: g.on ? "🟢 ON" : "🔴 OFF",
    }),
    false,
  );
  return { text, extra: { ...extra, disable_web_page_preview: true, ...settingsKeyboard(g) } };
}

/** A button on the settings hub. The two toggles repaint the hub in place; the
 *  two pickers open their own panel underneath it, so the hub stays put as the
 *  thing you come back to. */
async function settingsTap(ctx) {
  if (!(await tapAllowed(ctx))) return;
  const what = (ctx.match && ctx.match[1]) || "";
  const g = cfg.get(ctx.chat.id) || {};
  if (what === "token") {
    await ctx.answerCbQuery().catch(() => {});
    const msg = ctx.callbackQuery && ctx.callbackQuery.message;
    return promptForToken(ctx, msg && msg.message_id);
  }
  if (what === "minbuy") {
    await ctx.answerCbQuery().catch(() => {});
    const p = minBuyPanel(ctx.chat.id);
    return void ctx.reply(p.text, p.extra).catch(() => {});
  }
  if (what === "whale") {
    await ctx.answerCbQuery().catch(() => {});
    const p = whalePanel(ctx.chat.id);
    return void ctx.reply(p.text, p.extra).catch(() => {});
  }
  if (what === "pin") {
    const on = g.pin === false;
    await cfg.upsert(ctx.chat.id, { pin: on });
    await ctx.answerCbQuery(tpl.t(on ? "pin_on" : "pin_off")).catch(() => {});
  }
  if (what === "power") {
    // Turning the bot ON without a token would report success and then call
    // nothing at all, forever.
    if (!g.address) {
      await ctx.answerCbQuery(tpl.t("buybot_need_token"), { show_alert: true }).catch(() => {});
      return;
    }
    const on = !g.on;
    await cfg.upsert(ctx.chat.id, { on });
    await ctx.answerCbQuery(tpl.t(on ? "buybot_on" : "buybot_off")).catch(() => {});
  }
  await repaint(ctx, statusPanel(ctx.chat.id));
}

module.exports = {
  settoken,
  groupTokenReply,
  setchain,
  setminbuy,
  minBuyPick,
  setwhale,
  whalePick,
  buybot,
  settingsTap,
  setPin,
  resolveToken,
  candidateChains,
  MIN_BUY_PRESETS,
  WHALE_PRESETS,
};
