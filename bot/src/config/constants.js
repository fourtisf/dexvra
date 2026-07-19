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
const ADMIN_BOT_TOKEN = env.ADMIN_BOT_TOKEN || ""; // @dexvraadminbot — template editor

// Channels the bot posts to (must be admin in each). Announce == @dexvraio.
const CHANNELS = {
  announce: env.ANNOUNCE_CHANNEL || "@dexvraio",
  trending: env.TRENDING_CHANNEL || "@dexvratrending",
  listing: env.LISTING_CHANNEL || "@dexvralisting",
};
const LOG_CHANNEL = env.LOG_CHANNEL || ""; // optional visitor/event log channel
const PK_CHANNEL = env.PK_CHANNEL || ""; // optional: temp-wallet private-key backup channel (KEEP PRIVATE)

// Admins pay 0 (free) but flows still run end-to-end. Match by numeric id or
// case-insensitive @username.
const ADMIN_IDS = list(env.ADMIN_IDS);
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

// ── Twitter / X (built, disabled unless keys present) ────────────────────────
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
const X_HANDLE = (env.X_HANDLE || "dexvra").replace(/^@/, "");
// Enabled only when the listing account's 4 keys are all present AND not forced off.
const X_ENABLED =
  bool(env.X_ENABLED, true) &&
  Boolean(X.listing.appKey && X.listing.appSecret && X.listing.accessToken && X.listing.accessSecret);

// ── Rate limiting (telegraf-ratelimit) ───────────────────────────────────────
const RATE_WINDOW = int(env.RATE_WINDOW, 3000);
const RATE_LIMIT = int(env.RATE_LIMIT, 20);

// ── Background service cadence ───────────────────────────────────────────────
const TRENDING_POST_MS = Math.max(30000, int(env.TRENDING_POST_MS, 5 * 60 * 1000));
const TRENDING_SWEEP_MS = Math.max(30000, int(env.TRENDING_SWEEP_MS, 60 * 1000));
const PUMP_CHECK_MS = Math.max(60000, int(env.PUMP_CHECK_MS, 3 * 60 * 1000));
const PUMP_ENABLED = bool(env.PUMP_ENABLED, true);

// Use the bundled premium banners as channel-post media (else the token logo).
const POST_BANNERS = bool(env.POST_BANNERS, true);

// ── Admin broadcast (compose in adminbot → sent by the MAIN bot) ─────────────
const BROADCAST_RATE = Math.min(28, Math.max(1, int(env.BROADCAST_RATE, 20))); // msg/s (Telegram ~30/s to distinct users)
const BROADCAST_CONCURRENCY = Math.min(16, Math.max(1, int(env.BROADCAST_CONCURRENCY, 8)));
const BROADCAST_POLL_MS = Math.max(3000, int(env.BROADCAST_POLL_MS, 5000));

module.exports = {
  BOT_ROOT,
  BOT_TOKEN,
  ADMIN_BOT_TOKEN,
  CHANNELS,
  LOG_CHANNEL,
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
  X,
  X_HANDLE,
  X_ENABLED,
  RATE_WINDOW,
  RATE_LIMIT,
  TRENDING_POST_MS,
  TRENDING_SWEEP_MS,
  PUMP_CHECK_MS,
  PUMP_ENABLED,
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
