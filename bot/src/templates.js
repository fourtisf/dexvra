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

// Premium emoji document IDs. NOTE: these are a THIRD-PARTY (fourtis) pack, so
// they render with that project's branding when actually sent as custom emoji.
// To stay visually distinct, the default templates now use PLAIN UNICODE emoji
// (em() below returns the bare emoji) unless PREMIUM_EMOJI=1 is set AND you've
// swapped these for your OWN Dexvra emoji-pack IDs. Admins can still paste their
// own premium emoji into any template via the editor — that path is unaffected.
const USE_PREMIUM_EMOJI = /^(1|true|yes|on)$/i.test(String(process.env.PREMIUM_EMOJI || ""));
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
const em = (emoji, id) => (USE_PREMIUM_EMOJI ? `[${emoji}](emoji/${id})` : emoji);

// ── Built-in defaults (premium markup) ───────────────────────────────────────
// Placeholders each template accepts are listed in META below (for the editor).
// Voice: professional exchange-style — clear hierarchy, short lines, emoji as
// accents (never bullet spam). Deliberately NOT the fourtis layout.
const DEFAULTS = {
  // ── Bot messages (to the user) ──
  welcome:
    `${em("💎", E.diamond)} **Welcome to Dexvra**\n\n` +
    "The token visibility platform — get your token seen across dexvra.io, our Telegram channels and X. Everything is automatic: pick a service, paste your contract address, pay on-chain, and your posts go out.\n\n" +
    "**Get listed & promoted**\n" +
    `${em("⚡", E.zap)} **Xpress Listing** — live in minutes\n` +
    "🏆 **Listing & Trending** — ranked tiers, Diamond → Bronze\n" +
    "🔥 **Trending Slots** — featured placement, up to 48h\n" +
    `${em("📢", E.megaphone)} **Banner Campaigns** — homepage banner slots\n` +
    `${em("📢", E.megaphone)} **Mass DM** — your message to every Dexvra user\n\n` +
    "**Free for your project**\n" +
    `${em("🟢", E.green)} **Buy Bot** — add me to your group and every on-chain buy posts a live alert. Tap **🤖 Add Buy Bot to your group** below.\n\n` +
    "New here? Just tap a button — each flow walks you through it step by step.",
  intro_xpress:
    `${em("⚡", E.zap)} **Xpress Listing**\n\n` +
    "Instant activation. The moment payment clears, your token is live on the dexvra.io board with its own token page (chart, price, socials), a launch post in our Listing channel and an automatic share on X.\n\n" +
    "**Process**\n" +
    "1. Paste your contract address — details auto-fill, or add them manually\n" +
    "2. Review your listing and pay\n" +
    "3. Everything posts automatically — your links arrive right here\n\n" +
    "Select your network:",
  intro_tiered:
    "🏆 **Listing & Trending**\n\n" +
    "Our flagship package — built for maximum exposure. Your token gets a permanent home on dexvra.io plus a bundled Trending run, announced across every Dexvra channel and X so the whole network sees it.\n\n" +
    "**What your project gets**\n" +
    "🌐 Permanent listing on **dexvra.io** — your own token page with live chart, price, market cap and socials\n" +
    "🚨 Launch post in the Listing channel — [@dexvralisting](https://t.me/dexvralisting)\n" +
    "🔥 Featured run in the Trending channel — [@dexvratrending](https://t.me/dexvratrending)\n" +
    "📢 Headline in the Announcement channel — [@dexvraio](https://t.me/dexvraio) (Diamond · Gold · Platinum)\n" +
    "🐦 Automatic post on **X (Twitter)**\n" +
    "💎 A tier badge on every post — higher tiers rank higher and trend longer\n\n" +
    "**Process**\n" +
    "1. Paste your contract address — details auto-fill, or add them manually\n" +
    "2. Review your listing, choose a tier and pay\n" +
    "3. Everything posts automatically — your links arrive right here\n\n" +
    "Select your network:",
  tier_chooser:
    "🏆 **Select your tier**\n\n" +
    "Higher tiers rank higher, carry their badge on every post and bundle a longer Trending run. Diamond, Gold and Platinum include an Announcement-channel post.\n\n" +
    "Prices in **{native}**:",
  trending_durations:
    `🔥 **Trending — {symbol}** · {chain}\n\n` +
    "A featured slot on the dexvra.io Trending board, announced in our Trending channel the moment it activates. Longer durations carry larger discounts.\n\n" +
    "Select a duration (**{native}**):",
  intro_banner:
    `${em("📢", E.megaphone)} **Banner Campaigns**\n\n` +
    "Your creative in the dexvra.io homepage carousel with a click-through link, announced in our channel. USD pricing — discounts on longer runs.\n\n" +
    "**Process**\n" +
    "1. Choose a format\n" +
    "2. Pick a duration\n" +
    "3. Upload your creative and target link\n" +
    "4. Pay in the currency you prefer\n\n" +
    "Choose a format:",
  listing_ca_prompt:
    `${em("🔗", E.link)} **Contract address**\n\nPaste your token's contract address on **{chain}**:`,
  listing_name_prompt: "**Token name**\n\nWhat is your project called?",
  listing_symbol_prompt: "**Ticker**\n\nSend your token symbol (e.g. PEPE):",
  listing_logo_prompt: "**Logo**\n\nSend your logo as a photo — or /skip to continue without one.",
  trending_ca_prompt:
    "🔥 **Book a Trending slot**\n\n" +
    "Featured slots up to **48 hours** with an activation announcement — longer runs at a discount.\n\n" +
    "Paste the **contract address** of your listed token (or its dexvra.io token link) to continue:",
  trending_not_found:
    `${em("❌", E.cross)} **Not listed yet**\n\n` +
    "We couldn't find that token on Dexvra. List it first — ⚡ Xpress or 🏆 Listing & Trending — then come back to book your slot.",
  review_card:
    `📋 **Review your listing**\n\n` +
    `**{name}** · {symbol} — {chain}\n` +
    `\`{address}\`\n\n` +
    `Logo — {logo}\n` +
    `Overview — {overview}\n` +
    `Website — {website}\n` +
    `X — {twitter}\n` +
    `Telegram — {telegram}\n\n` +
    "This is what goes live on your token page and channel posts. Tap **✅ Confirm**, or use the edit buttons below.",
  edit_field_prompt: "✏️ Send the new **{field}**:",
  invalid_address:
    `${em("❌", E.cross)} That doesn't look like a valid **{chain}** contract address. Double-check and paste it again:`,
  invalid_url: `${em("❌", E.cross)} That must be a full **https://** URL — try again:`,
  listing_incomplete: "Please set a name, symbol, and a valid contract address before confirming.",
  pricing_unavailable: "Pricing isn't available for this network yet — please pick another.",
  session_expired: "Your session expired — send /start to begin again.",
  trending_service_down: "We couldn't reach the listings service — please try again in a moment.",
  banner_duration_prompt:
    `${em("📢", E.megaphone)} **{name}** · {size}\n\n` +
    "Campaign pricing is in **USD**, converted to crypto at checkout — longer runs carry bigger discounts.\n\nChoose your campaign duration:",
  banner_image_prompt:
    "🖼 **Upload your creative**\n\nSend your banner image as a photo — recommended size **{size}**, PNG or JPG, clean and readable at a glance:",
  banner_link_prompt:
    `${em("🔗", E.link)} **Target link**\n\nSend the **click-through URL** (https://…) — visitors who tap your banner land here:`,
  banner_title_prompt:
    "🏷 **Campaign title**\n\nSend a short title/label for your campaign (shown in the announcement) — or /skip:",
  banner_pay_prompt:
    `💳 **{slot}** · {duration} — **\${usd}**\n\n` +
    "Choose the currency you'd like to pay with — the exact amount is calculated at the live market rate:",
  price_feed_down: "⚠️ The price feed is unavailable right now — please try again in a minute.",
  checking_payment:
    "⏳ Checking **{chain}** for your payment of **{amount} {native}**… on-chain verification can take up to a minute.",
  still_checking: "⏳ Still verifying your last payment — hang tight, this takes up to a minute.",
  no_pending_payment: "There's no pending payment on this chat. Send /start to begin.",
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
  group_start:
    "🟢 **Dexvra Buy Bot**\n\n" +
    "I post a live alert here on **every on-chain buy** of your token.\n\n" +
    "**Set me up (30 seconds):**\n" +
    "1. Make me an **admin** of this group\n" +
    "2. Send `/settoken <your contract address>`\n" +
    "3. Done — buys start posting here\n\n" +
    "**Handy commands**\n" +
    "`/buybot` — status · `/setminbuy 50` — only alert buys ≥ $50 · `/buybot off` — pause\n\n" +
    "Want to list, trend or advertise your token? DM me → {bot}",
  buybot_help:
    `${em("🟢", E.green)} **Dexvra Buy Bot — free for your group**\n\n` +
    "Add @dexvrabot to your project's Telegram group and it posts a live alert on **every on-chain buy** of your token — amount, price, market cap, all automatic.\n\n" +
    "**Setup (60 seconds)**\n" +
    "1. Tap **➕ Add to your group** below and pick your group\n" +
    "2. Make the bot an **admin** (so it can post)\n" +
    "3. In the group send `/settoken <your contract address>`\n" +
    "4. Done — buys start posting. Tune with `/setminbuy <usd>`, pause with `/buybot off`\n\n" +
    "Works on Solana, BSC, Ethereum, Base, Tron, TON, Sui, Plasma & Robinhood.",
  group_buy_alert:
    "{emoji}\n" +
    `${em("🟢", E.green)} **{symbol} Buy!**\n\n` +
    `${em("💲", E.dollar)} **{usd}** · {count} {buysWord}\n` +
    `🪙 {tokenAmt} {symbol}\n` +
    `${em("💲", E.dollar)} Price — {price}\n` +
    `${em("📈", E.chartUp)} Market cap — {mcap}\n` +
    `${em("📊", E.chart)} {chain}\n\n` +
    "_Estimated from on-chain volume._",
  massdm_disabled: "📣 Mass DM broadcasts are paused right now — check back soon.",
  massdm_intro:
    `${em("📢", E.megaphone)} **Mass DM Broadcast**\n\n` +
    "Send your message as a **direct DM to every Dexvra user** — the strongest reach we offer. Every broadcast is admin-reviewed before it sends (keeps the audience clean and the bot safe).\n\n" +
    "**Flat price — 50% off** (charged in your token's chain)\n" +
    "◎ {sol}  ·  🟡 {bnb}  ·  ⧫ {eth}\n\n" +
    `${em("🔗", E.link)} **First, paste your token's contract address (CA).**\n` +
    "It sets the chain you'll pay in:",
  massdm_ca_invalid:
    `${em("❌", E.cross)} That doesn't look like a contract address.\n\n` +
    "Paste a valid token CA — an 0x… address (Ethereum / BSC / Base), a Solana mint, a Tron or TON address:",
  massdm_compose_prompt:
    "✅ Token detected on **{chain}** — you'll pay **{amount}**.\n\n" +
    "Now send your broadcast — **text, or a photo with a caption** (formatting & emoji are kept):",
  massdm_preview:
    "👆 **This is your broadcast.**\n\n" +
    "It goes to every Dexvra user as a DM once an admin approves — **{amount}**. Pay below, or recompose:",
  massdm_received:
    "✅ **Payment received — your broadcast is in review.**\n\n" +
    "Ref `{ref}`. An admin will approve it shortly; delivery starts right after. You'll get a receipt here when it's done.",
  massdm_enqueue_failed:
    "⚠️ **We're on it.**\n\n" +
    "Your payment arrived (ref `{ref}`) but queuing the broadcast hit a snag. Your funds are safe — contact support with this ref and we'll push it through.",
  massdm_test_queued:
    "🧪 **Test broadcast queued (FREE).**\n\n" +
    "It'll be delivered to the admins and you within a few seconds, with a delivery report — no review, no charge.",
  massdm_done:
    "✅ **Your Dexvra broadcast is delivered.**\n\n" +
    "Ref `{ref}` · reached **{reached}** users. Thanks for using Dexvra.",
  upsell_expiry:
    "⏰ **Your Trending slot is ending**\n\n" +
    "**{symbol}**'s featured placement on the Dexvra Trending board ends in about **{hours}h**.\n\n" +
    "Extend now to keep your spot without a gap — a **{discount}% renewal discount** is already applied below:",

  // ── Channel post layouts ──
  // {tierLine}/{overview}/{socials}/{footer} are auto-built and carry their own
  // spacing (they collapse cleanly when empty); the rest are raw values.
  post_listing:
    `{head}\n\n{logoEmoji}**{name}** · {symbol}\n{tierLine}\n` +
    `{overview}` +
    `${em("📊", E.chart)} **Chain** — {chain}\n` +
    `${em("💲", E.dollar)} **Price** — {price}\n` +
    `${em("📈", E.chartUp)} **Market cap** — {mcap}\n` +
    `${em("🔗", E.link)} **CA** — \`{address}\`\n\n` +
    `{socials}` +
    `${em("🟢", E.green)} [Listed on dexvra.io]({coinUrl}){footer}`,
  post_trending:
    `🔥 **{symbol} is Trending on Dexvra**\n\n` +
    `{logoEmoji}**{name}** · {chain}\n\n` +
    `{overview}` +
    `${em("💲", E.dollar)} **Price** — {price}\n` +
    `${em("📈", E.chartUp)} **Market cap** — {mcap}\n` +
    `${em("🔗", E.link)} **CA** — \`{address}\`\n\n` +
    `{socials}` +
    `${em("🟢", E.green)} [View live ranking]({coinUrl}){footer}`,
  post_rankup:
    `${em("📈", E.chartUp)} **{symbol} is climbing Dexvra Trending**\n\n` +
    `**{name}** · {chain} is up **{change}** (24h) — now the **#{rank} performer** among featured tokens.\n\n` +
    `${em("🟢", E.green)} [Trade & track on Dexvra]({coinUrl}){footer}`,
  post_pump:
    `${em("🚀", E.rocket)} **{symbol} is pumping — {multiple}**\n\n` +
    `**{name}** has run **+{percent}%** since it listed on Dexvra.\n\n` +
    `${em("📈", E.chartUp)} **Market cap** — {firstMc} → **{lastMc}**\n` +
    `${em("🔗", E.link)} \`{address}\`\n\n` +
    `${em("🟢", E.green)} [Chart & trade on Dexvra]({coinUrl}){footer}`,
  post_banner:
    `${em("📢", E.megaphone)} **Now featured on Dexvra**\n\n` +
    `{title} has launched a **{slot}** campaign across dexvra.io.\n\n` +
    `👉 [View the campaign]({linkUrl}){footer}`,
};

