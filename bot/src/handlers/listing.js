// Listing flow: Xpress Listing (instant, XPRESS tier) and Listing & Trending
// (pick a ranked tier). Guided form → review card → tier (tiered) → payment.
// Per-chain contract-address validation is enforced (the reference bot skipped it).
const { answer, toast, sendCard, sendPhotoCard, getMediaFileId } = require("../helpers/message");
const { chainOf, isValidAddress, nativeOf } = require("../config/chains");
const { RANKED_TIERS, tierPrice, tierLabel, tierEmoji, tierTrendingHours } = require("../config/packages");
const { fetchMarket } = require("../marketdata");
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
    chain: null, address: null, sym: null, name: null, emoji: "🪙",
    website: null, twitter: null, telegram: null, logoFileId: null, logoUrl: null,
  };
}
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
  const head =
    type === "xpress_listing"
      ? "⚡ <b>Xpress Listing</b> — instant, live on the board"
      : "🏆 <b>Listing &amp; Trending</b> — choose a tier (Diamond → Bronze)";
  await sendCard(ctx, `${head}\n\nFirst, pick your token's chain:`, menu.chainMenu("lc"));
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

  if (input === "/skip" && ["logo", "website", "twitter", "telegram"].includes(field)) {
    s.awaitingField = null;
    return showReview(ctx);
  }

  switch (field) {
    case "address": {
      if (!isValidAddress(f.chain, input)) {
        return toast(ctx, `❌ That doesn't look like a valid ${chainOf(f.chain).label} address. Try again.`);
      }
      f.address = input;
      // Autofill from DexScreener (name/symbol/logo + socials: X/Telegram/Website)
      // and GeckoTerminal (name/symbol/logo). DexScreener wins for socials.
      const [ds, gt] = await Promise.all([
        fetchTokenInfo(f.chain, input).catch(() => null),
        fetchMarket(f.chain, input).catch(() => null),
      ]);
      const name = (ds && ds.name) || (gt && gt.name);
      const symbol = (ds && ds.symbol) || (gt && gt.symbol);
      const logoUrl = (ds && ds.logoUrl) || (gt && gt.logoUrl);
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
    case "website":
    case "twitter":
    case "telegram":
      if (!URL_RE.test(input)) return toast(ctx, "❌ That must be a full https:// URL.");
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
    [Markup.button.callback("🖼 Logo", "edit_logo"), Markup.button.callback("🌐 Website", "edit_website")],
    [Markup.button.callback("🐦 X", "edit_twitter"), Markup.button.callback("💬 Telegram", "edit_telegram")],
    [Markup.button.callback("✅ Confirm", "approve_listing"), Markup.button.callback("🗑 Discard", "discard_listing")],
    [Markup.button.callback("🏠 Home", "home")],
  ]);
}

async function showReview(ctx) {
  const f = ctx.session.form;
  ctx.session.reviewShown = true;
  const row = (label, v) => `${label}: ${v ? escapeHtml(v) : "—"}`;
  const text =
    `📋 <b>Review your listing</b>\n\n` +
    `📊 Chain: <b>${escapeHtml(chainOf(f.chain).label)}</b>\n` +
    `${row("🏷 Name", f.name)}\n` +
    `🔤 Symbol: ${f.sym ? "$" + escapeHtml(f.sym) : "—"}\n` +
    `🔗 CA: <code>${escapeHtml(f.address)}</code>\n` +
    `🖼 Logo: ${f.logoFileId || f.logoUrl ? "✅ set" : "— none"}\n` +
    `${row("🌐 Website", f.website)}\n` +
    `${row("🐦 X", f.twitter)}\n` +
    `${row("💬 Telegram", f.telegram)}\n\n` +
    `Tap <b>✅ Confirm</b> when ready.`;
  const photo = f.logoFileId || (f.logoUrl && f.logoUrl.startsWith("http") ? f.logoUrl : null);
  if (photo) return sendPhotoCard(ctx, photo, text, reviewKb());
  return sendCard(ctx, text, reviewKb());
}

// ── Edit buttons ─────────────────────────────────────────────────────────────
async function editField(ctx) {
  await answer(ctx);
  if (!isListing(ctx)) return;
  const field = ctx.match[1];
  const prompts = {
    name: "🏷 Send the new <b>name</b>:",
    symbol: "🔤 Send the new <b>symbol</b>:",
    logo: "🖼 Send the new <b>logo</b> as a photo, or /skip to remove:",
    website: "🌐 Send the <b>website</b> URL (https://…), or /skip:",
    twitter: "🐦 Send the <b>X</b> URL (https://…), or /skip:",
    telegram: "💬 Send the <b>Telegram</b> URL (https://…), or /skip:",
  };
  if (!prompts[field]) return;
  ctx.session.awaitingField = field;
  await sendCard(ctx, prompts[field], menu.withHome([]));
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
  if (price == null) return toast(ctx, "Pricing isn't available for this chain — pick another.");
  const kind = tier === "XPRESS" ? "xpress_listing" : "tiered_listing";
  const label =
    (tier === "XPRESS" ? "Xpress Listing" : `${tierLabel(tier)} Listing`) +
    ` — $${f.sym} on ${chainOf(chain).label}`;
  await startPayment(ctx, {
    kind,
    chain,
    native: nativeOf(chain),
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
    await toast(ctx, "Please set a name, symbol, and valid contract address first.");
    return showReview(ctx);
  }
  if (ctx.session.type === "xpress_listing") return goPay(ctx, "XPRESS");

  // Listing & Trending → tier chooser
  const chain = f.chain;
  const native = nativeOf(chain);
  const rows = RANKED_TIERS.map((t) => [
    Markup.button.callback(`${tierEmoji(t.key)} ${t.label} · ${tierPrice(t.key, chain)} ${native}`, `lt_${t.key}`),
  ]);
  await sendCard(
    ctx,
    `🏆 <b>Choose your listing tier</b>\n\nHigher tiers rank first and post to the announcement channel. All include a Trending feature.`,
    menu.withHome(rows),
  );
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
