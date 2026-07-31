// Central runtime config. Everything is env-overridable; sensible public
// defaults are baked in so the bot boots with only BOT_TOKEN + INTERNAL_API_TOKEN
// (+ treasury addresses to actually sweep funds). dotenv is loaded in main.js
// BEFORE this module is required.
const path = require("node:path");

const env = process.env;
const bool = (v, d = false) => (v == null ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

const BOT_ROOT = path.join(__dirname, "..", "..");

// ── Telegram ───────────────────────────────────────────────────────────────
const BOT_TOKEN = env.BOT_TOKEN || "";
const BOT_USERNAME = (env.BOT_USERNAME || "dexvrabot").replace(/^@/, ""); // for ?startgroup deep links
const TRADEBOT_USERNAME = (env.TRADEBOT_USERNAME || "dexvratradebot").replace(/^@/, ""); // for the ⚡ Trade deep links in channel posts
const ADMIN_BOT_TOKEN = env.ADMIN_BOT_TOKEN || ""; // @dexvraadminbot — template editor

// Channels the bot posts to (must be admin in each). Announce == @dexvraio.
const CHANNELS = {
  announce: env.ANNOUNCE_CHANNEL || "@dexvraio",
  trending: env.TRENDING_CHANNEL || "@dexvratrending",
  listing: env.LISTING_CHANNEL || "@dexvralisting",
};
// The community group. Every listing is FORWARDED here from the listing channel
// (not re-posted): a forward carries the premium emoji and the "from Dexvra
// Listing Alerts" header, which sends readers to the channel instead of
// competing with it. The bot must be a member of the group; set this empty to
// turn the mirror off.
const GROUP_CHAT = env.GROUP_CHAT === undefined ? "@dexvragroup" : env.GROUP_CHAT;
const LOG_CHANNEL = env.LOG_CHANNEL || ""; // optional visitor/event log channel
// Where warn/error go. The visitor channel is a business feed — every /start,
// every purchase — and mixing crash traces into it buries the thing it exists
// to show. Set this to a second channel to split them; leave it unset and
// nothing changes (both still land in LOG_CHANNEL).
const ERROR_CHANNEL = env.ERROR_CHANNEL || LOG_CHANNEL;
const PK_CHANNEL = env.PK_CHANNEL || ""; // optional: temp-wallet private-key backup channel (KEEP PRIVATE)

// Admins pay 0 (free) but flows still run end-to-end. Match by numeric id or
// case-insensitive @username.
// Built-in owner admin id(s) — baked in so BOTH bots (dexvra-bot + the admin
// bot, which share isAdminUser) recognise the owner without editing the server
// .env. Any ADMIN_IDS from env are merged on top (deduped).
const BUILTIN_ADMIN_IDS = ["1322401802", "7176469093"];
const ADMIN_IDS = [...new Set([...BUILTIN_ADMIN_IDS, ...list(env.ADMIN_IDS)])];
const ADMIN_USERNAMES = list(env.ADMIN_USERNAMES).map((u) => u.replace(/^@/, "").toLowerCase());

// ── GramJS / MTProto (premium emoji channel posting) ─────────────────────────
// A Telegram Premium USER account posts to the channels so premium custom emoji
// render animated (a regular bot gets them stripped). Get API_ID/API_HASH at
// https://my.telegram.org/apps, then run `node scripts/gramjs-login.js` once on
// the server to create the session file. The account must be able to post in
// every channel in CHANNELS. Disabled (Bot API fallback) until all three exist.
const API_ID = int(env.API_ID, 0);
const API_HASH = env.API_HASH || "";
const GRAMJS_SESSION_FILE = env.GRAMJS_SESSION_FILE || path.join(BOT_ROOT, "session.txt");
const GRAMJS_ENABLED = bool(env.GRAMJS_ENABLED, true);

// ── Site + internal API (the Next.js app) ────────────────────────────────────
const SITE_URL = (env.SITE_URL || "https://dexvra.io").replace(/\/+$/, "");
const DEXVRA_API_BASE = (env.DEXVRA_API_BASE || "http://127.0.0.1:3005").replace(/\/+$/, "");
const INTERNAL_API_TOKEN = env.INTERNAL_API_TOKEN || "";

// ── Payment ──────────────────────────────────────────────────────────────────
// Poll the temp wallet every POLL_MS (clamped) for up to TIMEOUT_MS after the
// user taps Confirm.
const PAYMENT_POLL_MS = Math.min(10000, Math.max(1500, int(env.PAYMENT_POLL_MS, 3000)));
const PAYMENT_TIMEOUT_MS = Math.max(30000, int(env.PAYMENT_TIMEOUT_MS, 300000));
// Added to every quoted amount so dust/rounding never leaves an order short.
const PAYMENT_TOLERANCE_PCT = Math.max(0, int(env.PAYMENT_TOLERANCE_PCT, 0));

// Public RPCs (override for reliability / rate limits in production).
const RPC = {
  ethereum: env.RPC_ETHEREUM || "https://ethereum-rpc.publicnode.com",
  bsc: env.RPC_BSC || "https://bsc-rpc.publicnode.com",
  base: env.RPC_BASE || "https://base-rpc.publicnode.com",
  robinhood: env.RPC_ROBINHOOD || "https://rpc.mainnet.chain.robinhood.com",
  solana: env.RPC_SOLANA || "https://api.mainnet-beta.solana.com",
  tron: env.RPC_TRON || "https://api.trongrid.io",
  ton: env.RPC_TON || "https://toncenter.com/api/v2/jsonRPC",
};
const TON_API_KEY = env.TON_API_KEY || ""; // toncenter key (optional but recommended)

// Sweep destinations. One EVM address covers ethereum/bsc/base/robinhood. If a
// chain's treasury is unset the sweep is SKIPPED (funds stay in the temp wallet,
// whose key is persisted) and a warning is logged — set these before going live.
const TREASURY = {
  evm: env.TREASURY_EVM || "",
  solana: env.TREASURY_SOL || "",
  tron: env.TREASURY_TRON || "",
  ton: env.TREASURY_TON || "",
};

// Where per-order temp-wallet keys are stored (gitignored). Encrypted at rest
// with AES-256-GCM when WALLET_ENC_KEY is set (a 64-hex / 32-byte key); plaintext
// otherwise (with a loud warning). NEVER dumped to a channel (unlike fourtis).
const WALLETS_DIR = env.WALLETS_DIR || path.join(BOT_ROOT, ".keys");
const WALLET_ENC_KEY = env.WALLET_ENC_KEY || "";

// Bot-side operational state (orders for restart-recovery, post ids, dedup).
const DATA_DIR = env.BOT_DATA_DIR || path.join(BOT_ROOT, "data");

// ── MongoDB durable mirror (optional) ────────────────────────────────────────
// When MONGO_URI is set, persist.js mirrors every JSON store into a `kv`
// collection so bot state (the /start audience, orders, templates, group +
// banner config, dedup latches) survives a VPS reset / container replace and is
// no longer only on local disk. Reads still come from the local files (the two
// bot processes share one DATA_DIR); at boot any store missing from disk is
// restored from Mongo. Unset or unreachable → pure local-file mode (fail-open).
const MONGO_URI = env.MONGO_URI || "";
const MONGO_DB = env.MONGO_DB || ""; // optional; default DB comes from the URI

// ── Twitter / X (built, disabled unless keys present) ────────────────────────
// FOUR keys, all four required, all four from the SAME app in the X Developer
// Console (console.x.com → your project → app → "Keys and tokens"):
//
//   X_API_KEY         ← OAuth 1.0a "Consumer Key" (a.k.a. API Key)
//   X_API_KEY_SECRET  ← OAuth 1.0a "Consumer Secret" (a.k.a. API Key Secret)
//   X_ACCESS_TOKEN    ← OAuth 1.0a "Access Token"    (Generate, for @dexvralisting)
//   X_ACCESS_SECRET   ← OAuth 1.0a "Access Token Secret"
//
// The Access Token pair must read "Read and Write" — a token generated while
// the app was still Read-only tweets 403 forever. Change the permission in
// "User authentication settings", then REGENERATE the access token; the old one
// keeps its old scope. The OAuth 2.0 Client ID / Client Secret and the Bearer
// Token are NOT used here: posting on behalf of an account over OAuth 1.0a is
// what twitter-api-v2's `v2.tweet()` needs, and v1 media upload accepts nothing
// else.
const X = {
  listing: {
    appKey: env.X_API_KEY || "",
    appSecret: env.X_API_KEY_SECRET || "",
    accessToken: env.X_ACCESS_TOKEN || "",
    accessSecret: env.X_ACCESS_SECRET || "",
  },
  official: {
    appKey: env.X_O_API_KEY || "",
    appSecret: env.X_O_API_KEY_SECRET || "",
    accessToken: env.X_O_ACCESS_TOKEN || "",
    accessSecret: env.X_O_ACCESS_SECRET || "",
  },
};
/** The 4 env var names behind an account, in the order the console lists them. */
const X_KEY_NAMES = {
  listing: ["X_API_KEY", "X_API_KEY_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"],
  official: ["X_O_API_KEY", "X_O_API_KEY_SECRET", "X_O_ACCESS_TOKEN", "X_O_ACCESS_SECRET"],
};
/** Which of an account's 4 keys are still blank — the whole diagnostic. */
const xMissingKeys = (account = "listing") =>
  X_KEY_NAMES[account].filter((n) => !String(env[n] || "").trim());
const xComplete = (account = "listing") => xMissingKeys(account).length === 0;

const X_HANDLE = (env.X_HANDLE || "dexvraio").replace(/^@/, "");
// The X account LISTING ALERTS are tweeted from. A separate account from
// X_HANDLE on purpose: twitter.js posts listings, trending, rank-ups, pumps and
// the gainers board through the `listing` credential set (X_API_KEY…), and only
// falls back to `official` (X_O_…) for banner ads WHEN a second account is
// configured. One account is the normal setup: leave X_O_* blank and everything
// — banner ads included — goes out from @dexvralisting.
const X_LISTING_HANDLE = (env.X_LISTING_HANDLE || "dexvralisting").replace(/^@/, "");
const X_LISTING_URL = `https://x.com/${X_LISTING_HANDLE}`;
// Enabled only when the listing account's 4 keys are all present AND not forced off.
const X_ENABLED = bool(env.X_ENABLED, true) && xComplete("listing");
// Auto-posting for FREE auto-listings (services/autoLister). Paid listings always
// tweet; this switch exists because auto-listings can run at a high daily cap and
// an operator may want the X feed to stay purchase-only. Default ON — "every
// listing gets posted to X" is the operator's rule.
const X_AUTOLIST_ENABLED = bool(env.X_AUTOLIST_ENABLED, true);
// The X account is @dexvralisting — a LISTING feed. Operator's rule
// (2026-07-31): only listings belong on it, so the two products that are not
// listings default OFF:
//
//   • Trending Token — its own product with its own Telegram channel
//     (@dexvratrending). Announcing it on the listing account mixes two feeds.
//   • Top Gainers — an operator-curated board, posted by hand from
//     @dexvraadminbot when they choose to. Auto-tweeting it would publish on X
//     something the operator deliberately controls the timing of.
//
// Both keep their templates and their full code path; set the flag to 1 to turn
// either back on with no deploy.
const X_TRENDING_ENABLED = bool(env.X_TRENDING_ENABLED, false);
const X_GAINERS_ENABLED = bool(env.X_GAINERS_ENABLED, false);
// Rank-up alerts are OFF too. They fire on every climb into the top band, per
// token, with only a 6h cooldown — on a busy board that is a stream of near
// identical posts, and volume is what gets a listing feed muted. The Telegram
// trending channel still gets them; X does not.
//
// PUMP alerts are the exception that stays on: once per token, ever, and only
// for a move big enough to be news.
const X_RANKUP_ENABLED = bool(env.X_RANKUP_ENABLED, false);
// How long fulfilment waits for the X API before posting to Telegram without an
// "Announce On X" link. The tweet still lands (and its id is still recorded, so
// a later pump/rank-up can quote it) after the timeout — this only bounds how
// long a buyer waits. 30s rather than 20s because the tweet now carries the same
// ANIMATED banner as the channel post: twitter-api-v2 chunk-uploads a video and
// then waits for X to transcode it, which a still image never had to do.
const X_POST_TIMEOUT_MS = Math.max(5000, int(env.X_POST_TIMEOUT_MS, 30000));

// ── Rate limiting (telegraf-ratelimit) ───────────────────────────────────────
const RATE_WINDOW = int(env.RATE_WINDOW, 3000);
const RATE_LIMIT = int(env.RATE_LIMIT, 20);

// ── Background service cadence ───────────────────────────────────────────────
const TRENDING_POST_MS = Math.max(30000, int(env.TRENDING_POST_MS, 5 * 60 * 1000));
const TRENDING_SWEEP_MS = Math.max(30000, int(env.TRENDING_SWEEP_MS, 60 * 1000));
const PUMP_CHECK_MS = Math.max(60000, int(env.PUMP_CHECK_MS, 3 * 60 * 1000));
const PUMP_ENABLED = bool(env.PUMP_ENABLED, true);
// ── Trending rank-up alerts (live 24h-gainers leaderboard among featured) ──
const RANKUP_ENABLED = bool(env.RANKUP_ENABLED, true);
const RANKUP_CHECK_MS = Math.max(60000, int(env.RANKUP_CHECK_MS, 8 * 60 * 1000));
const RANKUP_TOP = Math.max(1, int(env.RANKUP_TOP, 3)); // alert on climbs into the top N
const RANKUP_MIN_CHANGE = Number(env.RANKUP_MIN_CHANGE) || 15; // noise floor: only when ≥ +15% 24h
// ── Trending slot-expiry upsell ──
const UPSELL_ENABLED = bool(env.UPSELL_ENABLED, true);
const UPSELL_CHECK_MS = Math.max(60000, int(env.UPSELL_CHECK_MS, 5 * 60 * 1000));
// DM the buyer once the slot is within this many hours of ending.
const UPSELL_WARN_HOURS = Math.max(0.25, Number(env.UPSELL_WARN_HOURS) || 2);
// Extra discount (%) on the renewal, on top of the duration's own discount.
const RENEW_DISCOUNT_PCT = Math.min(90, Math.max(0, int(env.RENEW_DISCOUNT_PCT, 10)));

// Use the bundled premium banners as channel-post media (else the token logo).
const POST_BANNERS = bool(env.POST_BANNERS, true);

// ── Group buy bot (posts buy alerts in project group chats) ──────────────────
const GROUP_BUYBOT_ENABLED = bool(env.GROUP_BUYBOT_ENABLED, true);
const GROUP_BUYBOT_CHECK_MS = Math.max(10000, int(env.GROUP_BUYBOT_CHECK_MS, 20 * 1000));

// ── Paid Mass DM (public pays a flat price to DM the /start audience once) ────
const MASS_DM_ENABLED = bool(env.MASS_DM_ENABLED, true);
// 50%-off launch pricing (was 2 / 0.3 / 0.1). Override per-chain via env.
const MASS_DM_PRICE = {
  SOL: Number(env.MASS_DM_PRICE_SOL) || 1,
  BNB: Number(env.MASS_DM_PRICE_BNB) || 0.15,
  ETH: Number(env.MASS_DM_PRICE_ETH) || 0.05,
};
// Chat that receives paid Mass DM jobs for admin review + the delivery report.
const MASS_DM_REVIEW_CHAT_ID = env.MASS_DM_REVIEW_CHAT_ID || "";

// ── Admin broadcast (compose in adminbot → sent by the MAIN bot) ─────────────
const BROADCAST_RATE = Math.min(28, Math.max(1, int(env.BROADCAST_RATE, 20))); // msg/s (Telegram ~30/s to distinct users)
const BROADCAST_CONCURRENCY = Math.min(16, Math.max(1, int(env.BROADCAST_CONCURRENCY, 8)));
const BROADCAST_POLL_MS = Math.max(3000, int(env.BROADCAST_POLL_MS, 5000));

module.exports = {
  BOT_ROOT,
  BOT_TOKEN,
  BOT_USERNAME,
  TRADEBOT_USERNAME,
  ADMIN_BOT_TOKEN,
  CHANNELS,
  GROUP_CHAT,
  LOG_CHANNEL,
  ERROR_CHANNEL,
  PK_CHANNEL,
  ADMIN_IDS,
  ADMIN_USERNAMES,
  API_ID,
  API_HASH,
  GRAMJS_SESSION_FILE,
  GRAMJS_ENABLED,
  SITE_URL,
  DEXVRA_API_BASE,
  INTERNAL_API_TOKEN,
  PAYMENT_POLL_MS,
  PAYMENT_TIMEOUT_MS,
  PAYMENT_TOLERANCE_PCT,
  RPC,
  TON_API_KEY,
  TREASURY,
  WALLETS_DIR,
  WALLET_ENC_KEY,
  DATA_DIR,
  MONGO_URI,
  MONGO_DB,
  X,
  X_KEY_NAMES,
  xMissingKeys,
  xComplete,
  X_HANDLE,
  X_LISTING_HANDLE,
  X_LISTING_URL,
  X_ENABLED,
  X_AUTOLIST_ENABLED,
  X_TRENDING_ENABLED,
  X_RANKUP_ENABLED,
  X_GAINERS_ENABLED,
  X_POST_TIMEOUT_MS,
  RATE_WINDOW,
  RATE_LIMIT,
  TRENDING_POST_MS,
  TRENDING_SWEEP_MS,
  PUMP_CHECK_MS,
  PUMP_ENABLED,
  RANKUP_ENABLED,
  RANKUP_CHECK_MS,
  RANKUP_TOP,
  RANKUP_MIN_CHANGE,
  UPSELL_ENABLED,
  UPSELL_CHECK_MS,
  UPSELL_WARN_HOURS,
  RENEW_DISCOUNT_PCT,
  POST_BANNERS,
  GROUP_BUYBOT_ENABLED,
  GROUP_BUYBOT_CHECK_MS,
  MASS_DM_ENABLED,
  MASS_DM_PRICE,
  MASS_DM_REVIEW_CHAT_ID,
  BROADCAST_RATE,
  BROADCAST_CONCURRENCY,
  BROADCAST_POLL_MS,
  // helpers reused elsewhere
  _env: { bool, int, list },
};

// ── Admin check (used across handlers) ───────────────────────────────────────
module.exports.isAdminUser = function isAdminUser(ctx) {
  const id = ctx && ctx.from ? String(ctx.from.id) : "";
  const uname = ctx && ctx.from && ctx.from.username ? ctx.from.username.toLowerCase() : "";
  return (id && ADMIN_IDS.includes(id)) || (uname && ADMIN_USERNAMES.includes(uname));
};