// ── Editor metadata: groups + placeholder hints ──────────────────────────────
const META = {
  welcome: { group: "Bot Messages", label: "Welcome / Start", ph: [] },
  intro_xpress: { group: "Bot Messages", label: "Intro: Xpress Listing", ph: [] },
  intro_tiered: { group: "Bot Messages", label: "Intro: Listing & Trending", ph: [] },
  tier_chooser: { group: "Bot Messages", label: "Tier chooser", ph: ["native"] },
  trending_durations: { group: "Bot Messages", label: "Trending: duration picker", ph: ["symbol", "chain", "native"] },
  intro_banner: { group: "Bot Messages", label: "Intro: Banner Ads", ph: [] },
  listing_ca_prompt: { group: "Bot Messages", label: "Prompt: contract address", ph: ["chain"] },
  listing_name_prompt: { group: "Bot Messages", label: "Prompt: token name", ph: [] },
  listing_symbol_prompt: { group: "Bot Messages", label: "Prompt: token symbol", ph: [] },
  listing_logo_prompt: { group: "Bot Messages", label: "Prompt: logo", ph: [] },
  trending_ca_prompt: { group: "Bot Messages", label: "Prompt: trending CA", ph: [] },
  trending_not_found: { group: "Bot Messages", label: "Trending: token not listed", ph: [] },
  review_card: { group: "Bot Messages", label: "Listing review card", ph: ["chain", "name", "symbol", "address", "logo", "overview", "website", "twitter", "telegram"] },
  edit_field_prompt: { group: "Bot Messages", label: "Edit-field prompt", ph: ["field"] },
  invalid_address: { group: "Bot Messages", label: "Error: invalid address", ph: ["chain"] },
  invalid_url: { group: "Bot Messages", label: "Error: invalid URL", ph: [] },
  listing_incomplete: { group: "Bot Messages", label: "Error: listing incomplete", ph: [] },
  pricing_unavailable: { group: "Bot Messages", label: "Error: pricing unavailable", ph: [] },
  session_expired: { group: "Bot Messages", label: "Error: session expired", ph: [] },
  trending_service_down: { group: "Bot Messages", label: "Error: listings service down", ph: [] },
  banner_duration_prompt: { group: "Bot Messages", label: "Banner: duration picker", ph: ["name", "size"] },
  banner_image_prompt: { group: "Bot Messages", label: "Banner: image prompt", ph: ["size"] },
  banner_link_prompt: { group: "Bot Messages", label: "Banner: link prompt", ph: [] },
  banner_title_prompt: { group: "Bot Messages", label: "Banner: title prompt", ph: [] },
  banner_pay_prompt: { group: "Bot Messages", label: "Banner: pay-method picker", ph: ["slot", "duration", "usd"] },
  price_feed_down: { group: "Bot Messages", label: "Error: price feed down", ph: [] },
  checking_payment: { group: "Bot Messages", label: "Payment: checking", ph: ["chain", "amount", "native"] },
  still_checking: { group: "Bot Messages", label: "Payment: still checking", ph: [] },
  no_pending_payment: { group: "Bot Messages", label: "Payment: none pending", ph: [] },
  pay_card: { group: "Bot Messages", label: "Payment card", ph: ["label", "amount", "native", "address"] },
  pay_card_admin: { group: "Bot Messages", label: "Payment card (admin free)", ph: ["label"] },
  payment_not_detected: { group: "Bot Messages", label: "Payment not detected", ph: ["amount", "native", "address", "order"] },
  payment_snag: { group: "Bot Messages", label: "Payment snag", ph: ["order"] },
  success_listing: { group: "Bot Messages", label: "Success: listing", ph: ["symbol", "name", "siteUrl", "postLinks"] },
  success_trending: { group: "Bot Messages", label: "Success: trending", ph: ["symbol", "hours", "siteUrl", "postLinks"] },
  success_banner: { group: "Bot Messages", label: "Success: banner", ph: ["slot", "endsAt", "postLinks"] },
  upsell_expiry: { group: "Bot Messages", label: "Upsell: trending slot ending", ph: ["symbol", "hours", "discount"] },
  group_start: { group: "Group Buy Bot", label: "Buy bot: /start in a group", ph: ["bot"] },
  buybot_help: { group: "Group Buy Bot", label: "Buy bot: how-to (main menu)", ph: [] },
  group_buy_alert: { group: "Group Buy Bot", label: "Group: buy alert", ph: ["emoji", "symbol", "usd", "count", "buysWord", "tokenAmt", "price", "mcap", "chain"] },
  massdm_disabled: { group: "Mass DM", label: "Mass DM: disabled", ph: [] },
  massdm_intro: { group: "Mass DM", label: "Mass DM: intro + price (ask CA)", ph: ["sol", "bnb", "eth"] },
  massdm_ca_invalid: { group: "Mass DM", label: "Mass DM: invalid CA", ph: [] },
  massdm_compose_prompt: { group: "Mass DM", label: "Mass DM: compose prompt", ph: ["chain", "amount"] },
  massdm_preview: { group: "Mass DM", label: "Mass DM: preview / pay", ph: ["amount"] },
  massdm_received: { group: "Mass DM", label: "Mass DM: paid, in review", ph: ["ref"] },
  massdm_enqueue_failed: { group: "Mass DM", label: "Mass DM: enqueue failed", ph: ["ref"] },
  massdm_test_queued: { group: "Mass DM", label: "Mass DM: test queued", ph: [] },
  massdm_done: { group: "Mass DM", label: "Mass DM: delivered receipt", ph: ["ref", "reached"] },
  post_listing: { group: "Channel Posts", label: "Post: Listing", ph: ["head", "tierLine", "logoEmoji", "overview", "name", "symbol", "chain", "address", "price", "mcap", "coinUrl", "socials", "footer"] },
  post_trending: { group: "Channel Posts", label: "Post: Trending", ph: ["symbol", "name", "chain", "logoEmoji", "overview", "address", "price", "mcap", "coinUrl", "socials", "footer"] },
  post_pump: { group: "Channel Posts", label: "Post: Pump alert", ph: ["name", "symbol", "percent", "multiple", "firstMc", "lastMc", "address", "coinUrl", "footer"] },
  post_rankup: { group: "Channel Posts", label: "Post: Rank-up alert", ph: ["symbol", "name", "chain", "rank", "change", "coinUrl", "footer"] },
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
      let v = vars[k];
      // Self-spacing vars ({socials}/{overview} end in "\n\n") double up when
      // an OLDER saved template still writes its own blank line after the
      // placeholder. Entity text can't be post-collapsed (offsets), so trim
      // the var's trailing newlines whenever the template supplies its own.
      if (typeof v === "string" && /\n+$/.test(v) && val.text.includes(`{${k}}\n`)) {
        v = v.replace(/\n+$/, "");
      }
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
    return { html: collapseGaps(substitute(s, safe)) };
  }
  return premium.parse(collapseGaps(substitute(s, vars)));
}

// Self-spacing vars ({socials}/{overview} carry their own trailing "\n\n") can
// double up against an older saved template that still writes explicit blank
// lines around the placeholder — collapse 3+ newlines so both layouts render
// clean. String paths only: entity-saved templates can't be collapsed without
// remapping premium-emoji offsets, so they keep the admin's literal spacing.
function collapseGaps(s) {
  return String(s).replace(/\n{3,}/g, "\n\n");
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
