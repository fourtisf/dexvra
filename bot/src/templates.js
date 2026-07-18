// Editable-template engine. Every user-facing message and channel-post layout
// has a built-in DEFAULT here; admins override any of them via @dexvraadminbot,
// which writes data/templates.json. The main bot reads through t(key, vars),
// substituting {placeholders}, and auto-refreshes the file every 30s so edits
// apply WITHOUT a redeploy. Templates are HTML (parse_mode:"HTML").
const path = require("node:path");
const { loadJSONSync, saveJSON, DATA_DIR } = require("./helpers/persist");

const FILE = "templates.json";
const BANNER_PATH = path.join(DATA_DIR, "banner"); // image bytes (any ext), set by adminbot
const REFRESH_MS = 30000;

// ── Built-in defaults ────────────────────────────────────────────────────────
// Placeholders each template accepts are listed in META below (for the editor).
const DEFAULTS = {
  // ── Bot messages (to the user) ──
  welcome:
    "🚀 <b>Dexvra Bot</b> — Find the next Moonshot\n\n" +
    "List your token and get seen across the Dexvra network — website, Telegram channels, and X.\n\n" +
    "<b>Packages:</b>\n" +
    "⚡ <b>Xpress Listing</b> — instant listing, live on the board\n" +
    "🏆 <b>Listing &amp; Trending</b> — tiered (Diamond → Bronze) with announcement post\n" +
    "🔥 <b>Trending</b> — featured trending slot (3H–48H)\n" +
    "📢 <b>Banner Ads</b> — homepage banner takeover\n\n" +
    "Pick an option below 👇",
  listing_ca_prompt: "📄 Send your token's <b>contract address</b> on <b>{chain}</b>:",
  listing_name_prompt: "🏷 Send your <b>token name</b>:",
  listing_symbol_prompt: "🔤 Send your <b>token symbol</b> (e.g. BONK):",
  listing_logo_prompt: "🖼 Send your <b>logo</b> as a photo, or /skip:",
  trending_ca_prompt:
    "🔥 <b>Book a Trending slot</b>\n\nSend the <b>contract address</b> (or Dexvra token link) of your <b>already-listed</b> token:",
  trending_not_found:
    "❌ I couldn't find that token listed on Dexvra.\n\nList it first (⚡ Xpress or 🏆 Listing &amp; Trending), then come back to book a Trending slot.",
  pay_card:
    "💳 <b>Payment</b>\n\n<b>{label}</b>\n\n" +
    "Send <b>exactly {amount} {native}</b> to this address:\n\n" +
    "<code>{address}</code>\n\n" +
    "⏱ This address is unique to your order. After you send, tap <b>Confirm</b> and I'll verify it on-chain (this can take up to a minute).",
  pay_card_admin:
    "🧪 <b>Admin test order (FREE)</b>\n\n<b>{label}</b>\n\nNo payment required — tap <b>Confirm</b> to activate.",
  payment_not_detected:
    "❌ I haven't detected your payment yet.\n\nSend exactly <b>{amount} {native}</b> to:\n<code>{address}</code>\n\nThen tap <b>Confirm</b> again. If you already paid, wait a moment (or contact support with order <code>{order}</code>).",
  payment_snag:
    "⚠️ Payment received but finalizing hit a snag. Your order <code>{order}</code> is safe — please contact support and we'll complete it.",
  success_listing:
    "✅ <b>Payment successful — your token is LIVE on Dexvra!</b>\n\n" +
    "<b>{symbol}</b> — {name}\n🌐 <a href=\"{siteUrl}\">View your listing</a>\n{postLinks}\n\nThanks for listing with Dexvra! 🚀",
  success_trending:
    "✅ <b>Payment successful — Trending activated!</b>\n\n" +
    "<b>{symbol}</b> is now featured on Dexvra Trending for <b>{hours}h</b>.\n🌐 <a href=\"{siteUrl}\">View on Dexvra</a>\n{postLinks}",
  success_banner:
    "✅ <b>Payment successful — Banner ad booked!</b>\n\n" +
    "Your <b>{slot}</b> is running on Dexvra until {endsAt}.\n{postLinks}",

  // ── Channel post layouts ──
  // {tierLine}/{socials}/{footer} are auto-built; the rest are raw values.
  post_listing:
    "{head}\n\n{tierLine}<b>{name}</b> <a href=\"{coinUrl}\">({symbol})</a>\n" +
    "🔗 <b>Contract:</b>\n<code>{address}</code>\n" +
    "📊 <b>Chain:</b> {chain}\n" +
    "💲 <b>Price:</b> {price}  |  <b>MC:</b> {mcap}\n{socials}\n" +
    "🟢 <a href=\"{coinUrl}\">Buy / View on Dexvra</a>{footer}",
  post_trending:
    "🔥 <b>{symbol} is now Trending on Dexvra</b> ⚡\n\n" +
    "<b>{name}</b>  ·  {chain}\n🔗 <b>CA:</b> <code>{address}</code>\n" +
    "💲 <b>Price:</b> {price}  |  <b>MC:</b> {mcap}\n{socials}\n" +
    "🔥 <a href=\"{coinUrl}\">View on Dexvra Trending</a>{footer}",
  post_pump:
    "📈 <b>Pump Alert — Dexvra</b> ⚡\n\n" +
    "<b>{name} | {symbol}</b> is up <b>{percent}%</b> since listing on <a href=\"{coinUrl}\">Dexvra</a>\n\n" +
    "🚨 <b>First MC:</b> {firstMc}  |  <b>Last MC:</b> {lastMc}\n🔗 <code>{address}</code>{footer}",
  post_banner:
    "📢 <b>Featured on Dexvra</b>\n\n{title} is now running a <b>{slot}</b> banner across Dexvra.\n👉 <a href=\"{linkUrl}\">Check it out</a>{footer}",
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

/** Resolve a template with placeholder substitution. */
function t(key, vars) {
  const tpl = loadAll()[key];
  return substitute(tpl != null ? tpl : DEFAULTS[key] || "", vars);
}

/** Raw (unsubstituted) current value — for the editor's "current" view. */
function getRaw(key) {
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
  getRaw,
  isCustom,
  setTemplate,
  resetTemplate,
  keys,
  meta,
  groups,
  substitute,
  DEFAULTS,
  BANNER_PATH,
};
