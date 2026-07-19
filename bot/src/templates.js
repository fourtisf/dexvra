// Editable-template engine. Every user-facing message and channel-post layout
// has a built-in DEFAULT here; admins override any of them via @dexvraadminbot,
// which writes data/templates.json. The main bot reads through render(key, vars)
// / t(key, vars), substituting {placeholders}, and auto-refreshes the file every
// 30s so edits apply WITHOUT a redeploy.
//
// Template format — PREMIUM MARKUP (fourtis syntax), not HTML:
//   [😀](emoji/1234567890)  premium custom emoji (😀 = fallback shown to non-premium)
//   **bold**   [text](url)   `code`
// Rendering modes, decided per template:
//   1. Admin pasted a message containing premium emoji → stored {text, entities},
//      re-sent with entities (offset-safe substitution).
//   2. Markup string (all DEFAULTS) → parsed to text+entities.
//   3. Legacy saved HTML (real tags present, no markup) → parse_mode:"HTML".
const path = require("node:path");
const { loadJSONSync, saveJSON, DATA_DIR } = require("./helpers/persist");
const premium = require("./premium");

const FILE = "templates.json";
const BANNER_PATH = path.join(DATA_DIR, "banner"); // image bytes (any ext), set by adminbot
const REFRESH_MS = 30000;

// Premium emoji document IDs (public packs, proven in fourtis production).
// Any Telegram Premium account can send these; regular bots fall back to the
// plain unicode emoji. Central map so templates stay readable.
const E = {
  rocket: "5341323326188956773", // 🚀
  plane: "5039783602301175152", // ✈️
  globe: "5456437619476941825", // 🌐
  globe2: "5447410659077661506", // 🌐 (alt)
  link: "5271604874419647061", // 🔗
  zap: "5105049474359624797", // ⚡
  zap2: "5456140674028019486", // ⚡️
  chartUp: "5280842756367851322", // 📈
  siren: "5972051363939487192", // 🚨
  sirenHead: "5395695537687123235", // 🚨 (header)
  clip: "5305265301917549162", // 📎
  chart: "5415916918026548824", // 📊
  dollar: "5413400737205990933", // 💲
  green: "6073581319915312172", // 🟢
  megaphone: "5217943819311389632", // 📢
  gold: "5440539497383087970", // 🥇
  diamond: "5427168083074628963", // 💎
  cross: "5454335838575936647", // ❌
};
const em = (emoji, id) => `[${emoji}](emoji/${id})`;

