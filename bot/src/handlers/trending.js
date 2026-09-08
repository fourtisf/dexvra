// Trending flow: book a time-boxed featured slot on an ALREADY-LISTED token.
// User sends the CA / token link → we resolve the listing (chain comes from the
// coin) → pick a duration → pay.
const { answer, toast, sendCard } = require("../helpers/message");
const { chainOf, payChainOf, payNativeOf } = require("../config/chains");
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
  await sendCard(ctx, tpl.render("trending_ca_prompt"), menu.withHome([]));
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
    return toast(ctx, tpl.render("trending_service_down"));
  }

  if (!listing) {
    return sendCard(
      ctx,
      tpl.render("trending_not_found"),
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
  const native = payNativeOf(coin.chain);
  const rows = trendingForChain(coin.chain);
  const kb = rows.map((r, i) => [
    Markup.button.callback(
      `${r.duration} · ${r.price} ${native}${r.discount ? ` (-${r.discount}%)` : ""}`,
      `td_${i}`,
    ),
  ]);
  await sendCard(
    ctx,
    tpl.render("trending_durations", {
      symbol: `$${coin.sym.replace(/^\$/, "")}`,
      chain: chainOf(coin.chain).label,
      native,
    }),
    menu.withHome(kb),
  );
}

async function durationPick(ctx) {
  await answer(ctx);
  const coin = ctx.session && ctx.session.coin;
  if (!coin) return toast(ctx, tpl.render("session_expired"));
  const i = Number(ctx.match[1]);
  const rows = trendingForChain(coin.chain);
  const row = rows[i];
  if (!row) return toast(ctx, "Invalid duration.");
  const hours = durationToHours(row.duration);
  await startPayment(ctx, {
    kind: "trending",
    chain: payChainOf(coin.chain),
    native: payNativeOf(coin.chain),
    humanAmount: row.price,
    label: `Trending ${row.duration} — $${coin.sym.replace(/^\$/, "")}`,
    payload: { chain: coin.chain, address: coin.address, hours, symbol: coin.sym, name: coin.name },
  });
}

// Extend button from the slot-expiry upsell DM: `xtd_{ref}_{DURATION}`.
// Straight into the trending pay flow at the discounted renewal price.
async function extendPick(ctx) {
  await answer(ctx);
  const upsell = require("../services/trendingUpsell");
  const ref = ctx.match[1];
  const duration = ctx.match[2];
  const offer = upsell.getOffer(ref);
  if (!offer) return toast(ctx, tpl.render("session_expired"));
  const renew = upsell.renewOffer(offer.chain, duration);
  if (!renew) return toast(ctx, "That duration isn't available for this chain.");
  await startPayment(ctx, {
    kind: "trending",
    chain: payChainOf(offer.chain),
    native: payNativeOf(offer.chain),
    humanAmount: renew.price,
    label: `Trending renewal ${duration} — $${String(offer.sym || "").replace(/^\$/, "")}`,
    payload: { chain: offer.chain, address: offer.address, hours: renew.hours, symbol: offer.sym, name: offer.name },
  });
}

module.exports = { entryTrending, durationPick, handleText, extendPick };
