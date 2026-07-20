// Listing flow: Xpress Listing (instant, XPRESS tier) and Listing & Trending
// (pick a ranked tier). Guided form → review card → tier (tiered) → payment.
// Per-chain contract-address validation is enforced (the reference bot skipped it).
const { answer, toast, sendCard, sendPhotoCard, getMediaFileId } = require("../helpers/message");
const { chainOf, isValidAddress, payChainOf, payNativeOf } = require("../config/chains");
const { RANKED_TIERS, tierPrice, tierLabel, tierEmoji, tierTrendingHours } = require("../config/packages");
const { fetchMarket, fetchTokenDescription } = require("../marketdata");
const { fetchTokenInfo } = require("../dexscreener");
const { escapeHtml } = require("../helpers/format");
const { startPayment } = require("./pay");
const menu = require("./menu");
const { Markup } = menu;
const tpl = require("../templates");
const log = require("../helpers/logger");

const URL_RE = /^https?:\/\/\S+$/i;

function emptyForm() {
  return {
    chain: null, address: null, sym: null, name: null, emoji: "🪙", overview: null,
    website: null, twitter: null, telegram: null, logoFileId: null, logoUrl: null,
  };
}

// One clean paragraph — the overview renders on the channel post and the site.
// Length limits count code points so an emoji at the boundary never gets its
// surrogate pair split (which would store/send ill-formed text).
const cpSlice = (s, n) => Array.from(String(s)).slice(0, n).join("");
const cleanOverview = (s) => cpSlice(String(s || "").replace(/\s+/g, " ").trim(), 500) || null;
function freshSession(ctx, patch) {
  const prev = ctx.session && ctx.session.latest_bot_message;
  ctx.session = { latest_bot_message: prev, ...patch };
}
function isListing(ctx) {
  const t = ctx.session && ctx.session.type;
  return t === "xpress_listing" || t === "tiered_listing";
}

// ── Entry ────────────────────────────────────────────────────────────────────
async function entry(ctx, type) {
  await answer(ctx);
  if (ctx.chat && ctx.chat.type !== "private") return;
  freshSession(ctx, { type, form: emptyForm() });
  const intro = tpl.render(type === "xpress_listing" ? "intro_xpress" : "intro_tiered");
  // The Xpress intro points to Listing & Trending — give a one-tap route to it
  // (a button, not just text), so nobody has to backtrack to Home to upgrade.
  const extra =
    type === "xpress_listing"
      ? [[menu.Markup.button.callback("🏆 Listing & Trending", "listing_trend_coin")]]
      : [];
  await sendCard(ctx, intro, menu.chainMenu("lc", extra));
}
const entryXpress = (ctx) => entry(ctx, "xpress_listing");
const entryListingTrending = (ctx) => entry(ctx, "tiered_listing");

// ── Chain pick ───────────────────────────────────────────────────────────────
async function chainPick(ctx) {
  await answer(ctx);
  if (!isListing(ctx)) return;
  const chain = ctx.match[1];
  if (!chainOf(chain)) return toast(ctx, "Unknown chain.");
  ctx.session.form.chain = chain;
  ctx.session.awaitingField = "address";
  await sendCard(ctx, tpl.render("listing_ca_prompt", { chain: chainOf(chain).label }), menu.withHome([]));
}