// ── Built-in defaults (premium markup) ───────────────────────────────────────
// Placeholders each template accepts are listed in META below (for the editor).
const DEFAULTS = {
  // ── Bot messages (to the user) ──
  welcome:
    `${em("🚀", E.rocket)} **Dexvra Bot** — Find the next Moonshot\n\n` +
    "List your token and get seen across the Dexvra network — website, Telegram channels, and X.\n\n" +
    "**Packages:**\n" +
    `${em("⚡", E.zap)} **Xpress Listing** — instant listing, live on the board\n` +
    "🏆 **Listing & Trending** — tiered (Diamond → Bronze) with announcement post\n" +
    "🔥 **Trending** — featured trending slot (3H–48H)\n" +
    `${em("📢", E.megaphone)} **Banner Ads** — homepage banner takeover\n\n` +
    "Pick an option below 👇",
  listing_ca_prompt: `${em("🔗", E.link)} Send your token's **contract address** on **{chain}**:`,
  listing_name_prompt: "🏷 Send your **token name**:",
  listing_symbol_prompt: "🔤 Send your **token symbol** (e.g. BONK):",
  listing_logo_prompt: "🖼 Send your **logo** as a photo, or /skip:",
  trending_ca_prompt:
    "🔥 **Book a Trending slot**\n\nSend the **contract address** (or Dexvra token link) of your **already-listed** token:",
  trending_not_found:
    `${em("❌", E.cross)} I couldn't find that token listed on Dexvra.\n\n` +
    "List it first (⚡ Xpress or 🏆 Listing & Trending), then come back to book a Trending slot.",
  pay_card:
    `💳 **Payment**\n\n**{label}**\n\n` +
    `Send **exactly {amount} {native}** to this address:\n\n` +
    "`{address}`\n\n" +
    "⏱ This address is unique to your order. After you send, tap **Confirm** and I'll verify it on-chain (this can take up to a minute).",
  pay_card_admin: "🧪 **Admin test order (FREE)**\n\n**{label}**\n\nNo payment required — tap **Confirm** to activate.",
  payment_not_detected:
    `${em("❌", E.cross)} I haven't detected your payment yet.\n\n` +
    "Send exactly **{amount} {native}** to:\n`{address}`\n\n" +
    "Then tap **Confirm** again. If you already paid, wait a moment (or contact support with order `{order}`).",
  payment_snag:
    "⚠️ Payment received but finalizing hit a snag. Your order `{order}` is safe — please contact support and we'll complete it.",
  success_listing:
    `✅ **Payment successful — your token is LIVE on Dexvra!**\n\n` +
    `**{symbol}** — {name}\n${em("🌐", E.globe)} [View your listing]({siteUrl})\n{postLinks}\n\n` +
    `Thanks for listing with Dexvra! ${em("🚀", E.rocket)}`,
  success_trending:
    `✅ **Payment successful — Trending activated!**\n\n` +
    `**{symbol}** is now featured on Dexvra Trending for **{hours}h**.\n` +
    `${em("🌐", E.globe)} [View on Dexvra]({siteUrl})\n{postLinks}`,
  success_banner:
    `✅ **Payment successful — Banner ad booked!**\n\n` +
    `Your **{slot}** is running on Dexvra until {endsAt}.\n{postLinks}`,

  // ── Channel post layouts ──
  // {tierLine}/{socials}/{footer} are auto-built; the rest are raw values.
  post_listing:
    `{head}\n\n{tierLine}**{name}** [({symbol})]({coinUrl})\n` +
    `${em("🔗", E.link)} **Contract:**\n\`{address}\`\n` +
    `${em("📊", E.chart)} **Chain:** {chain}\n` +
    `${em("💲", E.dollar)} **Price:** {price}  |  **MC:** {mcap}\n{socials}\n` +
    `${em("🟢", E.green)} [Buy / View on Dexvra]({coinUrl}){footer}`,
  post_trending:
    `🔥 **{symbol} is now Trending on Dexvra** ${em("⚡", E.zap)}\n\n` +
    `**{name}**  ·  {chain}\n${em("🔗", E.link)} **CA:** \`{address}\`\n` +
    `${em("💲", E.dollar)} **Price:** {price}  |  **MC:** {mcap}\n{socials}\n` +
    `🔥 [View on Dexvra Trending]({coinUrl}){footer}`,
  post_pump:
    `${em("📈", E.chartUp)} **Pump Alert — Dexvra** ${em("⚡", E.zap)}\n\n` +
    `**{name} | {symbol}** is up **{percent}%** since listing on [Dexvra]({coinUrl})\n\n` +
    `${em("🚨", E.siren)} **First MC:** {firstMc}  |  **Last MC:** {lastMc}\n` +
    `${em("🔗", E.link)} \`{address}\`{footer}`,
  post_banner:
    `${em("📢", E.megaphone)} **Featured on Dexvra**\n\n` +
    `{title} is now running a **{slot}** banner across Dexvra.\n👉 [Check it out]({linkUrl}){footer}`,
};

