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

// Premium emoji document IDs. NOTE: these are a THIRD-PARTY (fourtis) pack —
// rendered as custom emoji they show FOURTIS BRANDING inside Dexvra posts
// (operator complaint: the fourtis logo appeared on rank-up alerts). em()
// therefore ALWAYS returns the plain unicode emoji now, regardless of the old
// PREMIUM_EMOJI env flag; the table stays only as documentation. Premium emoji
// enter templates exclusively via the adminbot editor (admins paste their OWN
// pack) and via the per-token logo packs — both unaffected.
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
// `em(char, id)` → the premium-emoji markup this file's header documents:
// "[😀](emoji/1234567890)". It took the id and THREW IT AWAY — the signature
// said (emoji) — so every one of the 34 call sites below rendered the bare
// unicode char and the whole E map above was dead code. Nothing errored, and
// the loss is invisible for a char like 💎 or 🚨 whose unicode art is already
// colourful; it is obvious for 📢, whose premium art is a different picture
// entirely. That is the difference an operator spotted in the channel footer.
//
// Emitting the markup is safe on both transports, and neither needed changing:
// GramJS sends the custom_emoji entities and retries without them on
// PREMIUM_ACCOUNT_REQUIRED / EMOJI_INVALID (gramjs.js isPremiumEmojiError),
// while the Bot API path filters type "custom_emoji" out and shows the fallback
// char (trendingPoster.js). The legacy-HTML render branch cannot swallow it
// either: it is guarded on !hasPremiumMarkup.
const em = (emoji, id) => (id ? `[${emoji}](emoji/${id})` : emoji);

// ── Channel-post building blocks (code-level only, NOT separate templates) ──
// Inlined into every channel-post DEFAULT below so each stored template is the
// FULL post. Editing stays per-template; these constants only keep the code DRY
// and feed the legacy {socials}/{footer} vars for templates saved before the
// one-template-per-post era. Socials sit SIDE-BY-SIDE on one row (" · "
// separated) — channels/format.js cuts a segment whose link the token doesn't
// have, and the whole paragraph when it has none.
const SOCIALS_BLOCK =
  `${em("🔗", E.link)} **{symbol} social links**\n` +
  `${em("❌", E.cross)} [X]({twitter}) · 🌐 [Website]({website}) · ✈️ [Telegram]({telegram})`;
// The site + all three Telegram channels, side by side on ONE row. Split out of
// FOOTER_BLOCK so the short ticker posts (rank-up / pump) carry the SAME set
// without the "📎 Dexvra" header line above it — a reader who lands on any post
// can reach the site and every channel. Never trim it to a SUBSET of these
// four: a pump alert that linked only Trending + Dexvra.io was the operator's
// complaint.
const LINKS_ROW =
  `${em("💎", E.diamond)} [Dexvra.io]({site}) · ` +
  `${em("🚨", E.sirenHead)} [Listings]({listing}) · ` +
  `🔥 [Trending]({trending}) · ` +
  `${em("📢", E.megaphone)} [Announcements]({announce}) · ` +
  `𝕏 [X Alerts]({xlisting})`;
// The row is the full Dexvra destination set — the three Telegram channels, the
// site, AND the X account the listing feed is tweeted from ({xlisting} →
// X_LISTING_URL, @dexvralisting by default). X was previously left out on the
// grounds that the token's own social row a few lines above already prints
// "❌ X"; that reads as a duplicate only if you assume both point at the same
// account, which they never do — one is the PROJECT's X, this one is DEXVRA's.
// The row is also rendered header-less on the short rank-up / pump posts, which
// carry no social row at all, so there it was the only X link a reader could
// have followed. The label is what channels/format.js re-links by, so keep the
// words "X Alerts" if you reword the rest of the row.
const FOOTER_BLOCK = `${em("📎", E.clip)} **Dexvra**\n` + LINKS_ROW;
// Shared body of the listing/trending cards (below their distinct headers).
// Clear, labelled stats so a reader sees the token, its market at a glance, and
// exactly where to trade it. {price}/{mcap}/{liq} come from live data.
const LISTING_BODY =
  // ONLY the token name is the clickable link to its Dexvra page — the ({symbol})
  // stays plain text beside it — and no bare dexvra.io/… URL is printed (spam).
  `${em("💲", E.dollar)} [{name}]({coinUrl}) ({symbol})\n\n` +
  `{chainEmoji} **Network:** {chain}\n` +
  `📄 **Contract address:**\n{address}\n\n` +
  // Market cap and Price ONLY, SIDE-BY-SIDE on one line (operator preference) —
  // no liquidity row, and never stacked. ({liq} stays an available placeholder
  // for any custom template that still wants it.)
  `${em("🏦", E.dollar)} **Market cap:** {mcap} · ${em("📊", E.chart)} **Price:** {price}\n\n` +
  // Single one-tap CTA. {tradeUrl} = https://t.me/<tradebot>?start=ca_<address>
  // — the deep link carries the token's CA so the trade bot opens straight on
  // this token (no "Trade it now" header line above it).
  `[⚡ Buy / Sell on Dexvra Trade Bot]({tradeUrl})\n\n` +
  `[Announce On X 𝕏]({xUrl})\n\n` +
  `${SOCIALS_BLOCK}\n\n${FOOTER_BLOCK}`;