// ── Free-text field capture ──────────────────────────────────────────────────
async function handleText(ctx) {
  const s = ctx.session;
  const f = s.form;
  if (!f) return;
  const field = s.awaitingField;
  const input = (ctx.message.text || "").trim();

  if (input === "/skip" && ["logo", "website", "twitter", "telegram", "overview"].includes(field)) {
    // overview + logo edit prompts promise "/skip to remove" — honour it
    if (field === "overview") f.overview = null;
    if (field === "logo") { f.logoFileId = null; f.logoUrl = null; }
    s.awaitingField = null;
    return showReview(ctx);
  }

  switch (field) {
    case "address": {
      if (!isValidAddress(f.chain, input)) {
        return toast(ctx, tpl.render("invalid_address", { chain: chainOf(f.chain).label }));
      }
      f.address = input;
      // Autofill from DexScreener (name/symbol/logo + socials: X/Telegram/Website)
      // and GeckoTerminal (name/symbol/logo + project overview). DexScreener
      // wins for socials.
      const [ds, gt, desc] = await Promise.all([
        fetchTokenInfo(f.chain, input).catch(() => null),
        fetchMarket(f.chain, input).catch(() => null),
        fetchTokenDescription(f.chain, input).catch(() => null),
      ]);
      const name = (ds && ds.name) || (gt && gt.name);
      const symbol = (ds && ds.symbol) || (gt && gt.symbol);
      const logoUrl = (ds && ds.logoUrl) || (gt && gt.logoUrl);
      if (desc && !f.overview) f.overview = cleanOverview(desc);
      if (name || symbol) {
        f.name = f.name || name || symbol;
        f.sym = f.sym || String(symbol || name || "").replace(/^\$+/, "").toUpperCase();
        if (logoUrl && !f.logoUrl) f.logoUrl = logoUrl;
        if (ds) {
          if (ds.website && !f.website) f.website = ds.website;
          if (ds.twitter && !f.twitter) f.twitter = ds.twitter;
          if (ds.telegram && !f.telegram) f.telegram = ds.telegram;
        }
        s.awaitingField = null;
        return showReview(ctx);
      }
      s.awaitingField = "name";
      return sendCard(ctx, tpl.render("listing_name_prompt"), menu.withHome([]));
    }
    case "name":
      f.name = input.slice(0, 60);
      if (!s.reviewShown) {
        s.awaitingField = "symbol";
        return sendCard(ctx, tpl.render("listing_symbol_prompt"), menu.withHome([]));
      }
      s.awaitingField = null;
      return showReview(ctx);
    case "symbol":
      f.sym = input.replace(/^\$+/, "").toUpperCase().slice(0, 24);
      if (!s.reviewShown) {
        s.awaitingField = "logo";
        return sendCard(ctx, tpl.render("listing_logo_prompt"), menu.withHome([]));
      }
      s.awaitingField = null;
      return showReview(ctx);
    case "overview":
      f.overview = cleanOverview(input);
      s.awaitingField = null;
      return showReview(ctx);
    case "website":
    case "twitter":
    case "telegram":
      if (!URL_RE.test(input)) return toast(ctx, tpl.render("invalid_url"));
      f[field] = input;
      s.awaitingField = null;
      return showReview(ctx);
    default:
      return; // no active field
  }
}

async function handlePhoto(ctx) {
  const s = ctx.session;
  if (!s || !s.form || s.awaitingField !== "logo") return;
  const id = getMediaFileId(ctx);
  if (!id) return;
  s.form.logoFileId = id;
  s.form.logoUrl = null; // uploaded photo wins over any autofill URL
  s.awaitingField = null;
  return showReview(ctx);
}

// ── Review card ──────────────────────────────────────────────────────────────
function reviewKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✏️ Name", "edit_name"), Markup.button.callback("✏️ Symbol", "edit_symbol")],
    [Markup.button.callback("🖼 Logo", "edit_logo"), Markup.button.callback("📝 Overview", "edit_overview")],
    [Markup.button.callback("🌐 Website", "edit_website"), Markup.button.callback("🐦 X", "edit_twitter")],
    [Markup.button.callback("💬 Telegram", "edit_telegram")],
    [Markup.button.callback("✅ Confirm", "approve_listing"), Markup.button.callback("🗑 Discard", "discard_listing")],
    [Markup.button.callback("🏠 Home", "home")],
  ]);
}

async function showReview(ctx) {
  const f = ctx.session.form;
  ctx.session.reviewShown = true;
  const premium = require("../premium");
  const v = (x) => (x ? premium.sanitizeVar(x) : "not set");
  const text = tpl.render("review_card", {
    chain: chainOf(f.chain).label,
    name: v(f.name),
    symbol: f.sym ? "$" + premium.sanitizeVar(f.sym) : "not set",
    address: premium.sanitizeVar(f.address),
    logo: f.logoFileId || f.logoUrl ? "added ✓" : "not set",
    overview: f.overview
      ? premium.sanitizeVar(Array.from(f.overview).length > 160 ? cpSlice(f.overview, 157).trimEnd() + "…" : f.overview)
      : "not set — a short intro is auto-written on the channel post",
    website: v(f.website),
    twitter: v(f.twitter),
    telegram: v(f.telegram),
  });
  const photo = f.logoFileId || (f.logoUrl && f.logoUrl.startsWith("http") ? f.logoUrl : null);
  if (photo) return sendPhotoCard(ctx, photo, text, reviewKb());
  return sendCard(ctx, text, reviewKb());
}

