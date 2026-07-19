// Central handler registration. Regex actions keep the callback-data scheme
// compact (see menu.js) and avoid per-chain/per-plan enumeration. The free-text
// + photo routers are registered LAST so specific actions always win first.
const start = require("./start");
const listing = require("./listing");
const trending = require("./trending");
const banner = require("./banner");
const massdm = require("./massdm");
const groupSetup = require("../group/setup");
const text = require("./text");
const payment = require("../payments/payment");
const log = require("../helpers/logger");

function registerHandlers(bot) {
  // ── Commands ──────────────────────────────────────────────────────────────
  bot.start(start.startHandler);
  bot.command("home", start.homeHandler);
  bot.command("menu", start.homeHandler);
  bot.help((ctx) =>
    ctx.reply("Send /start to open the menu. List your token, book Trending, or run a Banner Ad."),
  );

  // ── Group buy bot (run inside a project's group chat) ──────────────────────
  bot.command("settoken", groupSetup.settoken);
  bot.command("setchain", groupSetup.setchain);
  bot.command("setminbuy", groupSetup.setminbuy);
  bot.command("buybot", groupSetup.buybot);

  // ── Main menu ─────────────────────────────────────────────────────────────
  bot.action("home", start.homeHandler);
  bot.action("submit_coin", listing.entryXpress);
  bot.action("listing_trend_coin", listing.entryListingTrending);
  bot.action("trend_coin", trending.entryTrending);
  bot.action("ad_banner", banner.entryBanner);

  // ── Listing flow ──────────────────────────────────────────────────────────
  bot.action(/^lc_(.+)$/, listing.chainPick);
  bot.action(/^lt_(.+)$/, listing.tierPick);
  bot.action(/^edit_([a-z_]+)$/, listing.editField);
  bot.action("approve_listing", listing.approve);
  bot.action("discard_listing", listing.discard);

  // ── Trending flow ─────────────────────────────────────────────────────────
  bot.action(/^td_(\d+)$/, trending.durationPick);
  bot.action(/^xtd_([a-f0-9]+)_(\d+H)$/, trending.extendPick); // slot-expiry renewal

  // ── Banner flow ───────────────────────────────────────────────────────────
  bot.action(/^bt_(standard|wide)$/, banner.typePick);
  bot.action(/^bd_(\d+)$/, banner.durationPick);
  bot.action(/^bpay_(.+)$/, banner.payPick);
  bot.action(/^yn_([a-z]+)_(yes|no)$/, banner.yesNo);

  // ── Mass DM flow ──────────────────────────────────────────────────────────
  bot.action("ad_massdm", massdm.entryMassDm);
  bot.action(/^md_pay_([a-z]+)$/, massdm.payPick);
  bot.action("md_test", massdm.testSend);

  // ── Payment ───────────────────────────────────────────────────────────────
  bot.action("confirm_pay", payment.confirmPayHandler);

  // ── Free-text + media routers (LAST) ──────────────────────────────────────
  bot.on("text", text.textRouter);
  bot.on(["photo", "document", "video", "animation"], text.mediaRouter);

  log.info("[registry] handlers registered");
  return bot;
}

module.exports = { registerHandlers };
