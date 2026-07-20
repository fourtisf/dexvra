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
    "💎 **Welcome to Dexvra**\n\n" +
    "⚡ Your all-in-one platform for token **Listing, Trending & Banner Ads** — powered by the [dexvra.io](https://dexvra.io) ecosystem.\n\n" +
    "✅ Maximum exposure across dexvra.io, our Telegram channels and X — fully automatic.\n\n" +
    "**Our Services**\n" +
    "⚡ **Xpress Listing** — go live in minutes\n" +
    "🏆 **Listing & Trending** — ranked tiers, Diamond → Bronze\n" +
    "🔥 **Trending Token** — featured placement, up to 48H\n" +
    "📢 **Banner Ads** — homepage banner campaigns\n" +
    "🚀 **Mass DM** — your message to every Dexvra user\n" +
    "🟢 **Buy Bot** — free live buy alerts in your group\n\n" +
    "**Dexvra Channels**\n" +
    "🌐 Website: [dexvra.io](https://dexvra.io)\n" +
    "📢 [Announcements](https://t.me/dexvraio)\n" +
    "🚨 [Listings](https://t.me/dexvralisting)\n" +
    "📈 [Trending](https://t.me/dexvratrending)\n\n" +
    "👇 Tap a button below to get started — each step is fully guided.",
  intro_xpress:
    "⚡ **Xpress Listing**\n\n" +
    "🔹 Go live in **minutes** — no tier, no review.\n\n" +
    "**What you get**\n" +
    "✅ Listed on [dexvra.io](https://dexvra.io)\n" +
    "🚨 Launch post on [@dexvralisting](https://t.me/dexvralisting)\n" +
    "🐦 Automatic post on X\n\n" +
    "💎 Want Trending + a tier badge too? Choose **🏆 Listing & Trending**.\n\n" +
    "🔹 Only one step away — **select your network** below to begin:",
  intro_tiered:
    "🏆 **Listing & Trending**  (Best value)\n\n" +
    "🔹 Maximum exposure across the entire Dexvra network.\n\n" +
    "**What you get**\n" +
    "✅ Permanent listing on [dexvra.io](https://dexvra.io)\n" +
    "🚨 Launch post on [@dexvralisting](https://t.me/dexvralisting)\n" +
    "🔥 Featured Trending run on [@dexvratrending](https://t.me/dexvratrending)\n" +
    "📢 Announcement headline on [@dexvraio](https://t.me/dexvraio) (top tiers)\n" +
    "🐦 Automatic post on X\n" +
    "💎 A ranked tier badge on every post\n\n" +
    "⚠️ Only **Diamond, Gold & Platinum** get the bonus @dexvraio announcement.\n\n" +
    "🔹 Only one step away — **select your network** below to begin:",
  tier_chooser:
    "🏆 **Select your tier**\n\n" +
    "🔹 **Every tier includes:** a permanent dexvra.io listing, a launch post on @dexvralisting, a bundled Trending run, an automatic X post and a tier badge.\n\n" +
    "💎 **Higher tiers** rank higher and trend longer — and Diamond, Gold & Platinum add a headline on @dexvraio.\n\n" +
    "🔥 Only one step away — choose your tier (prices in **{native}**):",
  trending_durations:
    "🔥 **Trending — {symbol}** · {chain}\n\n" +
    "🔹 A featured slot on the dexvra.io Trending board, announced instantly on [@dexvratrending](https://t.me/dexvratrending).\n\n" +
    "📢 **24H & 48H** runs also get a headline on [@dexvraio](https://t.me/dexvraio).\n" +
    "💰 Longer durations carry bigger discounts.\n\n" +
    "🔥 Only one step away — select a duration (**{native}**):",
  intro_banner:
    "📢 **Dexvra Banner Ads**\n\n" +
    "🔹 Your creative on the dexvra.io homepage — seen by every visitor.\n\n" +
    "**What you get**\n" +
    "🖼 A homepage banner with your own click-through link\n" +
    "📢 An announcement on [@dexvraio](https://t.me/dexvraio)\n" +
    "🐦 An automatic post on X\n\n" +
    "💰 USD pricing — bigger discounts on longer runs.\n\n" +
    "🔹 Please have your banner ready (GIF, JPG or PNG). Choose a format:",
  listing_ca_prompt:
    "📄 **Contract Address**\n\n🔹 Paste your token's contract address on **{chain}**:",
  listing_name_prompt: "🪙 **Token Name**\n\n🔹 What is your project called?",
  listing_symbol_prompt: "💠 **Ticker**\n\n🔹 Send your token symbol (e.g. PEPE):",
  listing_logo_prompt: "🖼 **Logo**\n\n🔹 Send your logo as a photo — or /skip to continue without one.",
  trending_ca_prompt:
    "🔥 **Book a Trending Slot**\n\n" +
    "🔹 Push your listed token to the top of the dexvra.io Trending board — in front of the whole network.\n\n" +
    "**What you get**\n" +
    "🔝 Featured placement on the Trending board\n" +
    "🔥 Instant activation alert on [@dexvratrending](https://t.me/dexvratrending)\n" +
    "📢 24H & 48H runs also headline on [@dexvraio](https://t.me/dexvraio)\n\n" +
    "⌛ Slots run up to **48 hours** — longer runs carry bigger discounts.\n\n" +
    "🔹 Paste the **contract address** of your listed token (or its dexvra.io link):",
  trending_not_found:
    "❌ **Not listed yet**\n\n" +
    "🔹 We couldn't find that token on Dexvra.\n\n" +
    "List it first — ⚡ **Xpress** or 🏆 **Listing & Trending** — then come back to book your Trending slot.",
  review_card:
    "📋 **Review your listing**\n\n" +
    "🪙 **Token:** {name} ({symbol})\n" +
    "📊 **Chain:** {chain}\n" +
    "📂 **Contract:**\n`{address}`\n\n" +
    "🖼 **Logo:** {logo}\n" +
    "💬 **Overview:** {overview}\n" +
    "🌐 **Website:** {website}\n" +
    "🐦 **X:** {twitter}\n" +
    "📢 **Telegram:** {telegram}\n\n" +
    "🔹 This is exactly what goes live on your token page and channel posts.\nTap **✅ Confirm**, or use the edit buttons below.",
  edit_field_prompt: "✏️ Send the new **{field}**:",
  invalid_address:
    "❌ That doesn't look like a valid **{chain}** contract address.\n\n🔹 Double-check and paste it again:",
  invalid_url: "❌ That must be a full **https://** URL.\n\n🔹 Please try again:",
  listing_incomplete: "⚠️ Please set a **name, symbol and a valid contract address** before confirming.",
  pricing_unavailable: "⚠️ Pricing isn't available for this network yet — please pick another.",
  session_expired: "⌛ Your session expired — send /start to begin again.",
  trending_service_down: "⚠️ We couldn't reach the listings service — please try again in a moment.",
  banner_duration_prompt:
    "📢 **{name}** · {size}\n\n" +
    "🔹 Campaign pricing is in **USD**, converted to crypto at checkout.\n" +
    "💰 Longer runs carry bigger discounts.\n\n" +
    "🔹 Choose your campaign duration:",
  banner_image_prompt:
    "🖼 **Upload your creative**\n\n🔹 Send your banner as a photo — recommended size **{size}**, PNG or JPG, clean and readable at a glance:",
  banner_link_prompt:
    "🔗 **Target Link**\n\n🔹 Send the **click-through URL** (https://…) — visitors who tap your banner land here:",
  banner_title_prompt:
    "🏷 **Campaign Title**\n\n🔹 Send a short title for your campaign (shown in the announcement) — or /skip:",
  banner_pay_prompt:
    "💳 **{slot}** · {duration} — **${usd}**\n\n" +
    "🔹 Choose the currency you'd like to pay with — the exact amount is calculated at the live market rate:",
  price_feed_down: "⚠️ The price feed is unavailable right now — please try again in a minute.",
  checking_payment:
    "🌀 **Verifying your payment…**\n\n" +
    "🔹 Detecting **{amount} {native}** on **{chain}** — on-chain confirmation usually takes 30–60 seconds. We'll confirm here automatically.",
  still_checking: "⏳ Still verifying your last payment — hang tight, this takes up to a minute.",
  no_pending_payment: "🔹 There's no pending payment on this chat. Send /start to begin.",
  pay_card:
    "⚡ **Order Summary**\n\n" +
    "{label}\n\n" +
    "👜 **Send {native} to this wallet:**\n`{address}`\n\n" +
    "💰 **Amount:** `{amount}` {native}\n\n" +
    "⏳ This address is unique to your order. **Please pay within 5 minutes**, then tap **✅ Confirm Payment** — verification usually takes under a minute.",
  pay_card_admin:
    "🧪 **Admin Test Order — FREE**\n\n{label}\n\n🔹 No payment needed. Tap **✅ Confirm** to run the flow end-to-end.",
  payment_not_detected:
    "❌ **Payment not detected yet**\n\n" +
    "🔹 We haven't seen your transfer of **{amount} {native}** to:\n`{address}`\n\n" +
    "🔹 Just sent it? Give it a minute and tap **Confirm** again.\n" +
    "🔹 Already paid? Contact support with order ID `{order}`.",
  payment_snag:
    "⚠️ **We're on it**\n\n🔹 Your payment for order `{order}` arrived, but finalizing hit a snag. Your funds are safe — contact support and we'll complete your order.",
  success_listing:
    "✅ **Payment Confirmed**\n\n" +
    "⚡ Congratulations! **{symbol}** ({name}) is officially listed on Dexvra! 🎉\n\n" +
    "🌐 **Dexvra listing:** {siteUrl}\n{postLinks}\n\n" +
    "🌐 dexvra.io  |  🚨 Listing  |  🔥 Trending  |  📢 Announcement",
  success_trending:
    "✅ **Payment Confirmed**\n\n" +
    "⚡ Congratulations! **{symbol}** is now **Trending** on Dexvra for the next **{hours} hours**, announced across our channels! 🔥\n\n" +
    "🌐 **Dexvra listing:** {siteUrl}\n{postLinks}\n\n" +
    "🌐 dexvra.io  |  🚨 Listing  |  🔥 Trending  |  📢 Announcement",
  success_banner:
    "✅ **Payment Confirmed**\n\n" +
    "⚡ Congratulations! Your **{slot}** banner is now live on the dexvra.io homepage until {endsAt}, announced in our channel! 📢\n{postLinks}\n\n" +
    "🌐 dexvra.io  |  🚨 Listing  |  🔥 Trending  |  📢 Announcement",
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
    "🔹 **{symbol}**'s featured placement on the Dexvra Trending board ends in about **{hours}h**.\n\n" +
    "🔥 Extend now to keep your spot without a gap — a **{discount}% renewal discount** is already applied below:",

  // ── Channel post layouts ──
  // {tierLine}/{overview}/{socials}/{footer} are auto-built and carry their own
  // spacing (they collapse cleanly when empty); the rest are raw values.
  post_listing:
    `{head} {logoEmoji}{tierLine}\n\n` +
    `🪙 **{name}** ({symbol})\n` +
    `🔗 [{coinUrlLabel}]({coinUrl})\n\n` +
    `💠 **Chain:** {chain}\n` +
    `📄 **Contract:**\n\`{address}\`\n\n` +
    `💧 **Liquidity:** {liq}\n` +
    `📈 **Market Cap:** {mcap}\n\n` +
    `{socials}{footer}`,
  post_trending:
    `🔥 **New Trending on Dexvra** {logoEmoji}\n\n` +
    `🪙 **{name}** ({symbol})\n` +
    `🔗 [{coinUrlLabel}]({coinUrl})\n\n` +
    `💠 **Chain:** {chain}\n` +
    `📄 **Contract:**\n\`{address}\`\n\n` +
    `💧 **Liquidity:** {liq}\n` +
    `📈 **Market Cap:** {mcap}\n\n` +
    `{socials}{footer}`,
  post_rankup:
    `${em("📈", E.chartUp)} **{symbol} · Trending #{rank} on Dexvra**\n\n` +
    `**{name}** just moved up to **#{rank}** on the Dexvra Trending board.{change}\n\n` +
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

  // ── X / Twitter posts (PLAIN TEXT — X has no markdown; keep under ~280
  //    chars: a URL counts as 23, each emoji ~2). Footer order Listing →
  //    Trending → Announcement. Posted on a successful listing/trending order. ──
  x_listing:
    "⚡ New Listing on Dexvra ⚡\n\n" +
    "🚀 {name} ( #{tag} ) is now live on {chain}!\n" +
    "🔗 {url}\n\n" +
    "📄 CA: {address}\n\n" +
    "💰 Price: {price}  |  📊 MC: {mcap}\n\n" +
    "#Dexvra #NewListing #Altcoin #Memecoin #DexvraListing #DYOR",
  x_trending:
    "🔥 {symbol} is now Trending on Dexvra!\n\n" +
    "💎 {name}  ·  {chain}\n" +
    "🔗 {url}\n\n" +
    "🌐 dexvra.io | 🚨 Listing | 🔥 Trending | 📢 Announcement\n" +
    "#Dexvra #Trending #{tag} #DYOR",
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
  post_listing: { group: "Channel Posts", label: "Post: Listing", ph: ["head", "tierLine", "logoEmoji", "overview", "name", "symbol", "twitter", "chain", "address", "price", "mcap", "liq", "coinUrl", "socials", "footer"] },
  post_trending: { group: "Channel Posts", label: "Post: Trending", ph: ["symbol", "name", "chain", "logoEmoji", "overview", "address", "price", "mcap", "liq", "coinUrl", "socials", "footer"] },
  post_pump: { group: "Channel Posts", label: "Post: Pump alert", ph: ["name", "symbol", "percent", "multiple", "firstMc", "lastMc", "address", "coinUrl", "footer"] },
  post_rankup: { group: "Channel Posts", label: "Post: Rank-up alert", ph: ["symbol", "name", "chain", "rank", "change", "coinUrl", "footer"] },
  post_banner: { group: "Channel Posts", label: "Post: Banner ad", ph: ["title", "slot", "linkUrl", "footer"] },
  x_listing: { group: "X Posts", label: "X post: new listing", ph: ["name", "tag", "chain", "url", "address", "price", "mcap"] },
  x_trending: { group: "X Posts", label: "X post: trending", ph: ["symbol", "name", "chain", "url", "tag"] },
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

/** Wipe every admin-saved override → all templates revert to the code defaults.
 *  Returns how many custom templates were cleared. */
async function resetAllTemplates() {
  const saved = loadJSONSync(FILE, {});
  const n = Object.keys(saved).length;
  await saveJSON(FILE, {});
  cache = null;
  return n;
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
  resetAllTemplates,
  keys,
  meta,
  groups,
  substitute,
  DEFAULTS,
  BANNER_PATH,
  EMOJI: E,
  em,
};