// ── Edit buttons ─────────────────────────────────────────────────────────────
async function editField(ctx) {
  await answer(ctx);
  if (!isListing(ctx)) return;
  const field = ctx.match[1];
  const labels = {
    name: "name",
    symbol: "symbol (ticker)",
    logo: "logo — send it as a photo, or /skip to remove",
    overview: "project overview — 1-3 sentences about your project (shown on the listing post), or /skip to remove",
    website: "website URL (https://…), or /skip",
    twitter: "X URL (https://…), or /skip",
    telegram: "Telegram URL (https://…), or /skip",
  };
  if (!labels[field]) return;
  ctx.session.awaitingField = field;
  await sendCard(ctx, tpl.render("edit_field_prompt", { field: labels[field] }), menu.withHome([]));
}

// ── Confirm → tier / payment ─────────────────────────────────────────────────
function buildListingInput(f, tier) {
  return {
    chain: f.chain,
    address: f.address,
    sym: f.sym,
    name: f.name,
    emoji: f.emoji || "🪙",
    tier,
    overview: f.overview || undefined,
    website: f.website || undefined,
    twitter: f.twitter || undefined,
    telegram: f.telegram || undefined,
    logoUrl: f.logoUrl && f.logoUrl.startsWith("http") ? f.logoUrl : undefined,
  };
}

async function goPay(ctx, tier) {
  const f = ctx.session.form;
  const chain = f.chain;
  const price = tierPrice(tier, chain);
  if (price == null) return toast(ctx, tpl.render("pricing_unavailable"));
  const kind = tier === "XPRESS" ? "xpress_listing" : "tiered_listing";
  const label =
    (tier === "XPRESS" ? "Xpress Listing" : `${tierLabel(tier)} Listing`) +
    ` — $${f.sym} on ${chainOf(chain).label}`;
  await startPayment(ctx, {
    kind,
    chain: payChainOf(chain),
    native: payNativeOf(chain),
    humanAmount: price,
    label,
    payload: {
      listingInput: buildListingInput(f, tier),
      logoFileId: f.logoFileId || null,
      trendHours: tierTrendingHours(tier),
    },
  });
}

async function approve(ctx) {
  await answer(ctx);
  if (!isListing(ctx)) return;
  const f = ctx.session.form;
  if (!f.chain || !f.address || !f.name || !f.sym) {
    await toast(ctx, tpl.render("listing_incomplete"));
    return showReview(ctx);
  }
  if (ctx.session.type === "xpress_listing") return goPay(ctx, "XPRESS");

  // Listing & Trending → tier chooser
  const chain = f.chain;
  const native = payNativeOf(chain);
  const rows = RANKED_TIERS.map((t) => [
    Markup.button.callback(`${tierEmoji(t.key)} ${t.label} · ${tierPrice(t.key, chain)} ${native}`, `lt_${t.key}`),
  ]);
  await sendCard(ctx, tpl.render("tier_chooser", { native }), menu.withHome(rows));
}

async function tierPick(ctx) {
  await answer(ctx);
  if (!isListing(ctx)) return;
  const tier = ctx.match[1];
  if (!RANKED_TIERS.find((t) => t.key === tier)) return toast(ctx, "Unknown tier.");
  ctx.session.form.tier = tier;
  return goPay(ctx, tier);
}

async function discard(ctx) {
  await answer(ctx);
  const { showHome } = require("./start");
  log.debug(`[listing] discarded by ${ctx.from && ctx.from.id}`);
  return showHome(ctx);
}

module.exports = {
  entryXpress,
  entryListingTrending,
  chainPick,
  tierPick,
  editField,
  approve,
  discard,
  handleText,
  handlePhoto,
};
