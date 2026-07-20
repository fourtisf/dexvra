// Bot bootstrap: middleware chain → handler registration → background services
// → long-polling launch. Mirrors the fourtis boot contract (single-registration
// guard, session key `${from.id}:${chat.id}`, command-exempt rate limiting,
// all pre-launch work before `await launch()`).
const { Telegraf, session } = require("telegraf");
const rateLimit = require("telegraf-ratelimit");
const {
  BOT_TOKEN,
  RATE_WINDOW,
  RATE_LIMIT,
  LOG_CHANNEL,
} = require("./config/constants");
const { registerHandlers } = require("./handlers/registry");
const { setupMonitoring } = require("./services/monitoring");
const api = require("./api/dexvra");
const log = require("./helpers/logger");

let middlewareApplied = false;

const generateSessionKey = (ctx) =>
  ctx.from && ctx.chat ? `${ctx.from.id}:${ctx.chat.id}` : undefined;

const rateLimitConfig = {
  window: RATE_WINDOW,
  limit: RATE_LIMIT,
  keyGenerator: (ctx) => {
    if (!ctx.from) return undefined;
    const t = ctx.message && ctx.message.text;
    if (typeof t === "string" && t.startsWith("/")) return undefined; // commands exempt
    const type = ctx.updateType;
    if (type === "chat_member" || type === "my_chat_member" || type === "chat_join_request") {
      return undefined;
    }
    return `${ctx.from.id}:${ctx.chat ? ctx.chat.id : "?"}`;
  },
  onLimitExceeded: (ctx) => log.debug(`[ratelimit] exceeded ${ctx.from && ctx.from.id}`),
};

function applyMiddleware(bot) {
  if (middlewareApplied) return bot;
  middlewareApplied = true;

  bot.use((ctx, next) => {
    log.debug(`[upd] ${ctx.updateType} chat=${ctx.chat && ctx.chat.id} from=${ctx.from && ctx.from.id}`);
    return next();
  });
  bot.use(session({ getSessionKey: generateSessionKey, defaultSession: () => ({}) }));
  bot.use(rateLimit(rateLimitConfig));

  registerHandlers(bot);
  setupMonitoring(bot);

  bot.catch((err, ctx) =>
    log.error(`[telegraf] ${ctx && ctx.updateType} handler error: ${err && err.message}`),
  );
  return bot;
}

async function startBot() {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set (see .env.example)");

  // Restore/seed state from the Mongo durable mirror BEFORE any handler or
  // service constructs a DedupSet or reads a store (fail-open: no-op without
  // MONGO_URI). Must run before applyMiddleware → registerHandlers.
  try {
    await require("./helpers/persist").hydrate();
    await require("./db/jobMirror").restoreAll(); // resume in-flight broadcasts / paid Mass DMs after a VPS reset
  } catch (e) {
    log.warn(`[start] persist hydrate failed (continuing on local files): ${e && e.message}`);
  }

  const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 120000 });
  applyMiddleware(bot);
  log.attach(bot, LOG_CHANNEL);
  require("./channels/post").attach(bot.telegram); // channel posts use the bot's Telegram

  // All pre-launch work happens here — in Telegraf v4, launch() only resolves
  // when the bot STOPS, so anything after `await launch()` never runs.
  try {
    await bot.telegram.setMyCommands([
      { command: "start", description: "Open the Dexvra menu" },
      { command: "home", description: "Back to the menu" },
      { command: "help", description: "How it works" },
    ]);
  } catch (e) {
    log.warn(`[start] setMyCommands failed: ${e.message}`);
  }

  api.ping().then((ok) => log.info(`[start] internal API reachable: ${ok}`));

  // Banner pipeline health at boot — a silent failure here is why a channel
  // post degrades to the raw token logo (live incident 2026-07-19).
  const bannerTpl = require("./bannerTemplate");
  if (!bannerTpl.postingEnabled()) {
    log.warn("[start] banner posts are OFF — channel posts will use the RAW TOKEN LOGO. Turn them on from @dexvraadminbot → 🎨 Channel Banner Artwork → Banner posts toggle (no .env or restart needed).");
  }
  bannerTpl.selfCheck();

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  log.info("[telegraf] launching (long-polling)…");
  await bot.launch({
    allowedUpdates: [
      "message",
      "edited_message",
      "channel_post",
      "callback_query",
      "my_chat_member",
      "chat_member",
    ],
  });
}

module.exports = { startBot, applyMiddleware, generateSessionKey, rateLimitConfig };