// ── Built-in defaults (premium markup) ───────────────────────────────────────
// Placeholders each template accepts are listed in META below (for the editor).
// Voice: professional exchange-style — clear hierarchy, short lines, emoji as
// accents (never bullet spam). Deliberately NOT the fourtis layout.
const DEFAULTS = {
  // ── Bot messages (to the user) ──
  // Channel links are CONFIG-DRIVEN placeholders ({site}/{announce}/{listing}/
  // {trending}) — start.js fills them from CHANNELS/SITE_URL so the default
  // links are always correct. Edit the labels/links freely; keep the
  // [Label]({placeholder}) shape and the link stays clickable.
  welcome:
    "💎 **Welcome to Dexvra**\n\n" +
    "⚡ **List · Trend · Advertise** — your token pushed across [dexvra.io]({site}), our Telegram channels and **X**, fully automatic and live in minutes.\n\n" +
    "**✨ What you can do**\n" +
    "⚡ **Xpress Listing** — live in minutes\n" +
    "🏆 **Listing & Trending** — ranked tiers, Diamond → Bronze\n" +
    "🔥 **Trending Token** — featured, up to 48H\n" +
    "📢 **Banner Ads** — homepage campaigns\n" +
    "🚀 **Mass DM** — reach every Dexvra user\n" +
    "🟢 **Buy Bot** — free live buy alerts for your group\n\n" +
    "**🔗 Official Links**\n" +
    "🌐 [Website]({site})\n" +
    "📢 [Announcements Channel]({announce})\n" +
    "🚨 [Listings Channel]({listing})\n" +
    "📈 [Trending Channel]({trending})\n" +
    "❌ [Listing Alerts on X]({xlisting})\n\n" +
    "👇 Pick a service below — each step is fully guided.",
  intro_xpress:
    "⚡ **Xpress Listing**\n\n" +
    "🔹 Go live in **minutes** — no tier, no review.\n\n" +
    "**What you get**\n" +
    "✅ Listed on [dexvra.io](https://dexvra.io)\n" +
    "🚨 Launch post on [@dexvralisting](https://t.me/dexvralisting)\n" +
    "𝕏 Automatic post on X — [@dexvralisting]({xlisting})\n\n" +
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
    "𝕏 Automatic post on X — [@dexvralisting]({xlisting})\n" +
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
    "𝕏 An automatic post on X — [@dexvralisting]({xlisting})\n\n" +
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
    "📢 24H & 48H runs also headline on [@dexvraio](https://t.me/dexvraio)\n" +
    "𝕏 An automatic post on X — [@dexvralisting]({xlisting})\n\n" +
    "⌛ Slots run up to **48 hours** — longer runs carry bigger discounts.\n\n" +
    "🔹 Paste the **contract address** of your listed token (or its dexvra.io link):",
  // One token, one listing. Shown whenever a contract that is already on the
  // site is submitted again — in the listing form, or just pasted into the chat.
  // It has to answer "so what now?", hence Book Trending as the next step.
  already_listed:
    "✅ **{name} (${symbol})** is already listed on [dexvra.io]({site})!\n\n" +
    "🔗 **View your token**\n" +
    "{url}\n\n" +
    "📊 **Chain:** {chain}\n\n" +
    "🔹 A contract can only be listed once — it is already live on the site.\n\n" +
    "📈 **Want more eyes on it?**\n\n" +
    "💡 Tap **🔥 Book Trending** below to push it to the top of the board.\n\n" +
    "𝕏 Every Dexvra listing is announced on X — [{xlisting}]({xlisting})",
  trending_not_found:
    "❌ **Not listed yet**\n\n" +
    "🔹 We couldn't find that token on Dexvra.\n\n" +
    "List it first — ⚡ **Xpress** or 🏆 **Listing & Trending** — then come back to book your Trending slot.",
  review_card:
    "📋 **Review your listing**\n\n" +
    "🪙 **Token:** {name} ({symbol})\n" +
    "📊 **Chain:** {chain}\n" +
    "📂 **Contract:**\n`{address}`\n\n" +
    "🖼 **Logo:** {logo}\n\n" +
    "💬 **Overview:**\n{overview}\n\n" +
    "🌐 **Website:** {website}\n\n" +
    "🐦 **X:** {twitter}\n\n" +
    "📢 **Telegram:** {telegram}\n\n" +
    "🔹 This is exactly what goes live on your token page and channel posts.\n\n" +
    "Tap **✅ Confirm**, or use the edit buttons below.",
  edit_field_prompt: "✏️ Send the new **{field}**:",
  invalid_address:
    "❌ That doesn't look like a valid **{chain}** contract address.\n\n🔹 Double-check and paste it again:",
  invalid_url: "❌ That must be a full **https://** URL.\n\n🔹 Please try again:",
  // The site's rule, said in the user's words (see helpers/ticker.js).
  invalid_ticker:
    "❌ That ticker can't be used — letters and numbers only (`.` `_` `-` are fine), " +
    "up to 24 characters, no spaces or emoji.\n\n🔹 Send the ticker again (e.g. **PEPE**):",
  listing_incomplete: "⚠️ Please set a **name, symbol and a valid contract address** before confirming.",
  pricing_unavailable: "⚠️ Pricing isn't available for this network yet — please pick another.",
  session_expired: "⌛ Your session expired — send /start to begin again.",
  // Sent when a handler throws or times out, so a failure is never just silence.
  error_retry: "⚠️ Something went wrong on our side — nothing was charged.\n\n🔹 Please try that again, or send /start to begin fresh.",
  trending_service_down: "⚠️ We couldn't reach the listings service — please try again in a moment.",
  banner_duration_prompt:
    "📢 **{name}** · {size}\n\n" +
    "🔹 Campaign pricing is in **USD**, converted to crypto at checkout.\n" +
    "💰 Longer runs carry bigger discounts.\n\n" +
    "🔹 Choose your campaign duration:",
  banner_image_prompt:
    "🖼 **Upload your creative**\n\n" +
    "🔹 Send your banner as a **photo** — PNG or JPG, clean and readable at a glance.\n\n" +
    "📐 **Exact size: {size}** (or any image with the same shape — {size2x} is ideal for a sharp result).\n" +
    "🔹 This exact shape is used **both** on the dexvra.io homepage and in the announcement post, so a banner at this size is never cropped.",
  banner_link_prompt:
    "🔗 **Target Link**\n\n🔹 Send the **click-through URL** (https://…) — visitors who tap your banner land here:",
  banner_desc_prompt:
    "📝 **Description**\n\n" +
    "🔹 Send the text you want under your banner in the announcement — what the project does, in your own words.\n\n" +
    "Send **/skip** to leave it out.",
  banner_ca_prompt:
    "📄 **Contract Address**\n\n" +
    "🔹 Paste your token's contract address — it will be shown as copyable text under your description.\n\n" +
    "Send **/skip** if your campaign has no token.",
  banner_socials_prompt:
    "🔗 **Socials**\n\n" +
    "🔹 Paste your links in ONE message — **X**, **Telegram** and **Website** (any order, one per line is fine).\n\n" +
    "Send **/skip** to leave them out.",
  banner_title_prompt:
    "🏷 **Campaign Title**\n\n🔹 Send a short title for your campaign (shown in the announcement) — or /skip:",
  banner_pay_prompt:
    "💳 **{slot}** · `{size}` · {duration} — **${usd}**\n\n" +
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
  // Receipt shape follows the reference bot the operator asked for: one congrats
  // line, the token's page as a BARE url, then one line per post that went out.
  // Each destination is its OWN line with its OWN label, so the operator can
  // reword or reorder them — a single auto-generated {postLinks} blob could not
  // be edited at all. A line whose link doesn't exist (an Xpress buyer has no
  // announcement and no trending post) disappears completely; see
  // dropEmptyLines. {postLinks}/{announceX} still work for older saved copies.
  success_listing:
    "✅ **Payment Confirmed**\n\n" +
    "⚡ Congrats! Your token **{name}** ({symbol}) is officially listed!\n" +
    "{siteUrl}\n\n" +
    "🔔 Dexvra Listing: {listingUrl}\n" +
    "🔔 Dexvra Listing (X): {xUrl}",
  // Listing & Trending buys three things at once — the listing, a ranked tier
  // badge and a timed Trending run — so the second line accounts for the two a
  // buyer cannot read off the links. {tier}/{tierEmoji}/{hours} exist only here.
  success_listing_tiered:
    "✅ **Payment Confirmed**\n\n" +
    "🏆 Congrats! Your token **{name}** ({symbol}) is officially listed!\n" +
    "{tierEmoji} **{tier}** tier · 🔥 Trending for **{hours}h**\n" +
    "{siteUrl}\n\n" +
    "🔔 Dexvra Listing: {listingUrl}\n" +
    "🔔 Dexvra Listing (X): {xUrl}\n" +
    "🔔 Dexvra Announcement: {announceUrl}\n" +
    "🔔 Dexvra Trending: {trendingUrl}",
  success_trending:
    "✅ **Payment Confirmed**\n\n" +
    "🔥 Congrats! **{symbol}** is Trending on Dexvra for the next **{hours}h**!\n" +
    "{siteUrl}\n\n" +
    "🔔 Dexvra Trending: {trendingUrl}\n" +
    "🔔 Dexvra Announcement: {announceUrl}\n" +
    "🔔 Dexvra (X): {xUrl}",
  success_banner:
    "✅ **Payment Confirmed**\n\n" +
    // No "banner" after {slot} — every slot name already ends in "Banner".
    "⚡ Your **{slot}** is booked on the dexvra.io homepage.\n\n" +
    "🗓 **Runs:** {startsAt} → {endsAt}\n" +
    "{queueNote}\n{postLinks}\n{announceX}\n\n" +
    "🌐 [dexvra.io]({site})  |  🚨 [Listing]({listing})  |  🔥 [Trending]({trending})  |  📢 [Announcement]({announce})",
  // ── The moment the bot lands in a group ─────────────────────────────────
  // Posted from the my_chat_member update, BEFORE anyone types anything. It
  // asks for the permissions the bot actually uses and then stops: a group that
  // has just added a bot wants to know what to grant it, not to read a feature
  // list. The full setup steps are /start (group_start below).
  //
  // NOT the "👋 Thanks for adding me! ‼️ … 🚀 Then type /start" card every other
  // group bot posts — Dexvra reads as a clone the moment it borrows that, which
  // is the same reason group_buy_alert refuses the copy-trading bots' layout.
  //
  // Each permission SAYS WHAT IT IS FOR, and that is the substantive difference,
  // not the wording: a bare list of three powerful rights reads as a bot asking
  // for the keys to the group, and an admin is right to hesitate. Every one
  // named here is a right the code genuinely exercises — ask for more than you
  // use and refusing all of it is the correct response.
  group_added:
    "🟢 **Dexvra is in**\n\n" +
    "Make it admin and it starts calling every buy in here.\n\n" +
    "📌 **Pin messages** — whale buys and the live raid board\n" +
    "🗑 **Delete messages** — clears the raid panel when it ends\n" +
    "🚫 **Ban users** — only if you switch on the raid chat lock\n\n" +
    "**Group Settings → Administrators**, then tap 🤖 Buy Bot below.\n",
  // The setup guide, sent on /start in a group — the message straight after
  // group_added. Same voice as that one: section headers, one line of what it
  // does, then the commands. It used to be written in the first person ("make
  // me an admin", "DM me", "I keep a scoreboard"), which reads as a different
  // product to the card above it.
  // THE BUTTONS ARE THE INSTRUCTIONS. This card used to end each section with
  // its command — "/settoken <CA> to arm it · /setminbuy 50 · /buybot off" —
  // which is syntax aimed at somebody who has just added a bot and is looking
  // for something to press, not something to read. Every command still works;
  // none of them is what a new group should have to find. See
  // handlers/start.js groupStartKeyboard() for the keyboard sent with this.
  //
  // So keep this text about WHAT EACH THING DOES. Adding a command back here
  // does not make the card more helpful, it makes the buttons look optional.
  group_start:
    "🟢 **Dexvra — free tools for your group**\n\n" +
    "**🤖 Buy Bot** — every on-chain buy called in here the second it lands: size, price, mcap, the wallet, and the txn to prove it. Tap below and paste your contract; that is the whole setup.\n\n" +
    "**🐋 Whale wallets** — when a wallet already deep in your bags adds more, that one gets **pinned**. On by default, tune it in ⚙️ Settings.\n\n" +
    "**🚀 Raid** — point the chat at one post and keep the board pinned until the numbers hit. No X key needed — 🤝 Crew counts whoever shows up.",
  // Button labels for the card above, pipe separated:
  //   buy bot | raid | settings | listing/trending | channel
  // Field-by-field fallback, so a half-typed override still renders a keyboard
  // instead of a row of blanks. The last two are LINK buttons and are dropped
  // when SITE_URL / the announce channel are not set to something Telegram will
  // accept — it rejects the whole message over one malformed URL.
  group_start_buttons: "🤖 Buy Bot|🚀 Raid|⚙️ Settings|🔥 Listing / Trending|📢 Channel",
  buybot_help:
    `${em("🟢", E.green)} **Group tools — free for your project**\n\n` +
    "Add @dexvrabot to your Telegram group and you get both of these, no charge:\n\n" +
    "**🤖 Buy Bot**\n" +
    "A live alert on **every on-chain buy** of your token — amount, price, market cap, price impact, plus a link to the real transaction and the buyer's wallet.\n" +
    "1. Tap **➕ Add to your group** below and pick your group\n" +
    "2. Make the bot an **admin** (so it can post)\n" +
    "3. In the group send /settoken <your contract address>\n" +
    "4. Tune with /setminbuy <usd>, pause with /buybot off\n\n" +
    "**🐋 Whale wallets** — a buy from a wallet already holding a lot of your token gets its own alert, **pinned** in the group so nobody misses it. Set the bar with /setwhale 50000.\n\n" +
    "**🚀 Raid**\n" +
    "Point your community at one X post and watch the numbers climb on a live card. Set the targets (**+15 likes**, **+5 replies**, **+10 crew**), paste the link, launch. Optionally lock the chat until the targets are hit.\n" +
    "In the group, send /raid.\n\n" +
    "Works on Solana, BSC, Ethereum, Base, Tron, TON, Sui, Plasma & Robinhood.\n\n" +
    "𝕏 Every listing is announced on X too — [Listing Alerts]({xlisting})",
  // THE REAL ALERT — one verified transaction, one card. Every number here
  // comes from the trade itself or the pool it happened in, so a reader can
  // open {verify} and check it. Do NOT add a placeholder to this template that
  // the estimated path cannot fill; the two are separate templates precisely so
  // neither has to pretend.
  // THE ICON COLUMN. One emoji per row, at the left edge, and the value
  // straight after it — the grammar every trader already reads on the buy bots
  // they follow, and what the operator asked for by name.
  //
  // This REPLACED a bold-label layout ("**Spent:** …") chosen deliberately to
  // look unlike those bots. The reasoning then was that stacked emoji are
  // decoration the eye has to skip past to reach the labels. In a group feed
  // that turned out to be backwards: the icon IS the label, it is scannable at
  // a glance while scrolling, and it costs no line width — which matters on a
  // phone, where a bold label pushes the number that people actually came for
  // onto a second line. Standing out was never worth being harder to read.
  //
  // If you are reverting this, revert group_whale_alert with it: the two are
  // one grammar, and a feed that mixes two reads as a bug in the bot rather
  // than a choice.
  //
  // {emoji} is the size row (see group_buy_style); {bar} is a fill-meter, still
  // available as a placeholder if you ever want one.
  // NO MARK AND NO PIPE IN FRONT OF THE NAME. The header used to open
  // "💎 | {name} BUY!" — the Dexvra diamond, then a separator whose only job was
  // to hold the diamond apart from the name. The token's own name is what a
  // reader is scanning for, and putting our badge in front of it every time
  // spends the most valuable character position on the card telling them
  // something they already know. Dropping the emoji drops the pipe with it: a
  // separator with nothing on its left is punctuation for a word that is not
  // there.
  group_buy_alert:
    "[{name}]({coinUrl}) **{tier}!**\n\n" +
    "{emoji}\n\n" +
    "{nameRow}\n" +
    "💲 {usd}{native}\n" +
    "🪙 {tokenAmt} {symbol}\n" +
    // Price and market cap on one row, liquidity and the 24h move on the next:
    // the numbers that say whether this buy is a rounding error or a dent.
    "📊 {price} · MC {mcap}\n" +
    "💧 {liq} · 24h {change}\n" +
    "{verify}\n" +
    // The buyer's own position, directly under WHO bought — how much of the
    // token that wallet now holds, what it is worth, and how much this buy grew
    // it. {wallet} is the WHOLE row (emoji and label included) so it VANISHES
    // rather than leaving a dangling label whenever the holding could not be
    // read: an unsupported chain, an RPC that did not answer, a buy under the
    // dust floor, or a group that turned holdings off with /setwhale off.
    // {holds}, {holdsUsd} and {position} are the same three facts on their own
    // if you would rather lay them out yourself.
    "{wallet}\n\n" +
    "[⚡ Trade on Dexvra]({tradeUrl}) · [📈 Chart]({chartUrl}) · [💎 Dexvra]({coinUrl})",
  // WHALE WALLET — a buy from someone already holding a lot of the token,
  // whatever they just spent. Pinned in the group, so it is deliberately its own
  // card rather than the normal one with a louder word on it.
  //
  // {holds} is the buyer's balance OF THIS TOKEN valued at the pool price — not
  // a portfolio total, which this bot cannot see. The label says so.
  //
  // {whaleBar} — the bar this wallet cleared — is a PLACEHOLDER, not a default
  // row. It is the operator's own threshold, and a reader in the group has no
  // use for it: it explains the bot's mechanism instead of reporting the event.
  // Available for anyone who does want it, and never a hardcoded "$50,000",
  // because the group's /setwhale or the admin bot can move it at any time.
  group_whale_alert:
    "[{name}]({coinUrl}) **WHALE WALLET!**\n\n" +
    "{emoji}\n\n" +
    "{nameRow}\n" +
    "💲 {usd}{native}\n" +
    "🪙 {tokenAmt} {symbol}\n" +
    // The one row the ordinary card cannot carry: what this wallet is sitting
    // on, and how much this buy grew it. That IS the news — everything else on
    // this card is the same market context the buy card shows, deliberately, so
    // the louder alert is not also the thinner one.
    "✅ Position: {holds} {symbol} · **{holdsUsd}** ({position})\n" +
    "📊 {price} · MC {mcap}\n" +
    "💧 {liq} · 24h {change}\n" +
    "{verify}\n\n" +
    "[⚡ Trade on Dexvra]({tradeUrl}) · [📈 Chart]({chartUrl}) · [💎 Dexvra]({coinUrl})",
  // The icons in the size row, pipe separated: normal buy | whale wallet.
  // One icon per BUYBOT_EMOJI_STEP_USD, floored and capped, so the row only
  // ever GROWS with the buy.
  //
  // It is a row and not a fill-meter on purpose: a meter shows how much is
  // MISSING, and "▰▱▱▱▱▱▱▱▱▱" on a real buy reads as something failing rather
  // than something good happening. A buy alert should never render mostly empty.
  //
  // PLAIN UNICODE ONLY — this string is split apart and repeated as plain text,
  // so it cannot carry premium-emoji entities. Same rule as raid_style.
  group_buy_style: "🟢|🐋",
  // THERE IS NO "ESTIMATED BUY" TEMPLATE ANY MORE, and this note is here so
  // nobody adds one back. It existed for when the per-transaction feed was
  // unreadable: it diffed the pool's rolling 24h volume, said "≈ $340 across 11
  // buys", and carried a line apologising for having no transaction to link.
  //
  // A buy alert's whole claim is "this happened, here is the proof". Without
  // the proof it is a number a project's own chat cannot check, posted under
  // their ticker — and it was actively costing them the real alerts, because
  // the estimate suppressed every verifiable buy it had already summarised.
  // Silence plus an hourly operator warning is the better failure: the feed
  // coming back replays those buys individually, each with its hash.
  //
  // A group that saved an override for the old `group_buy_alert_est` key keeps
  // a harmless orphan entry in data/templates.json; nothing reads it.
  // Buy-size tier labels, pipe separated: normal|whale|mega. Thresholds are
  // BUYBOT_WHALE_USD / BUYBOT_MEGA_USD in .env. Missing fields fall back one at
  // a time, so a half-typed override still renders a card.
  //
  // The header reads "{name} {tier}!", so these are the words that finish that
  // sentence — "BUY!", not "NEW BUY!". The old set was written for a header
  // that led with the tier and named the token after it.
  group_buy_tiers: "BUY|WHALE BUY|MEGA BUY",

  // ── Setup replies, /settoken → /buybot ──────────────────────────────────
  // Every one of these is a message a PAYING PROJECT sees inside their own
  // group while wiring the bot up, which is exactly the copy an operator wants
  // to be able to reword — so none of it is hardcoded any more.
  //
  // These render through the same premium-markup parser as everything else:
  // **bold**, `code`, [text](url). NOT HTML tags.
  setup_admin_only: "🔒 Group admins only.",
  setup_group_only: "👥 This one runs in your group. Add the bot there first.",
  // Sent with force_reply, so the member's keyboard opens already replying to
  // it. Keep it short: it sits directly above their input box.
  settoken_prompt:
    "📄 **Paste your contract address**\n\n" +
    "Reply to this message with it. The network is detected from the address — no need to name it.",
  settoken_resolving: "🔎 Finding the pool…",
  settoken_not_found:
    "❌ **No live pool on that CA**\n\n" +
    "Check the address, or name the chain first with /setchain <chain> and run /settoken again.",
  // The token is set and the bot is LIVE — so this says what is already running,
  // not what to run next. It used to end on a row of three commands, which reads
  // as homework at the exact moment the setup finished.
  settoken_ok:
    "✅ **Live on {chain}**\n\n" +
    "🪙 **{name}** ({symbol})\n\n" +
    "Every buy from **{minBuy}** up gets called in here. A buyer already holding **{whale}** or more gets pinned.\n\n" +
    "That's everything — the ⚙️ button changes any of it.",
  setchain_unknown: "❌ Not a chain we run on.\n\nOne of: `{chains}`",
  setchain_need_token: "📄 Set the token first: /settoken <contract address>",
  setchain_ok: "✅ Chain set to **{chain}** — pool found.",
  setchain_ok_nopool: "⚠️ Chain set to **{chain}** — no pool yet. It keeps looking every cycle.",
  // Sent when /setminbuy arrives with no amount — a question, so it answers with
  // a picker (the preset buttons come from setup.js) instead of a syntax note.
  setminbuy_panel:
    "💲 **Minimum buy**\n\n" +
    "Buys smaller than this stay out of the chat, so the feed only carries what's worth reacting to.\n\n" +
    "**Now:** {usd}\n\n" +
    "Tap an amount below, or name your own: /setminbuy 250",
  setminbuy_usage:
    "💲 **Minimum buy**\n\n" +
    "That isn't an amount. Send /setminbuy 50 — or just /setminbuy to pick from a list.",
  setminbuy_ok: "✅ **Minimum buy — {usd}**\n\nAnything smaller stays out of the chat.",
  // Sent when the amount asked for is under the $10 floor. Not a refusal: the
  // floor is applied and the reason given, because "call every buy" fills a
  // chat with dust and makes the project's own token look dead.
  setminbuy_min: "✅ **Minimum buy — {usd}**\n\nThat's the lowest floor — under it the feed is mostly dust.",
  // Button toast. Plain text by design: Telegram shows a callback answer as a
  // bare toast, so bold and links in here would reach the tapper as literals.
  setminbuy_toast: "Minimum buy: {usd}",
  // The 🐋 picker, opened by a bare /setwhale or the settings hub. {unsupported}
  // is the same caveat the confirmation carries — a bar on a chain whose
  // balances cannot be read never fires, and the panel must say so.
  setwhale_panel:
    "🐋 **Whale bar**\n\n" +
    "A buy from a wallet **already holding** this much of your token gets its own alert, pinned in the group — however small the buy itself is.\n\n" +
    "**Now:** {usd}\n\n" +
    "Tap a bar below, or name your own: /setwhale 75000{unsupported}",
  setwhale_toast: "Whale bar: {usd}",
  // One word, used wherever a setting has to be shown as off. Its own template
  // so the picker, the toast and the status card cannot drift apart.
  setwhale_state_off: "off",
  setwhale_usage:
    "🐋 **Whale bar**\n\n" +
    "/setwhale 50000 — anyone **already sitting on** that much of your token gets a pinned 🐋 **WHALE WALLET** call, however small the buy.\n\n" +
    "/setwhale off to kill it.",
  setwhale_ok:
    "🐋 **Whale bar: {usd}**\n\n" +
    "A buy from a bag that size gets **pinned** in here.{unsupported}",
  // Appended to setwhale_ok as {unsupported}. Its own template because it is a
  // caveat an operator may want to word differently — or drop.
  setwhale_unsupported:
    "\n\n⚠️ Bags aren't readable on **{chain}** yet, so whale calls stay off until they are.",
  setwhale_off: "🐋 Whale calls **off** here.",
  pin_on: "📌 Whale calls get **pinned** — each new one replaces the last. Needs the **Pin messages** permission.",
  pin_off: "📌 Whale calls **won't be pinned** here.",
  buybot_on: "🟢 **Buy bot on** — calls resume.",
  buybot_off: "🔴 **Buy bot off** — calls paused. /buybot on brings it back.",
  buybot_need_token:
    "📄 **No token set here yet**\n\nSend /settoken <contract address> and the buy bot goes live.",
  buybot_status:
    "📊 **Buy bot status**\n\n" +
    "🪙 **CA:** `{address}`\n" +
    "🔗 **Chain:** {chain}\n" +
    "💧 **Pool:** {pool}\n" +
    "💲 **Floor:** {minBuy}\n" +
    "🐋 **Whale bar:** {whale}\n" +
    "📌 **Pin whales:** {pin}\n" +
    "⚡ **State:** {state}",
  // ── Dexvra Raid ─────────────────────────────────────────────────────────
  // The live card and its three end states. {progress} is GENERATED (the goal
  // rows and their bars) because which rows exist depends on which goals are
  // set, and a flat template cannot express that — edit the copy around it, and
  // the characters INSIDE it via raid_style below.
  //
  // Premium emoji work in these four templates (they ARE the template, so they
  // travel in its entity array). They do NOT work inside {progress} or
  // raid_style — see the note on raid_style.
  raid_card:
    "🚀 **DEXVRA RAID {seq}**\n\n" +
    "📊 **{percent}% complete** · ⏱ **{left}** on the clock\n\n" +
    "{progress}\n\n" +
    "🤝 **Crew: {crew}**\n{roster}\n\n" +
    "📝 “{post}”\n\n" +
    "{note}\n" +
    "Updated {updated} UTC",
  raid_complete:
    "✅ **RAID {seq} — TARGETS HIT**\n\n" +
    "🎉 Every goal cleared. That's how it's done.\n\n" +
    "{progress}\n\n" +
    "🤝 **Crew: {crew}**\n{roster}\n\n" +
    "📝 “{post}”\n\n" +
    "Closed {updated} UTC",
  raid_expired:
    "⌛ **RAID {seq} — TIME'S UP**\n\n" +
    "📊 Finished at **{percent}%**. Good push — run it back.\n\n" +
    "{progress}\n\n" +
    "🤝 **Crew: {crew}**\n\n" +
    "Closed {updated} UTC",
  raid_cancelled:
    "🛑 **RAID {seq} — STOPPED**\n\n" +
    "📊 Stopped at **{percent}%** by an admin.\n\n" +
    "{progress}\n\n" +
    "Closed {updated} UTC",
  raid_complete_note: "✅ **Raid cleared.** Every target hit — {crew} of you turned up. 🚀",
  // ── The setup panel and its notices ─────────────────────────────────────
  // {goals} is GENERATED (one row per goal, with its live target) because which
  // rows exist depends on what is set — the same reason {progress} above is
  // generated. Everything around it is yours.
  //
  // {sources} is the one honest line about what THIS install can measure: with
  // no X key the Likes/Replies/Reposts goals cannot be read, and an operator
  // finding that out at launch instead of at setup is the failure it exists to
  // prevent. It empties itself when every source is available.
  raid_panel:
    "🚀 **DEXVRA RAID**\n\n" +
    "🔗 **Post:** {post}\n\n" +
    "🎯 **Targets**\n" +
    "{goals}\n\n" +
    "🔒 **Chat lock:** {lock}\n" +
    "{record}\n\n" +
    "Targets count **up** from where the post is at launch. A raid runs {maxMinutes} min max.\n" +
    "{sources}",
  raid_panel_record: "📈 **Record:** {started} run · {completed} cleared",
  raid_sources_none: "⚡ No X key on this bot — 🤝 **Crew** still works, and needs nothing.",
  raid_sources_partial: "⚡ Reposts need a paid X key — **Likes**, **Replies** and **Crew** are live.",
  raid_group_only: "👥 Raids run in a group.\n\nAdd the bot to yours, make it admin, then hit /raid there.",
  raid_admin_only: "🔒 Group admins only.",
  // The example is deliberately NOT a Dexvra link. It used to be, and it told
  // the reader to paste a post from an account that is not theirs — the raid is
  // meant to point at the PROJECT's own post.
  raid_seturl_prompt: "🔗 **Paste the X post link you want raided.**\n\nLike: `https://x.com/yourproject/status/1234567890`",
  raid_bad_url: "❌ That isn't an X post link.\n\nPaste the full URL of the post — it has to contain `/status/`.",
  raid_none_running: "🚀 Nothing running here.\n\nHit /raid to set one up.",
  // Launch refusals. Only the ones that are pure prose live here — the two that
  // splice in a diagnostic from the X layer ("…— 429 from the guest API") stay
  // in runner.js, because an operator cannot improve a machine-generated reason
  // and a botched edit would hide the one line that says what actually broke.
  raid_already_running: "🚀 One is already running here.",
  raid_already_launching: "⏳ That raid is already being launched.",
  raid_bad_post: "❌ That post link doesn't look right.\n\nPaste the full URL of an X post.",
  raid_no_goals: "🎯 Set at least one target first.",
  raid_reposts_only:
    "🔁 Reposts are the only target set, and nothing can count them without a **paid** X key.\n\n" +
    "Add ❤️ **Likes**, 💬 **Replies** or 🤝 **Crew** and launch again.",
  // The icons and bar characters inside {progress}. Six fields, pipe-separated:
  //   likes | replies | reposts | crew | bar-filled | bar-empty
  // PLAIN UNICODE ONLY. This string is split apart and rebuilt inside a
  // generated block, so it cannot carry the template's premium-emoji entities —
  // a premium emoji here reaches the group as a plain fallback character at
  // best. Try coloured blocks for a bolder bar: ❤️|💬|🔁|🤝|🟩|⬛
  // A missing or malformed field falls back to its own default, so a typo
  // cannot break the card. Must stay in step with STYLE_DEFAULT in raid/card.js.
  raid_style: "❤️|💬|🔁|🤝|▰|▱",
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

  // ── Channel post layouts — ONE self-contained template per post type ──
  // What you see in the editor IS the whole post: header, data rows, social
  // links and footer all live in the same template (no separate fragments).
  // Only live values are {placeholders}. channels/format.js drops a social
  // line whose link the token doesn't have — and the whole social paragraph
  // (incl. its header line) when the token has none — before rendering; the
  // tier badge line drops the same way on a listing without a tier.
  // {logoEmoji} sits at the RIGHT end of the header (operator preference) — and
  // OUTSIDE the bold run: a custom-emoji tag inside **…** would be skipped by
  // the markup parser and leak as raw text.
  post_listing_xpress:
    `${em("⚡", E.zap)} **Xpress Listing — {name} live on Dexvra** {logoEmoji}\n\n` + LISTING_BODY,
  // Tier sits BESIDE the header, not stacked under it, and the token's own
  // emoji closes the line (operator preference): "New Listing on Dexvra ·
  // 💠 Platinum tier 🐶". An untiered listing drops just the tier SEGMENT —
  // channels/format.js keeps the header itself.
  post_listing_tiered:
    // {tierEmoji} is whatever the operator set for that tier in the
    // `tier_emojis` template below — a premium emoji if they sent one. It was
    // briefly removed when the badge was a hardcoded trophy nobody chose; the
    // objection was to the emoji, not to the badge.
    `${em("🚨", E.sirenHead)} **New Listing on Dexvra** · {tierEmoji} **{tier} tier** {logoEmoji}\n\n` +
    LISTING_BODY,
  post_trending: `🔥 **New Trending on Dexvra** {logoEmoji}\n\n` + LISTING_BODY,
  // The caption under a Top-Gainers banner. {list} is the ranked leaderboard,
  // built by gainers.js — one line per token, each carrying its rank badge (the
  // same badges the trending board uses, so a premium one animates here too),
  // a link to the token's Dexvra page, its X handle when it has one, and the 24h
  // move. It arrives as ONE placeholder because the number of lines depends on
  // how many live gainers exist; everything around it is yours to reword.
  post_gainers:
    `${em("📈", E.chartUp)} **TOP GAINERS ON DEXVRA**\n` +
    `🗓 {date}\n\n` +
    `{list}\n\n` +
    `${em("📊", E.chart)} Ranked by **24h change** across every token listed on Dexvra.\n\n` +
    // The board's own tweet. Unlike the coin cards this template is rendered
    // with dropEmpty (it has no stripForCoin path), so the line disappears with
    // its blank separator when the board wasn't tweeted.
    `[Announce On X 𝕏]({xUrl})\n\n` +
    LINKS_ROW,
  // Advertiser-facing, so it reads like an ad placement announcement rather than
  // bot output: what is running, where, and one link out. The "Announce On X"
  // line carries the campaign's tweet and drops itself when there is none.
  post_banner:
    `${em("⚡", E.zap)} **BANNER LIVE ON DEXVRA** ${em("⚡", E.zap)}\n\n` +
    // The title is the click-through. NOT bold-inside-link: the markup parser
    // doesn't nest, and `[**x**](url)` leaks its asterisks into the post.
    `▶️ [{title}]({linkUrl})  ·  {slot}\n\n` +
    // The advertiser's OWN copy. Each block below is its own paragraph so it
    // disappears cleanly (header line included) when they didn't supply it —
    // plenty of campaigns are a service or an event with no token behind them.
    `{description}\n\n` +
    `${em("📄", E.clip)} **CA**\n` +
    "`{address}`\n\n" +
    `${em("🔗", E.link)} **Socials**\n` +
    `${em("❌", E.cross)} [X]({twitter}) · 🌐 [Website]({website}) · ✈️ [Telegram]({telegram})\n\n` +
    `[Announce On X 𝕏]({xUrl})\n\n` +
    FOOTER_BLOCK,
  // Rank-up is a TICKER post, not an article: the clip carries the hype and the
  // caption just says which token moved, where to read it, and the CA — then the
  // full Dexvra link row. Kept deliberately short (Moontok-style) — the long
  // version buried the ticker under three paragraphs of copy. {change} (a
  // sentence) and {gain} (compact "+42%") stay available for admins who want the
  // number back.
  post_rankup:
    `{chainEmoji} **{symbol}** ${em("📈", E.chartUp)} Rank ↑ **#{rank}** on Dexvra Trending\n` +
    `[{coinUrlLabel}]({coinUrl})\n\n` +
    `${em("📄", E.clip)} **CA**\n` +
    "`{address}`\n\n" +
    // Links the rank-up's OWN tweet; the line drops itself when there is none
    // (X off, or the post failed) — see stripForCoin/autoSocialCuts.
    `[Announce On X 𝕏]({xUrl})\n\n` +
    LINKS_ROW,
  // Same ticker shape as post_rankup: the clip carries the hype, the caption
  // states the fact. The old version buried "+2,400%" under four paragraphs of
  // copy and a per-token social row — by the time a reader got to the number it
  // had stopped being news. What was cut was the PROSE, not the destinations:
  // the Dexvra link row stays complete. {percent}, {name} and {chain} stay
  // available.
  post_pump:
    `{chainEmoji} **{symbol}** ${em("🚀", E.rocket)} **{multiple}** since listing\n` +
    `[{coinUrlLabel}]({coinUrl})\n\n` +
    // Labelled, so the two numbers read as a market-cap move and not as a
    // price, a range, or a target.
    `${em("📊", E.chart)} **Market cap:** {firstMc} → {lastMc}\n\n` +
    `${em("📄", E.clip)} **CA**\n` +
    "`{address}`\n\n" +
    // The pump alert's own tweet (a QUOTE of the token's listing tweet), so the
    // channel post and the X post point at each other. Drops when there is none.
    `[Announce On X 𝕏]({xUrl})\n\n` +
    LINKS_ROW,
  // Per-TIER badge shown beside the header on a listing post ("New Listing on
  // Dexvra · 💎 Diamond tier"). Same shape as chain_emojis: one `tier = emoji`
  // per line. Send a PREMIUM emoji here and the badge animates in the channel —
  // that is the whole point of it being a template rather than code.
  // A tier missing from this list falls back to the emoji in config/packages.js.
  tier_emojis:
    "diamond = 💎\n" +
    "gold = 🥇\n" +
    "platinum = 🏆\n" +
    "silver = 🥈\n" +
    "bronze = 🥉\n" +
    "xpress = ⚡",
  // Per-network emoji the bot AUTO-PICKS for the "Chain:" line from the token's
  // chain. One `chainid = emoji` per line; unknown chains fall back to 💠.
  // Edit an emoji to rebrand a network everywhere at once.
  chain_emojis:
    "solana = 🟣\n" +
    "ethereum = 🔷\n" +
    "bsc = 🟡\n" +
    "base = 🔵\n" +
    "robinhood = 🪶\n" +
    "tron = 🔴\n" +
    "ton = 🔹\n" +
    "sui = 💧\n" +
    "plasma = 🟢",

  // ── X / Twitter posts (PLAIN TEXT — X has no markdown; keep under ~280
  //    chars: a URL counts as 23, each emoji ~2). Footer order Listing →
  //    Trending → Announcement. Posted on a successful listing/trending order. ──
  x_listing:
    "⚡ New Listing on Dexvra\n\n" +
    "{name} ( ${tag} ){mention}\n" +
    "{url}\n\n" +
    "CA: {address}\n\n" +
    "Price: {price}  |  MC: {mcap}\n\n" +
    "#Dexvra #NewListing #Altcoin #DYOR",
  x_listing_tiered:
    "⚡ New Listing on Dexvra\n\n" +
    "{tierEmoji} {tier} Tier — Trending Now\n\n" +
    "{name} ( ${tag} ){mention}\n" +
    "{url}\n\n" +
    "CA: {address}\n\n" +
    "Price: {price}  |  MC: {mcap}\n\n" +
    "#Dexvra #NewListing #Altcoin #DYOR",
  x_trending:
    "🔥 {symbol} is now Trending on Dexvra!\n\n" +
    "💎 {name}  ·  {chain}\n" +
    "🔗 {url}\n\n" +
    "🌐 dexvra.io | 🚨 Listing | 🔥 Trending | 📢 Announcement\n" +
    "#Dexvra #Trending #{tag} #DYOR",
  // Posted as a QUOTE of the token's original listing tweet (the listing card
  // shows below), so this text stays short and focused on the pump news.
  x_pump:
    "🚀 Pump Alert — ${tag} on Dexvra\n\n" +
    "{name}{mention} is up +{percent}% since it listed on Dexvra.\n\n" +
    "MC: {firstMc} → {lastMc}\n" +
    "{url}\n\n" +
    "#Dexvra #Pump #Altcoin #DYOR",
  // Also a QUOTE of the listing tweet — the token's own card underneath is what
  // makes "climbed to #2" mean anything. {gain} is "+42%" or empty when the
  // reading was absurd/negative, so keep it on its own segment.
  x_rankup:
    "📈 Rank Up — ${tag} is #{rank} on Dexvra Trending\n\n" +
    "{name}{mention} {gain} (24h)\n" +
    "{url}\n\n" +
    "#Dexvra #Trending #{tag} #DYOR",
  // Banner ads. Was hardcoded in twitter.js and ignored the editor entirely —
  // an advertiser's announcement is exactly the copy an operator wants to tune.
  x_banner:
    "📢 Banner Live on Dexvra\n\n" +
    "{title}{mention} is now featured on {handle}\n" +
    "{url}\n\n" +
    "#Dexvra #Ad",
  // The daily Top Gainers board. {list} is built by gainers.js as PLAIN text
  // (X has no markdown and no custom emoji) — one ranked line per token.
  x_gainers:
    "📈 TOP GAINERS ON DEXVRA\n" +
    "{date}\n\n" +
    "{list}\n\n" +
    "Ranked by 24h change across every token listed on Dexvra.\n" +
    "{site}\n\n" +
    "#Dexvra #TopGainers #Altcoin #DYOR",
};

