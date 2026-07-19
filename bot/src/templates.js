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
const { escapeHtml } = require("./helpers/format");
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
// Voice: professional exchange-style — clear hierarchy, short lines, emoji as
// accents (never bullet spam). Deliberately NOT the fourtis layout.
const DEFAULTS = {
  // ── Bot messages (to the user) ──
  welcome:
    `${em("💎", E.diamond)} **Welcome to Dexvra**\n\n` +
    "The visibility platform for tokens — listings, trending placements and banner campaigns across dexvra.io, our Telegram network and X.\n\n" +
    "**What would you like to launch today?**\n\n" +
    `${em("⚡", E.zap)} **Xpress Listing** — live in minutes\n` +
    "🏆 **Listing & Trending** — Diamond → Bronze tiers, with announcement\n" +
    "🔥 **Trending Slots** — 3 to 48 hours of featured placement\n" +
    `${em("📢", E.megaphone)} **Banner Campaigns** — premium homepage placement\n\n` +
    "Select an option below.",
  listing_ca_prompt:
    `${em("🔗", E.link)} **Contract address**\n\nPaste your token's contract address on **{chain}**:`,
  listing_name_prompt: "**Token name**\n\nWhat is your project called?",
  listing_symbol_prompt: "**Ticker**\n\nSend your token symbol (e.g. PEPE):",
  listing_logo_prompt: "**Logo**\n\nSend your logo as a photo — or /skip to continue without one.",
  trending_ca_prompt:
    "🔥 **Book a Trending slot**\n\nPaste the contract address (or Dexvra token link) of your **listed** token:",
  trending_not_found:
    `${em("❌", E.cross)} **Not listed yet**\n\n` +
    "We couldn't find that token on Dexvra. List it first — ⚡ Xpress or 🏆 Listing & Trending — then come back to book your slot.",
  pay_card:
    `💳 **Order summary**\n\n{label}\n\n` +
    `**Amount due** — {amount} {native}\n**Payment address**\n\`{address}\`\n\n` +
    "This address is unique to your order. Once sent, tap **Confirm** — on-chain verification usually takes under a minute.",
  pay_card_admin:
    "🧪 **Admin test order — FREE**\n\n{label}\n\nNo payment needed. Tap **Confirm** to run the flow end-to-end.",
  payment_not_detected:
    `${em("❌", E.cross)} **Payment not detected yet**\n\n` +
    "We haven't seen your transfer of **{amount} {native}** to:\n`{address}`\n\n" +
    "Just sent it? Give it a minute and tap **Confirm** again.\nAlready paid? Contact support with order ID `{order}`.",
  payment_snag:
    "⚠️ **We're on it**\n\nYour payment for order `{order}` arrived, but finalizing hit a snag. Your funds are safe — contact support and we'll complete the order.",
  success_listing:
    `✅ **You're live on Dexvra**\n\n` +
    `**{symbol}** — {name} is now listed and visible across the Dexvra network.\n\n` +
    `${em("🌐", E.globe)} [Open your token page]({siteUrl})\n{postLinks}\n\n` +
    "Welcome aboard — the Dexvra team",
  success_trending:
    `✅ **Trending activated**\n\n` +
    `**{symbol}** holds a featured Trending slot for the next **{hours} hours**.\n\n` +
    `${em("🌐", E.globe)} [View your live ranking]({siteUrl})\n{postLinks}`,
  success_banner:
    `✅ **Campaign booked**\n\n` +
    `Your **{slot}** is live across Dexvra until {endsAt}.\n{postLinks}`,

  // ── Channel post layouts ──
  // {tierLine}/{socials}/{footer} are auto-built; the rest are raw values.
  post_listing:
    `{head}\n\n**{name}** · {symbol}\n{tierLine}` +
    `\`{address}\`\n\n` +
    `${em("📊", E.chart)} **Chain** — {chain}\n` +
    `${em("💲", E.dollar)} **Price** — {price}\n` +
    `${em("📈", E.chartUp)} **Market cap** — {mcap}\n\n{socials}\n\n` +
    `${em("🟢", E.green)} [Trade & track on Dexvra]({coinUrl}){footer}`,
  post_trending:
    `🔥 **{symbol} is Trending on Dexvra**\n\n` +
    `**{name}** · {chain}\n\`{address}\`\n\n` +
    `${em("💲", E.dollar)} **Price** — {price}\n` +
    `${em("📈", E.chartUp)} **Market cap** — {mcap}\n\n{socials}\n\n` +
    `${em("🟢", E.green)} [View live ranking]({coinUrl}){footer}`,
  post_pump:
    `${em("📈", E.chartUp)} **{symbol} +{percent}%**\n\n` +
    `**{name}** is up **{percent}%** since listing on Dexvra.\n\n` +
    `**Market cap** — {firstMc} → {lastMc}\n\`{address}\`\n\n` +
    `${em("🟢", E.green)} [Chart & trade]({coinUrl}){footer}`,
  post_banner:
    `${em("📢", E.megaphone)} **Now featured on Dexvra**\n\n` +
    `{title} has launched a **{slot}** campaign across dexvra.io.\n\n` +
    `👉 [View the campaign]({linkUrl}){footer}`,
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
 *  message.js / channels/post.js accept this payload shape directly.
 *  Vars are handled per mode: in an ENTITY template, markup-bearing vars
 *  (socials/footer/postLinks/…) are pre-parsed into {text, entities} fragments
 *  so their links/emoji render instead of showing raw markup; in the legacy
 *  HTML mode every var is markup-stripped AND HTML-escaped so user values can
 *  neither leak markup nor break Telegram's HTML parser. */
function render(key, vars) {
  const val = loadAll()[key] != null ? loadAll()[key] : DEFAULTS[key] || "";
  if (val && typeof val === "object" && val.text != null) {
    // Admin-pasted template stored with real entity arrays (premium emoji kept).
    const rich = {};
    for (const k of Object.keys(vars || {})) {
      const v = vars[k];
      if (typeof v === "string" && v) {
        const p = premium.parse(v);
        rich[k] = p.entities.length ? p : v;
      } else {
        rich[k] = v;
      }
    }
    return premium.substituteEntities(val.text, val.entities, rich);
  }
  const s = String(val);
  if (!premium.hasPremiumMarkup(s) && premium.looksLikeHtml(s)) {
    // Legacy HTML template saved before the markup era — render as HTML with
    // markup-stripped, escaped values (links degrade to plain text: correct
    // beats broken).
    const safe = {};
    for (const k of Object.keys(vars || {})) {
      const v = vars[k];
      safe[k] = v == null ? "" : escapeHtml(premium.parse(String(v)).text);
    }
    return { html: substitute(s, safe) };
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