// ── Editor metadata: groups + placeholder hints ──────────────────────────────
const META = {
  welcome: { group: "Bot Messages", label: "Welcome / Start", ph: [] },
  listing_ca_prompt: { group: "Bot Messages", label: "Prompt: contract address", ph: ["chain"] },
  listing_name_prompt: { group: "Bot Messages", label: "Prompt: token name", ph: [] },
  listing_symbol_prompt: { group: "Bot Messages", label: "Prompt: token symbol", ph: [] },
  listing_logo_prompt: { group: "Bot Messages", label: "Prompt: logo", ph: [] },
  trending_ca_prompt: { group: "Bot Messages", label: "Prompt: trending CA", ph: [] },
  trending_not_found: { group: "Bot Messages", label: "Trending: token not listed", ph: [] },
  pay_card: { group: "Bot Messages", label: "Payment card", ph: ["label", "amount", "native", "address"] },
  pay_card_admin: { group: "Bot Messages", label: "Payment card (admin free)", ph: ["label"] },
  payment_not_detected: { group: "Bot Messages", label: "Payment not detected", ph: ["amount", "native", "address", "order"] },
  payment_snag: { group: "Bot Messages", label: "Payment snag", ph: ["order"] },
  success_listing: { group: "Bot Messages", label: "Success: listing", ph: ["symbol", "name", "siteUrl", "postLinks"] },
  success_trending: { group: "Bot Messages", label: "Success: trending", ph: ["symbol", "hours", "siteUrl", "postLinks"] },
  success_banner: { group: "Bot Messages", label: "Success: banner", ph: ["slot", "endsAt", "postLinks"] },
  post_listing: { group: "Channel Posts", label: "Post: Listing", ph: ["head", "tierLine", "name", "symbol", "chain", "address", "price", "mcap", "coinUrl", "socials", "footer"] },
  post_trending: { group: "Channel Posts", label: "Post: Trending", ph: ["symbol", "name", "chain", "address", "price", "mcap", "coinUrl", "socials", "footer"] },
  post_pump: { group: "Channel Posts", label: "Post: Pump alert", ph: ["name", "symbol", "percent", "firstMc", "lastMc", "address", "coinUrl", "footer"] },
  post_banner: { group: "Channel Posts", label: "Post: Banner ad", ph: ["title", "slot", "linkUrl", "footer"] },
};

// ── Load / cache with auto-refresh ───────────────────────────────────────────
let cache = null;
let lastLoad = 0;

function loadAll() {
  const now = Date.now();
  if (cache && now - lastLoad < REFRESH_MS) return cache;
  const saved = loadJSONSync(FILE, {});
  cache = { ...DEFAULTS, ...saved };
  lastLoad = now;
  return cache;
}

function substitute(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : ""));
}

/** Resolve a template into a send-ready payload:
 *    { text, entities }  — markup default or admin-pasted premium-emoji template
 *    { html }            — legacy admin-saved HTML template
 *  message.js / channels/post.js accept this payload shape directly. */
function render(key, vars) {
  const val = loadAll()[key] != null ? loadAll()[key] : DEFAULTS[key] || "";
  if (val && typeof val === "object" && val.text != null) {
    // Admin-pasted template stored with real entity arrays (premium emoji kept).
    return premium.substituteEntities(val.text, val.entities, vars);
  }
  const s = String(val);
  if (!premium.hasPremiumMarkup(s) && premium.looksLikeHtml(s)) {
    // Legacy HTML template saved before the markup era — render as HTML.
    return { html: substitute(s, vars) };
  }
  return premium.parse(substitute(s, vars));
}

/** Plain-text resolve (markup stripped to clean text) — for previews/tests. */
function t(key, vars) {
  const r = render(key, vars);
  return r.html != null ? r.html : r.text;
}

/** Raw (unsubstituted) current value — for the editor's "current" view.
 *  Entity-based templates return their text (entities noted by the editor). */
function getRaw(key) {
  const val = loadAll()[key] != null ? loadAll()[key] : DEFAULTS[key] || "";
  return val && typeof val === "object" && val.text != null ? val.text : String(val);
}
function getRawValue(key) {
  return loadAll()[key] != null ? loadAll()[key] : DEFAULTS[key] || "";
}
function isCustom(key) {
  return loadJSONSync(FILE, {})[key] != null;
}
async function setTemplate(key, value) {
  const saved = loadJSONSync(FILE, {});
  saved[key] = value;
  await saveJSON(FILE, saved);
  cache = null; // force reload on next read
}
async function resetTemplate(key) {
  const saved = loadJSONSync(FILE, {});
  if (key in saved) {
    delete saved[key];
    await saveJSON(FILE, saved);
  }
  cache = null;
}

const keys = () => Object.keys(DEFAULTS);
const meta = (key) => META[key] || { group: "Other", label: key, ph: [] };
const groups = () => {
  const g = {};
  for (const k of keys()) (g[meta(k).group] ||= []).push(k);
  return g;
};

module.exports = {
  t,
  render,
  getRaw,
  getRawValue,
  isCustom,
  setTemplate,
  resetTemplate,
  keys,
  meta,
  groups,
  substitute,
  DEFAULTS,
  BANNER_PATH,
  EMOJI: E,
  em,
};