// ── Editor metadata: groups + placeholder hints ──────────────────────────────
const META = {
  welcome: { group: "Bot Messages", label: "Welcome / Start", ph: ["site", "announce", "listing", "trending", "xlisting"] },
  intro_xpress: { group: "Bot Messages", label: "Intro: Xpress Listing", ph: ["site", "listing", "trending", "announce", "xlisting"] },
  intro_tiered: { group: "Bot Messages", label: "Intro: Listing & Trending", ph: ["site", "listing", "trending", "announce", "xlisting"] },
  tier_chooser: { group: "Bot Messages", label: "Tier chooser", ph: ["native", "site", "listing", "trending", "announce", "xlisting"] },
  trending_durations: { group: "Bot Messages", label: "Trending: duration picker", ph: ["symbol", "chain", "native", "site", "listing", "trending", "announce", "xlisting"] },
  intro_banner: { group: "Bot Messages", label: "Intro: Banner Ads", ph: ["site", "listing", "trending", "announce", "xlisting"] },
  listing_ca_prompt: { group: "Bot Messages", label: "Prompt: contract address", ph: ["chain"] },
  listing_name_prompt: { group: "Bot Messages", label: "Prompt: token name", ph: [] },
  listing_symbol_prompt: { group: "Bot Messages", label: "Prompt: token symbol", ph: [] },
  listing_logo_prompt: { group: "Bot Messages", label: "Prompt: logo", ph: [] },
  trending_ca_prompt: { group: "Bot Messages", label: "Prompt: trending CA", ph: ["site", "listing", "trending", "announce", "xlisting"] },
  already_listed: { group: "Bot Messages", label: "Listing: token already listed", ph: ["name", "symbol", "chain", "address", "url", "site", "listing", "trending", "announce", "xlisting"] },
  trending_not_found: { group: "Bot Messages", label: "Trending: token not listed", ph: [] },
  review_card: { group: "Bot Messages", label: "Listing review card", ph: ["chain", "name", "symbol", "address", "logo", "overview", "website", "twitter", "telegram"] },
  edit_field_prompt: { group: "Bot Messages", label: "Edit-field prompt", ph: ["field"] },
  invalid_address: { group: "Bot Messages", label: "Error: invalid address", ph: ["chain"] },
  invalid_url: { group: "Bot Messages", label: "Error: invalid URL", ph: [] },
  invalid_ticker: { group: "Bot Messages", label: "Error: invalid ticker", ph: [] },
  listing_incomplete: { group: "Bot Messages", label: "Error: listing incomplete", ph: [] },
  pricing_unavailable: { group: "Bot Messages", label: "Error: pricing unavailable", ph: [] },
  session_expired: { group: "Bot Messages", label: "Error: session expired", ph: [] },
  error_retry: { group: "Bot Messages", label: "Error: try again", ph: [] },
  trending_service_down: { group: "Bot Messages", label: "Error: listings service down", ph: [] },
  banner_duration_prompt: { group: "Bot Messages", label: "Banner: duration picker", ph: ["name", "size"] },
  banner_image_prompt: { group: "Bot Messages", label: "Banner: image prompt", ph: ["size", "size2x"] },
  banner_link_prompt: { group: "Bot Messages", label: "Banner: link prompt", ph: [] },
  banner_title_prompt: { group: "Bot Messages", label: "Banner: title prompt", ph: [] },
  banner_desc_prompt: { group: "Bot Messages", label: "Banner: description prompt", ph: [] },
  banner_ca_prompt: { group: "Bot Messages", label: "Banner: contract prompt", ph: [] },
  banner_socials_prompt: { group: "Bot Messages", label: "Banner: socials prompt", ph: [] },
  banner_pay_prompt: { group: "Bot Messages", label: "Banner: pay-method picker", ph: ["slot", "size", "duration", "usd"] },
  price_feed_down: { group: "Bot Messages", label: "Error: price feed down", ph: [] },
  checking_payment: { group: "Bot Messages", label: "Payment: checking", ph: ["chain", "amount", "native"] },
  still_checking: { group: "Bot Messages", label: "Payment: still checking", ph: [] },
  no_pending_payment: { group: "Bot Messages", label: "Payment: none pending", ph: [] },
  pay_card: { group: "Bot Messages", label: "Payment card", ph: ["label", "amount", "native", "address"] },
  pay_card_admin: { group: "Bot Messages", label: "Payment card (admin free)", ph: ["label"] },
  payment_not_detected: { group: "Bot Messages", label: "Payment not detected", ph: ["amount", "native", "address", "order"] },
  payment_snag: { group: "Bot Messages", label: "Payment snag", ph: ["order"] },
  success_listing: { group: "Bot Messages", label: "Success: Xpress listing", ph: ["symbol", "name", "siteUrl", "listingUrl", "xUrl", "postLinks", "announceX", "site", "listing", "trending", "announce", "xlisting"] },
  success_listing_tiered: { group: "Bot Messages", label: "Success: Listing & Trending", ph: ["symbol", "name", "tier", "tierEmoji", "hours", "siteUrl", "listingUrl", "xUrl", "announceUrl", "trendingUrl", "postLinks", "announceX", "site", "listing", "trending", "announce", "xlisting"] },
  success_trending: { group: "Bot Messages", label: "Success: trending", ph: ["symbol", "hours", "siteUrl", "trendingUrl", "announceUrl", "xUrl", "postLinks", "announceX", "site", "listing", "trending", "announce", "xlisting"] },
  success_banner: { group: "Bot Messages", label: "Success: banner", ph: ["slot", "startsAt", "endsAt", "queueNote", "postLinks", "announceX", "site", "listing", "trending", "announce", "xlisting"] },
  upsell_expiry: { group: "Bot Messages", label: "Upsell: trending slot ending", ph: ["symbol", "hours", "discount"] },
  group_added: { group: "Group Setup", label: "Group: posted the moment the bot is added", ph: ["bot", "site", "listing", "trending", "announce", "xlisting"] },
  group_start: { group: "Group Setup", label: "Group: /start inside a group", ph: ["bot", "site", "listing", "trending", "announce", "xlisting"] },
  buybot_help: { group: "Group Buy Bot", label: "Group tools: how-to (main menu)", ph: ["bot", "site", "listing", "trending", "announce", "xlisting"] },
  group_buy_alert: { group: "Group Buy Bot", label: "Group: buy alert (verified txn)", ph: ["bar", "emoji", "name", "nameRow", "tier", "symbol", "usd", "native", "tokenAmt", "price", "mcap", "liq", "impact", "change", "chain", "verify", "wallet", "holds", "holdsUsd", "position", "tradeUrl", "coinUrl", "chartUrl"] },
  group_start_buttons: { group: "Group Buy Bot", label: "Group welcome buttons (buybot|raid|settings|listing|channel)", ph: [] },
  group_buy_style: { group: "Group Buy Bot", label: "Buy size icons (buy|whale)", ph: [] },
  group_whale_alert: { group: "Group Buy Bot", label: "Group: WHALE WALLET alert (pinned)", ph: ["bar", "emoji", "name", "nameRow", "symbol", "usd", "native", "tokenAmt", "holds", "holdsUsd", "position", "whaleBar", "price", "mcap", "liq", "change", "chain", "verify", "tradeUrl", "coinUrl", "chartUrl"] },
  group_buy_tiers: { group: "Group Buy Bot", label: "Buy tiers (normal|whale|mega)", ph: [] },
  // Own category: 22 setup replies stacked into "Group Buy Bot" would bury the
  // alert cards, which are what an operator actually opens this editor for.
  setup_admin_only: { group: "Group Setup", label: "Error: group admins only", ph: [] },
  setup_group_only: { group: "Group Setup", label: "Error: run it in a group", ph: [] },
  settoken_prompt: { group: "Group Setup", label: "/settoken — paste prompt", ph: [] },
  settoken_resolving: { group: "Group Setup", label: "/settoken — looking it up", ph: [] },
  settoken_not_found: { group: "Group Setup", label: "/settoken — no pool found", ph: [] },
  settoken_ok: {
    group: "Group Setup",
    label: "/settoken — live ✅",
    ph: ["chain", "name", "symbol", "address", "minBuy", "whale"],
  },
  setchain_unknown: { group: "Group Setup", label: "/setchain — unknown network", ph: ["chains"] },
  setchain_need_token: { group: "Group Setup", label: "/setchain — set the token first", ph: [] },
  setchain_ok: { group: "Group Setup", label: "/setchain — done", ph: ["chain"] },
  setchain_ok_nopool: { group: "Group Setup", label: "/setchain — done, no pool yet", ph: ["chain"] },
  setminbuy_panel: { group: "Group Setup", label: "/setminbuy — picker", ph: ["usd"] },
  setminbuy_usage: { group: "Group Setup", label: "/setminbuy — not an amount", ph: [] },
  setminbuy_ok: { group: "Group Setup", label: "/setminbuy — done", ph: ["usd"] },
  setminbuy_min: { group: "Group Setup", label: "/setminbuy — below the floor", ph: ["usd"] },
  setminbuy_toast: { group: "Group Setup", label: "/setminbuy — button toast", ph: ["usd"] },
  setwhale_panel: { group: "Group Setup", label: "/setwhale — picker", ph: ["usd", "chain", "unsupported"] },
  setwhale_toast: { group: "Group Setup", label: "/setwhale — button toast", ph: ["usd"] },
  setwhale_state_off: { group: "Group Setup", label: "Whale bar — the word for off", ph: [] },
  setwhale_usage: { group: "Group Setup", label: "/setwhale — not an amount", ph: [] },
  setwhale_ok: { group: "Group Setup", label: "/setwhale — done", ph: ["usd", "chain", "unsupported"] },
  setwhale_unsupported: { group: "Group Setup", label: "/setwhale — chain can't be read", ph: ["chain"] },
  setwhale_off: { group: "Group Setup", label: "/setwhale off", ph: [] },
  pin_on: { group: "Group Setup", label: "/buybot pin on", ph: [] },
  pin_off: { group: "Group Setup", label: "/buybot pin off", ph: [] },
  buybot_on: { group: "Group Setup", label: "/buybot on", ph: [] },
  buybot_off: { group: "Group Setup", label: "/buybot off", ph: [] },
  buybot_need_token: { group: "Group Setup", label: "/buybot — not set up yet", ph: [] },
  buybot_status: { group: "Group Setup", label: "/buybot — status card", ph: ["address", "chain", "pool", "minBuy", "whale", "pin", "state"] },
  raid_card: { group: "Dexvra Raid", label: "Raid: live card", ph: ["seq", "percent", "left", "crew", "roster", "progress", "url", "post", "updated", "note"] },
  raid_complete: { group: "Dexvra Raid", label: "Raid: all targets hit", ph: ["seq", "percent", "crew", "roster", "progress", "url", "post", "updated"] },
  raid_expired: { group: "Dexvra Raid", label: "Raid: time ran out", ph: ["seq", "percent", "crew", "progress", "url", "post", "updated"] },
  raid_cancelled: { group: "Dexvra Raid", label: "Raid: stopped by an admin", ph: ["seq", "percent", "progress", "url", "post", "updated"] },
  raid_complete_note: { group: "Dexvra Raid", label: "Raid: shout when it clears", ph: ["crew", "url"] },
  raid_style: { group: "Dexvra Raid", label: "Raid bar style (likes|replies|reposts|crew|filled|empty)", ph: [] },
  raid_panel: { group: "Dexvra Raid", label: "Raid: setup panel (/raid)", ph: ["post", "goals", "lock", "record", "maxMinutes", "sources"] },
  raid_panel_record: { group: "Dexvra Raid", label: "Raid panel: group record line", ph: ["started", "completed"] },
  raid_sources_none: { group: "Dexvra Raid", label: "Raid panel: no X key at all", ph: [] },
  raid_sources_partial: { group: "Dexvra Raid", label: "Raid panel: no paid X key", ph: [] },
  raid_group_only: { group: "Dexvra Raid", label: "Error: raids run in a group", ph: [] },
  raid_admin_only: { group: "Dexvra Raid", label: "Error: group admins only", ph: [] },
  raid_seturl_prompt: { group: "Dexvra Raid", label: "Raid: ask for the X post link", ph: [] },
  raid_bad_url: { group: "Dexvra Raid", label: "Raid: that isn't an X post link", ph: [] },
  raid_none_running: { group: "Dexvra Raid", label: "Raid: nothing running here", ph: [] },
  raid_already_running: { group: "Dexvra Raid", label: "Launch refused: one already running", ph: [] },
  raid_already_launching: { group: "Dexvra Raid", label: "Launch refused: already launching", ph: [] },
  raid_bad_post: { group: "Dexvra Raid", label: "Launch refused: bad post link", ph: [] },
  raid_no_goals: { group: "Dexvra Raid", label: "Launch refused: no goals set", ph: [] },
  raid_reposts_only: { group: "Dexvra Raid", label: "Launch refused: reposts need a paid key", ph: [] },
  massdm_disabled: { group: "Mass DM", label: "Mass DM: disabled", ph: [] },
  massdm_intro: { group: "Mass DM", label: "Mass DM: intro + price (ask CA)", ph: ["sol", "bnb", "eth"] },
  massdm_ca_invalid: { group: "Mass DM", label: "Mass DM: invalid CA", ph: [] },
  massdm_compose_prompt: { group: "Mass DM", label: "Mass DM: compose prompt", ph: ["chain", "amount"] },
  massdm_preview: { group: "Mass DM", label: "Mass DM: preview / pay", ph: ["amount"] },
  massdm_received: { group: "Mass DM", label: "Mass DM: paid, in review", ph: ["ref"] },
  massdm_enqueue_failed: { group: "Mass DM", label: "Mass DM: enqueue failed", ph: ["ref"] },
  massdm_test_queued: { group: "Mass DM", label: "Mass DM: test queued", ph: [] },
  massdm_done: { group: "Mass DM", label: "Mass DM: delivered receipt", ph: ["ref", "reached"] },
  post_listing_xpress: { group: "Channel Posts", label: "Post: Xpress Listing", ph: ["name", "symbol", "logoEmoji", "coinUrl", "xUrl", "tradeUrl", "chainEmoji", "chain", "address", "liq", "mcap", "price", "twitter", "website", "telegram", "site", "listing", "trending", "announce", "xlisting"] },
  post_listing_tiered: { group: "Channel Posts", label: "Post: Listing & Trending", ph: ["name", "symbol", "logoEmoji", "tierEmoji", "tier", "coinUrl", "xUrl", "tradeUrl", "chainEmoji", "chain", "address", "liq", "mcap", "price", "twitter", "website", "telegram", "site", "listing", "trending", "announce", "xlisting"] },
  post_trending: { group: "Channel Posts", label: "Post: Trending", ph: ["name", "symbol", "logoEmoji", "coinUrl", "xUrl", "tradeUrl", "chainEmoji", "chain", "address", "liq", "mcap", "price", "twitter", "website", "telegram", "site", "listing", "trending", "announce", "xlisting"] },
  post_banner: { group: "Channel Posts", label: "Post: Banner ad", ph: ["title", "slot", "linkUrl", "description", "address", "twitter", "website", "telegram", "xUrl", "site", "listing", "trending", "announce", "xlisting"] },
  post_rankup: { group: "Channel Posts", label: "Post: Rank-up alert", ph: ["chainEmoji", "symbol", "name", "rank", "gain", "change", "address", "coinUrl", "coinUrlLabel", "xUrl", "twitter", "website", "telegram", "site", "listing", "trending", "announce", "xlisting"] },
  post_pump: { group: "Channel Posts", label: "Post: Pump alert", ph: ["chainEmoji", "symbol", "name", "percent", "multiple", "firstMc", "lastMc", "chain", "address", "coinUrl", "coinUrlLabel", "xUrl", "twitter", "website", "telegram", "site", "listing", "trending", "announce", "xlisting"] },
  post_gainers: { group: "Channel Posts", label: "Post: Top Gainers banner", ph: ["date", "list", "count", "xUrl", "site", "listing", "trending", "announce", "xlisting"] },
  tier_emojis: { group: "Channel Posts", label: "Tier badges (Diamond → Bronze)", ph: [] },
  chain_emojis: { group: "Channel Posts", label: "Chain emoji (per network, auto-picked)", ph: [] },
  x_listing: { group: "X Posts", label: "X post: Xpress listing", ph: ["name", "tag", "mention", "url", "address", "price", "mcap", "chain", "handle"] },
  x_listing_tiered: { group: "X Posts", label: "X post: Listing & Trending", ph: ["tierEmoji", "tier", "name", "tag", "mention", "url", "address", "price", "mcap", "chain", "handle"] },
  x_trending: { group: "X Posts", label: "X post: trending", ph: ["symbol", "name", "chain", "url", "tag", "mention", "handle"] },
  x_pump: { group: "X Posts", label: "X post: pump alert", ph: ["tag", "name", "mention", "percent", "firstMc", "lastMc", "url", "handle"] },
  x_rankup: { group: "X Posts", label: "X post: rank-up alert", ph: ["tag", "name", "mention", "rank", "gain", "chain", "url", "handle"] },
  x_banner: { group: "X Posts", label: "X post: banner ad", ph: ["title", "slot", "url", "site", "handle", "mention"] },
  x_gainers: { group: "X Posts", label: "X post: Top Gainers board", ph: ["list", "date", "site", "handle"] },
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
function render(key, vars, opts) {
  const val = loadAll()[key] != null ? loadAll()[key] : DEFAULTS[key] || "";
  return renderValue(val, vars, opts);
}

/**
 * Dexvra's OWN destinations, available to EVERY template without the call site
 * having to pass them: {site} {listing} {trending} {announce} {xlisting} {bot}
 * {botName}. They are constants — the same values on every render — so the only
 * thing threading them through each caller ever achieved was that a template
 * gained a link and then rendered it blank until someone remembered to update
 * the one handler that renders it. An admin can now drop {xlisting} into ANY
 * template from @dexvraadminbot and it resolves, with no deploy.
 *
 * Explicit vars always win, so nothing that passes its own {site} changes.
 * Required lazily: config/constants reads process.env at load time and main.js
 * loads .env before it, an order a top-level require here would break.
 */
function baseVars() {
  try {
    const { SITE_URL, CHANNELS, BOT_USERNAME, X_LISTING_URL } = require("./config/constants");
    const tme = (c) => (String(c || "").startsWith("@") ? `https://t.me/${String(c).slice(1)}` : String(c || ""));
    return {
      site: SITE_URL,
      listing: tme(CHANNELS.listing),
      trending: tme(CHANNELS.trending),
      announce: tme(CHANNELS.announce),
      xlisting: X_LISTING_URL,
      bot: tme(`@${BOT_USERNAME}`),
      botName: `@${String(BOT_USERNAME).replace(/^@/, "")}`,
    };
  } catch {
    return {}; // constants unavailable (a unit test in isolation) — render bare
  }
}

/** Render a RESOLVED template value (markup string or {text, entities}) — the
 *  body of render() without the key lookup. channels/format.js uses it to
 *  render a template AFTER stripping social/tier lines the token lacks. */
function renderValue(rawVal, varsIn, opts) {
  // Dexvra's own links underneath whatever the caller passed (caller wins), so
  // {xlisting} & friends resolve in every template. Applied BEFORE dropEmptyLines
  // so a line carrying only {xlisting} counts as filled and survives.
  const vars = { ...baseVars(), ...(varsIn || {}) };
  // OPT-IN only. A blanket "drop lines whose placeholders are empty" also eats
  // a channel-post header like "🔥 **New Trending on Dexvra** {logoEmoji}" when
  // the token has no emoji — real copy, one empty placeholder. Channel posts do
  // their own, smarter stripping in channels/format.js; this is for the buyer
  // receipts, where every link line is exactly "label: {url}".
  const val = opts && opts.dropEmpty ? dropEmptyLines(rawVal, vars) : rawVal;
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

/**
 * Drop every line whose placeholders ALL resolve to empty.
 *
 * This is what lets a receipt spell its links out as editable lines —
 * "🔔 Dexvra Trending: {trendingUrl}" — instead of hiding them behind one
 * auto-generated {postLinks} blob the operator cannot reword. An Xpress buyer
 * has no announcement and no trending post, so those lines have to disappear
 * completely rather than leave a label pointing at nothing.
 *
 * A line with no placeholders is never touched, and a line keeps its place as
 * long as ONE of its placeholders has a value. Works on both stored shapes: for
 * an admin-pasted {text, entities} template the entity offsets are re-mapped
 * around the removed lines, so premium emoji stay on their characters.
 */
function dropEmptyLines(val, vars) {
  const isEntity = val && typeof val === "object" && val.text != null;
  const text = isEntity ? val.text : String(val || "");
  if (!text.includes("{")) return val;
  const filled = (k) => vars && vars[k] != null && String(vars[k]) !== "";
  const lines = text.split("\n");
  const cuts = []; // [start, end) ranges to remove, in order
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = off;
    off += line.length + 1;
    const keys = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (!keys.length || keys.some(filled)) continue;
    // Take the line's own trailing newline so the gap closes behind it.
    cuts.push([start, i < lines.length - 1 ? start + line.length + 1 : start + line.length]);
  }
  if (!cuts.length) return val;
  // Merge touching/overlapping ranges — the offset maths below assumes disjoint
  // cuts, and two dropped neighbours would otherwise be counted twice.
  const merged = [];
  for (const [a, b] of cuts) {
    const prev = merged[merged.length - 1];
    if (prev && a <= prev[1]) prev[1] = Math.max(prev[1], b);
    else merged.push([a, b]);
  }
  cuts.length = 0;
  cuts.push(...merged);
  // A cut that runs to the end of the text has no newline of its own to take,
  // so it swallows the ones in front of it — including the blank separator that
  // introduced the block. Otherwise a receipt whose whole link block is empty
  // ends on dangling blank lines.
  const last = cuts[cuts.length - 1];
  if (last[1] === text.length) {
    const floor = cuts.length > 1 ? cuts[cuts.length - 2][1] : 0;
    while (last[0] > floor && text[last[0] - 1] === "\n") last[0]--;
  }
  const cut = (s) => cuts.reduceRight((acc, [a, b]) => acc.slice(0, a) + acc.slice(b), s);
  if (!isEntity) return cut(text);
  const removedBefore = (pos) => cuts.reduce((n, [a, b]) => (b <= pos ? n + (b - a) : n), 0);
  const inCut = (pos) => cuts.some(([a, b]) => pos >= a && pos < b);
  const entities = (val.entities || [])
    .filter((e) => !inCut(e.offset))
    .map((e) => ({ ...e, offset: e.offset - removedBefore(e.offset) }));
  return { ...val, text: cut(text), entities };
}

/**
 * A template's RAW MARKUP with its placeholders filled — for splicing one
 * template into another as a placeholder value.
 *
 * NOT t(), which strips the markup: a spliced-in fragment carrying a [link] or
 * **bold** would reach the reader as plain text, because the outer template is
 * parsed AFTER substitution and there is nothing left to parse. NOT render()
 * either — that returns a parsed payload whose entities the outer parse cannot
 * re-absorb.
 *
 * Base vars are applied here too, since the value is substituted into the outer
 * template as opaque text and the outer pass never re-scans it: a {bot} left
 * inside the fragment would reach the group as the literal characters "{bot}".
 *
 * Limitation, and it is why this is only used for short fragments: a template an
 * admin saved WITH premium-emoji entities contributes its text only — the custom
 * emoji are dropped, because their offsets cannot be remapped into the host.
 */
function markup(key, vars) {
  const all = loadAll();
  const val = all[key] != null ? all[key] : DEFAULTS[key] || "";
  const text = val && typeof val === "object" && val.text != null ? val.text : String(val);
  return substitute(text, { ...baseVars(), ...(vars || {}) });
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
// ── Per-emoji editing ───────────────────────────────────────────────────────
// Editing a template means re-sending the WHOLE message, which is fine for
// rewording but absurd for swapping one emoji in a 12-line welcome card. These
// two functions let the admin bot list the emoji in a template and replace ONE
// of them in place — keeping every other character, and every other entity,
// exactly where it was.
//
// A template value comes in two shapes and both are handled here:
//   • markup string (all DEFAULTS)  — a premium emoji is "[😀](emoji/123)"
//   • {text, entities} (admin paste) — a premium emoji is a custom_emoji entity
//     over its fallback char, so replacing text in the middle means re-mapping
//     every entity offset after the cut.
const EMOJI_RE =
  /(?:\p{RI}\p{RI}|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*|[0-9#*]\uFE0F?\u20E3)/gu;
const PREMIUM_FRAG_RE = /\[([^\]\n]+)\]\(emoji\/(\d+)\)/g;

/** Parse a replacement the admin sent: "😀" or "[😀](emoji/123)". */
function parseFragment(fragment) {
  const f = String(fragment || "").trim();
  const m = /^\[([^\]\n]+)\]\(emoji\/(\d+)\)$/.exec(f);
  return m ? { char: m[1], id: m[2] } : { char: f, id: null };
}

/**
 * Every emoji in a template, in reading order:
 *   { i, char, id, start, end }   — id set only for premium ones
 * `start`/`end` index into the RAW value (markup string or entity text), which
 * is what replaceEmojiAt() splices.
 */
function listEmojis(key) {
  const val = getRawValue(key);
  const isEntity = val && typeof val === "object" && val.text != null;
  const text = isEntity ? val.text : String(val || "");
  const out = [];
  if (!isEntity) {
    // Premium fragments first — they own their whole "[char](emoji/id)" span,
    // so the plain scan below must not also match the char inside them.
    const taken = [];
    PREMIUM_FRAG_RE.lastIndex = 0;
    for (let m; (m = PREMIUM_FRAG_RE.exec(text)); ) {
      out.push({ char: m[1], id: m[2], start: m.index, end: m.index + m[0].length });
      taken.push([m.index, m.index + m[0].length]);
    }
    EMOJI_RE.lastIndex = 0;
    for (let m; (m = EMOJI_RE.exec(text)); ) {
      const at = m.index;
      if (taken.some(([a, b]) => at >= a && at < b)) continue;
      out.push({ char: m[0], id: null, start: at, end: at + m[0].length });
    }
  } else {
    const ce = (val.entities || []).filter((e) => e.type === "custom_emoji");
    EMOJI_RE.lastIndex = 0;
    for (let m; (m = EMOJI_RE.exec(text)); ) {
      const at = m.index;
      const hit = ce.find((e) => e.offset === at);
      out.push({ char: m[0], id: hit ? hit.custom_emoji_id : null, start: at, end: at + m[0].length });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out.map((e, i) => ({ i, ...e }));
}

/**
 * Replace emoji #i with `fragment` and persist. Returns the emoji list after
 * the change, so the caller can redraw its keyboard.
 */
async function replaceEmojiAt(key, i, fragment) {
  const list = listEmojis(key);
  const target = list[i];
  if (!target) throw new Error(`no emoji #${i + 1} in this template`);
  const { char, id } = parseFragment(fragment);
  if (!char) throw new Error("send a single emoji");
  const val = getRawValue(key);
  const isEntity = val && typeof val === "object" && val.text != null;

  if (!isEntity) {
    const text = String(val || "");
    const replacement = id ? `[${char}](emoji/${id})` : char;
    await setTemplate(key, text.slice(0, target.start) + replacement + text.slice(target.end));
    return listEmojis(key);
  }

  // Entity form: splice the text, then move every entity that sits after the
  // cut and stretch every entity that CONTAINS it. Getting this wrong slides
  // premium emoji onto the wrong characters — the bug this whole file guards.
  const text = val.text;
  const delta = char.length - (target.end - target.start);
  const next = [];
  for (const e of val.entities || []) {
    const end = e.offset + e.length;
    if (e.type === "custom_emoji" && e.offset === target.start && end === target.end) continue; // the old one
    if (end <= target.start) next.push({ ...e });
    else if (e.offset >= target.end) next.push({ ...e, offset: e.offset + delta });
    else next.push({ ...e, length: Math.max(0, e.length + delta) }); // spans the cut
  }
  if (id) next.push({ type: "custom_emoji", offset: target.start, length: char.length, custom_emoji_id: id });
  next.sort((a, b) => a.offset - b.offset);
  await setTemplate(key, {
    text: text.slice(0, target.start) + char + text.slice(target.end),
    entities: next,
  });
  return listEmojis(key);
}

function isCustom(key) {
  return loadJSONSync(FILE, {})[key] != null;
}
/** Number of admin-saved overrides on disk — INCLUDING orphaned keys from
 *  older template generations (keys that no longer exist in DEFAULTS). The
 *  reset-all flow must offer to clear those too, or a data file holding only
 *  stale keys reads as "nothing to reset" while the file is not empty. */
function overrideCount() {
  return Object.keys(loadJSONSync(FILE, {})).length;
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
  markup,
  render,
  renderValue,
  SOCIALS_BLOCK,
  FOOTER_BLOCK,
  getRaw,
  getRawValue,
  listEmojis,
  replaceEmojiAt,
  isCustom,
  overrideCount,
  setTemplate,
  resetTemplate,
  resetAllTemplates,
  keys,
  meta,
  groups,
  substitute,
  dropEmptyLines,
  DEFAULTS,
  BANNER_PATH,
  EMOJI: E,
  em,
};
