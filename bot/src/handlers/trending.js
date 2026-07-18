// Trending flow: book a time-boxed featured slot on an ALREADY-LISTED token.
// User sends the CA / token link → we resolve the listing (chain comes from the
// coin) → pick a duration → pay.
const { answer, toast, sendCard } = require("../helpers/message");
const { nativeOf, chainOf } = require("../config/chains");
const { trendingForChain, durationToHours } = require("../config/packages");
const { escapeHtml } = require("../helpers/format");
const { startPayment } = require("./pay");
const api = require("../api/dexvra");
const menu = require("./menu");
const { Markup } = menu;
const tpl = require("../templates");

function freshSession(ctx, patch) {
  const prev = ctx.session && ctx.session.latest_bot_message;
  ctx.session = { latest_bot_message: prev, ...patch };
}

async function entryTrending(ctx) {
  await answer(ctx);
  if (ctx.chat && ctx.chat.type !== "private") return;
  freshSession(ctx, { type: "trend", awaitingField: "trend_ca" });
  await sendCard(ctx, tpl.t("trending_ca_prompt"), menu.withHome([]));
}

async function handleText(ctx) {
  const s = ctx.session;
  if (s.awaitingField !== "trend_ca") return;
  const input = (ctx.message.text || "").trim();

  let chain = null;
  let address = input;
  const m = input.match(/\/token\/([a-z0-9]+)\/([^/\s?]+)/i);
  if (m) {
    chain = m[1].toLowerCase();
    address = m[2];
  }

  let listing = null;
  try {
    const all = await api.getListings();
    listing = all.find(
      (r) =>
        (!chain || r.chain === chain) &&
        String(r.address).toLowerCase() === String(address).toLowerCase() &&
        r.status === "approved",
    );
  } catch (e) {
    return toast(ctx, "Couldn't reach the listings service — try again shortly.");
  }

  if (!listing) {
    return sendCard(
      ctx,
      tpl.t("trending_not_found"),
      Markup.inlineKeyboard([
        [Markup.button.callback("⚡ Xpress Listing", "submit_coin")],
        [Markup.button.callback("🏠 Home", "home")],
      ]),
    );
  }

  s.coin = {
    chain: listing.chain,
    address: listing.address,
    sym: listing.sym,
    name: listing.name,
    website: listing.website,
    twitter: listing.twitter,
    telegram: listing.telegram,
    logoUrl: listing.logoUrl,
  };
  s.awaitingField = null;
  return showDurations(ctx);
}

async function showDurations(ctx) {
  const coin = ctx.session.coin;
  const native = nativeOf(coin.chain);
  const rows = trendingForChain(coin.chain);
  const kb = rows.map((r, i) => [
    Markup.button.callback(
      `${r.duration} · ${r.price} ${native}${r.discount ? ` (-${r.discount}%)` : ""}`,
      `td_${i}`,
    ),
  ]);
  await sendCard(
    ctx,
    `🔥 <b>Trending for $${escapeHtml(coin.sym.replace(/^\$/, ""))}</b> on ${escapeHtml(chainOf(coin.chain).label)}\n\nPick a duration:`,
    menu.withHome(kb),
  );
}

async function durationPick(ctx) {
  await answer(ctx);
  const coin = ctx.session && ctx.session.coin;
  if (!coin) return toast(ctx, "Session expired — send /start and try again.");
  const i = Number(ctx.match[1]);
  const rows = trendingForChain(coin.chain);
  const row = rows[i];
  if (!row) return toast(ctx, "Invalid duration.");
  const hours = durationToHours(row.duration);
  await startPayment(ctx, {
    kind: "trending",
    chain: coin.chain,
    native: nativeOf(coin.chain),
    humanAmount: row.price,
    label: `Trending ${row.duration} — $${coin.sym.replace(/^\$/, "")}`,
    payload: { chain: coin.chain, address: coin.address, hours, symbol: coin.sym, name: coin.name },
  });
}

module.exports = { entryTrending, durationPick, handleText };
