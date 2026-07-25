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
const tpl = require("./templates");
const { toast } = require("./helpers/message");

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

  bot.catch(onHandlerError);
  return bot;
}

/**
 * What the user gets when a handler throws or hits the 120s handlerTimeout.
 *
 * Logging alone was the old behaviour, and it meant the person who tapped the
 * button saw nothing at all — for real, for two minutes at a time, while this
 * VPS's IPv6 route to Telegram was dead (pm2: "Promise timed out after 120000
 * ms"). Best-effort and never throws: we are already in the failure path, and a
 * second exception here would take the whole update down with it.
 */
async function onHandlerError(err, ctx) {
  log.error(`[telegraf] ${ctx && ctx.updateType} handler error: ${err && err.message}`);
  try {
    if (ctx && ctx.callbackQuery && ctx.answerCbQuery) {
      await ctx.answerCbQuery("Something went wrong — please try again").catch(() => {});
    }
    if (ctx && ctx.chat) await toast(ctx, tpl.render("error_retry"));
  } catch (e) {
    log.debug(`[telegraf] error notice failed: ${e && e.message}`);
  }
}

// Setting the command menu is not worth blocking the boot for, but ONE
// transient failure used to leave it unset for the whole process lifetime —
// pm2 logged "setMyCommands failed: connect ETIMEDOUT …:443" over and over,
// once per restart, and /start never appeared in Telegram's menu. Retried in
// the background with backoff instead.
const COMMANDS = [
  { command: "start", description: "Open the Dexvra menu" },
  { command: "home", description: "Back to the menu" },
  { command: "help", description: "How it works" },
];

async function setCommandsWithRetry(bot, attempts = 4, baseDelay = 5000) {
  for (let i = 0; i < attempts; i++) {
    try {
      await bot.telegram.setMyCommands(COMMANDS);
      if (i) log.info(`[start] setMyCommands ok on attempt ${i + 1}`);
      return true;
    } catch (e) {
      const last = i + 1 >= attempts;
      const wait = baseDelay * 2 ** i;
      log.warn(
        `[start] setMyCommands failed (${i + 1}/${attempts}): ${e.message}` +
          (last ? " — giving up; the command menu keeps its previous value" : ` — retrying in ${wait / 1000}s`),
      );
      if (last) return false;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return false;
}

async function startBot() {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set (see .env.example)");

  // Restore/seed state from the Mongo durable mirror BEFORE any handler or
  // service constructs a DedupSet or reads a store (fail-open: no-op without
  // MONGO_URI). Must run before applyMiddleware → registerHandlers.
  try {
    await require("./helpers/persist").hydrate();
    await require("./db/jobMirror").restoreAll(); // resume in-flight broadcasts / paid Mass DMs after a VPS reset
    await require("./db/mediaMirror").hydrate(); // restore/seed binary media (banner clips + artwork)
  } catch (e) {
    log.warn(`[start] persist hydrate failed (continuing on local files): ${e && e.message}`);
  }
  // Keep the binary-media backup converged with files the web admin panel writes
  // into this shared DATA_DIR (the JSON stores already self-mirror via persist.js).
  require("./db/mediaMirror").startSweep();

  const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 120000 });
  applyMiddleware(bot);
  log.attach(bot, LOG_CHANNEL);
  require("./channels/post").attach(bot.telegram); // channel posts use the bot's Telegram

  // All pre-launch work happens here — in Telegraf v4, launch() only resolves
  // when the bot STOPS, so anything after `await launch()` never runs.
  // Background, retried — polling must not wait on Telegram's command API.
  setCommandsWithRetry(bot).catch(() => {});

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
  // A stray webhook makes getUpdates return 409 forever, so the bot silently stops
  // answering /start (recurring incident). Clear any webhook + drop the backlog of
  // updates that stacked up while it was down. Best-effort — never block startup.
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  } catch (e) {
    log.warn(`[telegraf] deleteWebhook: ${e.message}`);
  }
  await bot
    .launch({
      dropPendingUpdates: true,
      allowedUpdates: [
        "message",
        "edited_message",
        "channel_post",
        "callback_query",
        "my_chat_member",
        "chat_member",
      ],
    })
    .catch((e) => {
      log.error(`[telegraf] launch FAILED (bot will not receive updates): ${e.message}`);
      throw e;
    });
  log.info("[telegraf] polling started ✔");
}

module.exports = {
  startBot,
  applyMiddleware,
  generateSessionKey,
  rateLimitConfig,
  setCommandsWithRetry,
  onHandlerError,
};
