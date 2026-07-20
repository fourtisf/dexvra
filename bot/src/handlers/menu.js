// Inline keyboards + welcome copy. Callback-data grammar (dexvra's own, kept
// short so it never exceeds Telegram's 64-byte limit):
//   submit_coin | listing_trend_coin | trend_coin | ad_banner | home
//   lc_<chain>            listing chain pick
//   lt_<TIER>             listing tier pick (Listing & Trending)
//   edit_<field> | approve_listing | discard_listing
//   td_<i>               trending duration index
//   bt_<key> | bd_<i>    banner type / duration index
//   bpay_<chain>         banner pay currency
//   yn_<field>_<yes|no>  banner optional-link yes/no
//   confirm_pay
const { Markup } = require("telegraf");
const { CHAIN_ORDER, chainOf } = require("../config/chains");

const homeBtn = () => Markup.button.callback("🏠 Home", "home");

/** Wrap rows (array of button-arrays) and append a Home row. */
function withHome(rows) {
  return Markup.inlineKeyboard([...rows, [homeBtn()]]);
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⚡ Xpress Listing", "submit_coin")],
    [Markup.button.callback("🏆 Listing & Trending", "listing_trend_coin")],
    [Markup.button.callback("🔥 Trending Token", "trend_coin")],
    [Markup.button.callback("📢 Banner Ads", "ad_banner")],
    [Markup.button.callback("📣 Mass DM Broadcast", "ad_massdm")],
    [Markup.button.callback("🤖 Add Buy Bot to your group", "buybot_help")],
  ]);
}

/** Chain picker → `<prefix>_<chain>` (e.g. lc_solana). `extraRows` (array of
 *  button-rows) are appended after the chain grid, before Home — used to offer a
 *  one-tap switch to the other package. */
function chainMenu(prefix, extraRows = []) {
  const rows = [];
  for (let i = 0; i < CHAIN_ORDER.length; i += 2) {
    const row = CHAIN_ORDER.slice(i, i + 2).map((id) =>
      Markup.button.callback(chainOf(id).label, `${prefix}_${id}`),
    );
    rows.push(row);
  }
  return withHome([...rows, ...extraRows]);
}

/** One button per item → `<prefix>_<index>`; label via labelFn(item, i). */
function idxButtons(prefix, items, labelFn) {
  const rows = items.map((it, i) => [Markup.button.callback(labelFn(it, i), `${prefix}_${i}`)]);
  return withHome(rows);
}

function confirmPayment() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ I've Paid — Confirm", "confirm_pay")],
    [homeBtn()],
  ]);
}

function yesNo(field) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Yes", `yn_${field}_yes`),
      Markup.button.callback("⏭ Skip", `yn_${field}_no`),
    ],
    [homeBtn()],
  ]);
}

function postPurchase(siteUrl) {
  const rows = [];
  if (siteUrl) rows.push([Markup.button.url("🌐 View on Dexvra", siteUrl)]);
  rows.push([homeBtn()]);
  return Markup.inlineKeyboard(rows);
}

const WELCOME =
  "<b>🚀 Dexvra Bot</b> — Find the next Moonshot\n\n" +
  "List your token and get seen across the Dexvra network — website, Telegram channels, and X.\n\n" +
  "<b>Packages:</b>\n" +
  "⚡ <b>Xpress Listing</b> — instant listing, live on the board\n" +
  "🏆 <b>Listing &amp; Trending</b> — tiered (Diamond → Bronze) with announcement post\n" +
  "🔥 <b>Trending</b> — featured trending slot (3H–48H)\n" +
  "📢 <b>Banner Ads</b> — homepage banner takeover\n\n" +
  "Pick an option below 👇";

module.exports = {
  Markup,
  homeBtn,
  withHome,
  mainMenu,
  chainMenu,
  idxButtons,
  confirmPayment,
  yesNo,
  postPurchase,
  WELCOME,
};
