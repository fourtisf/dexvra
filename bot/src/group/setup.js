// Group buy-bot setup commands (run inside a project's group chat, by a group
// admin): /settoken, /setchain, /setminbuy, /buybot on|off, /buybot (status).
// A project adds @dexvrabot to their group and points it at their token.
const cfg = require("./config");
const gt = require("./gtPairs");
const { CHAIN_IDS, chainOf } = require("../config/chains");
const log = require("../helpers/logger");

const HTML = { parse_mode: "HTML" };

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

async function settoken(ctx) {
  if (!isGroup(ctx)) return ctx.reply("Add me to your project's group, then run /settoken there.").catch(() => {});
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Only a group admin can set the token.").catch(() => {});
  const address = arg(ctx);
  if (!address) return ctx.reply("Usage: <code>/settoken &lt;contract address&gt;</code>", HTML).catch(() => {});
  await ctx.reply("🔎 Resolving your token…").catch(() => {});
  const res = await resolveToken(address);
  if (!res) {
    return ctx
      .reply("Couldn't find a live pool for that address. Double-check it, or set the chain first with <code>/setchain &lt;chain&gt;</code> then <code>/settoken</code>.", HTML)
      .catch(() => {});
  }
  await cfg.upsert(ctx.chat.id, {
    chain: res.chain,
    address,
    pairAddress: res.pool.poolAddress,
    on: true,
  });
  const label = chainOf(res.chain).label;
  await ctx
    .reply(
      `✅ <b>Buy bot armed</b> on <b>${label}</b>.\nEvery buy of your token now posts here. Tune it with <code>/setminbuy &lt;usd&gt;</code>, pause with <code>/buybot off</code>.`,
      HTML,
    )
    .catch(() => {});
  log.info(`[group] ${ctx.chat.id} set token ${res.chain}/${address} pool ${res.pool.poolAddress}`);
}

async function setchain(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Only a group admin can change the chain.").catch(() => {});
  const chain = arg(ctx).toLowerCase();
  if (!CHAIN_IDS.includes(chain)) {
    return ctx.reply(`Unknown chain. One of: <code>${CHAIN_IDS.join(", ")}</code>`, HTML).catch(() => {});
  }
  const g = cfg.get(ctx.chat.id);
  if (!g || !g.address) return ctx.reply("Set the token first: <code>/settoken &lt;CA&gt;</code>", HTML).catch(() => {});
  // re-resolve the pool on the NEW chain (used to leave a stale wrong-chain pair)
  const pool = await gt.fetchPool(chain, g.address).catch(() => null);
  await cfg.upsert(ctx.chat.id, { chain, pairAddress: pool ? pool.poolAddress : null });
  await ctx
    .reply(
      pool
        ? `✅ Chain set to <b>${chainOf(chain).label}</b> and pool re-resolved.`
        : `⚠️ Chain set to <b>${chainOf(chain).label}</b>, but no pool found yet — I'll keep trying each cycle.`,
      HTML,
    )
    .catch(() => {});
}

async function setminbuy(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isGroupAdmin(ctx))) return;
  const usd = Number(arg(ctx));
  if (!Number.isFinite(usd) || usd < 0) return ctx.reply("Usage: <code>/setminbuy 50</code>", HTML).catch(() => {});
  await cfg.upsert(ctx.chat.id, { minBuyUsd: usd });
  await ctx.reply(`✅ Minimum buy to alert: <b>$${usd}</b>.`, HTML).catch(() => {});
}

async function buybot(ctx) {
  if (!isGroup(ctx)) return;
  const a = arg(ctx).toLowerCase();
  const g = cfg.get(ctx.chat.id);
  if (a === "on" || a === "off") {
    if (!(await isGroupAdmin(ctx))) return ctx.reply("Only a group admin can toggle the buy bot.").catch(() => {});
    if (!g || !g.address) return ctx.reply("Set the token first: <code>/settoken &lt;CA&gt;</code>", HTML).catch(() => {});
    await cfg.upsert(ctx.chat.id, { on: a === "on" });
    return ctx.reply(a === "on" ? "🟢 Buy bot ON." : "🔴 Buy bot OFF.", HTML).catch(() => {});
  }
  // status
  if (!g || !g.address) {
    return ctx.reply("Buy bot isn't set up here yet. Run <code>/settoken &lt;CA&gt;</code>.", HTML).catch(() => {});
  }
  await ctx
    .reply(
      `📊 <b>Buy bot status</b>\n` +
        `Token: <code>${g.address}</code>\n` +
        `Chain: <b>${chainOf(g.chain)?.label || g.chain}</b>\n` +
        `Pool: ${g.pairAddress ? "resolved ✓" : "—"}\n` +
        `Min buy: <b>$${g.minBuyUsd || 0}</b>\n` +
        `State: <b>${g.on ? "🟢 ON" : "🔴 OFF"}</b>`,
      HTML,
    )
    .catch(() => {});
}

module.exports = { settoken, setchain, setminbuy, buybot, resolveToken, candidateChains };
