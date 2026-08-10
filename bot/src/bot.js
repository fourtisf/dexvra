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
  ERROR_CHANNEL,
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

// What the "/" menu offers INSIDE a group. Telegram scopes command lists, and
// the default scope was the only one ever set — so a project that added the bot
// to their group got start/home/help and no hint that /settoken, /setwhale or
// /raid existed. They had to be read off a welcome message and typed from
// memory. Every command here is registered in handlers/registry.js; a command
// listed and not registered is worse than one that is missing, because tapping
// it does nothing at all.
const GROUP_COMMANDS = [
  { command: "start", description: "Set up Dexvra in this group" },
  { command: "settoken", description: "Point the buy bot at your token — paste the CA" },
  { command: "setchain", description: "Force the network — /setchain bsc" },
  { command: "setminbuy", description: "Minimum buy worth an alert — tap to pick" },
  { command: "setwhale", description: "Whale wallet bar — tap to pick" },
  { command: "buybot", description: "Settings — token, min buy, whale, on/off" },
  { command: "raid", description: "Rally the chat behind one X post" },
];

/**
 * Publish both lists.
 *
 * The group scope is set FIRST and its failure is not fatal: an older Bot API
 * or a revoked scope must not cost the default list, which is the one every DM
 * user sees. Both go through the same retry, because one transient timeout used
 * to leave the menu unset for the whole process lifetime.
 */
async function publishCommands(bot) {
  await bot.telegram
    .setMyCommands(GROUP_COMMANDS, { scope: { type: "all_group_chats" } })
    .then(() => log.info(`[start] group command menu published (${GROUP_COMMANDS.length} commands)`))
    .catch((e) => log.warn(`[start] group setMyCommands failed: ${e.message} — groups keep the default list`));
  return setCommandsWithRetry(bot);
}

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
    // Keep it converged, not just converged once. Each save mirrors
    // fire-and-forget, so a Mongo blip leaves that store unmirrored with nothing
    // to notice — and the store most likely to be edited and least likely to be
    // re-saved soon is templates.json, where an admin's premium emoji live.
    require("./helpers/persist").startMirrorSweep();
    await require("./db/jobMirror").restoreAll(); // resume in-flight broadcasts / paid Mass DMs after a VPS reset
    await require("./db/mediaMirror").hydrate(); // restore/seed binary media (banner clips + artwork)
  } catch (e) {
    log.warn(`[start] persist hydrate failed (continuing on local files): ${e && e.message}`);
  }
  // Stores that read their file at MODULE LOAD have to be told the file may
  // have just appeared. Both of these are pulled in through handlers/registry
  // when this module is required — before the line above runs — so on a fresh
  // container, where the Mongo mirror is the only copy, they came up EMPTY and
  // stayed that way until the next restart. For the buy bot that means every
  // configured group silently stops getting alerts; for raids it means a raid
  // that was live when the container was replaced is invisible to the boot
  // sweep, and its group stays LOCKED. Both are silent, so neither shows up as
  // anything but "the bot went quiet".
  try {
    const raids = require("./raid/store").reload();
    const buyGroups = require("./group/config").reload();
    log.info(`[start] stores reloaded after hydrate — ${buyGroups} buy-bot group(s), ${raids} raid record(s)`);
  } catch (e) {
    log.warn(`[start] store reload failed: ${e && e.message}`);
  }
  // Keep the binary-media backup converged with files the web admin panel writes
  // into this shared DATA_DIR (the JSON stores already self-mirror via persist.js).
  require("./db/mediaMirror").startSweep();

  const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 120000 });
  applyMiddleware(bot);
  log.attach(bot, LOG_CHANNEL, ERROR_CHANNEL);
  require("./channels/post").attach(bot.telegram); // channel posts use the bot's Telegram

  // All pre-launch work happens here — in Telegraf v4, launch() only resolves
  // when the bot STOPS, so anything after `await launch()` never runs.
  // Background, retried — polling must not wait on Telegram's command API.
  publishCommands(bot).catch(() => {});

  api.ping().then((ok) => log.info(`[start] internal API reachable: ${ok}`));

  // Banner pipeline health at boot — a silent failure here is why a channel
  // post degrades to the raw token logo (live incident 2026-07-19).
  const bannerTpl = require("./bannerTemplate");
  if (!bannerTpl.postingEnabled()) {
    log.warn("[start] banner posts are OFF — channel posts will use the RAW TOKEN LOGO. Turn them on from @dexvraadminbot → 🎨 Channel Banner Artwork → Banner posts toggle (no .env or restart needed).");
  }
  bannerTpl.selfCheck();

  // X auto-posting health at boot. Same reasoning as the banner check above: the
  // whole X path fails SILENTLY by design (a dead X API must never fail a paid
  // order), so without this line an operator who mistyped one of the four keys
  // sees a perfectly normal-looking bot that simply never tweets. Names the
  // missing variables, and verifies the keys really authenticate — a read-only
  // access token passes every local check and then 403s on the first tweet.
  xSelfCheck();

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

/**
 * Boot-time X / auto-posting diagnostic. Three outcomes, all one line:
 *   • keys missing  → WARN naming exactly which of the four is blank
 *   • keys present  → verify them against the API and log the handle we post as
 *   • forced off    → INFO, so "X_ENABLED=0" never looks like a broken key
 * Fire-and-forget: the network round trip must not delay polling, and a failed
 * check must not stop the bot — X posting is best-effort everywhere else too.
 */
/**
 * Name — at boot, in one line — exactly what this process will tweet.
 *
 * The rule is a product decision: only listings, pump alerts and banner ads go
 * on @dexvralisting. The switches that enforce it default to off, but an
 * EXPLICIT value in .env beats a code default, so a stale `X_RANKUP_ENABLED=1`
 * left over from an earlier setup silently reinstated rank-up tweets — and the
 * only place that was visible was the public timeline, eleven hours later.
 *
 * So the enabled set is printed every boot, and anything beyond the three
 * allowed sources is a WARNING naming the variable to remove. A config value
 * that overrides a product rule must not be able to do it quietly.
 */
function xSourceReport() {
  const c = require("./config/constants");
  const extras = [
    ["Trending Token", "X_TRENDING_ENABLED", c.X_TRENDING_ENABLED],
    ["Top Gainers board", "X_GAINERS_ENABLED", c.X_GAINERS_ENABLED],
    ["rank-up alerts", "X_RANKUP_ENABLED", c.X_RANKUP_ENABLED],
  ].filter(([, , on]) => on);
  const listings = c.X_AUTOLIST_ENABLED ? "listings (paid + free auto)" : "listings (paid only — X_AUTOLIST_ENABLED=0)";
  log.info(`[start] X will tweet: ${listings}, pump alerts, banner ads`);
  for (const [what, envVar] of extras) {
    log.warn(
      `[start] X will ALSO tweet ${what} — ${envVar}=1 in your .env overrides the default. ` +
        `Remove that line (or set it to 0) if only listings, pump alerts and banner ads should be posted.`,
    );
  }
}

function xSelfCheck() {
  const { X_ENABLED, X_LISTING_HANDLE, xMissingKeys, _env } = require("./config/constants");
  const x = require("./twitter");
  // SYNCHRONOUS and unconditional. "What is this process allowed to post?" is a
  // pure config question — it has nothing to do with whether the keys
  // authenticate, and it must not be hidden behind a network round trip. It was,
  // and the line simply didn't appear within the operator's `sleep 6`, which is
  // the same class of failure the report exists to prevent.
  xSourceReport();
  if (!X_ENABLED) {
    const missing = xMissingKeys("listing");
    if (missing.length) {
      log.warn(
        `[start] X auto-posting is OFF — no listing will be tweeted. Missing in .env: ${missing.join(", ")}. ` +
          "All four come from console.x.com → your app → Keys and tokens (OAuth 1.0a), and the access token must be " +
          'generated while the app is set to "Read and write". Verify with: npm run x:check',
      );
    } else if (!_env.bool(process.env.X_ENABLED, true)) {
      log.info("[start] X auto-posting is OFF by config (X_ENABLED=0) — the keys are present.");
    }
    return;
  }
  x.verify("listing")
    .then((res) => {
      if (res.ok) {
        log.info(`[start] X auto-posting ✔ posting as @${res.handle}`);
        if (res.handle.toLowerCase() !== String(X_LISTING_HANDLE).toLowerCase()) {
          log.warn(
            `[start] X account MISMATCH: the keys post as @${res.handle}, but X_LISTING_HANDLE says @${X_LISTING_HANDLE}. ` +
              "Every 'Listing Alerts on X' link in the posts points at X_LISTING_HANDLE — set it to the account the keys belong to.",
          );
        }
        return;
      }
      // A blocked network is not a bad key. Saying "your keys were refused" when
      // the request never left the server costs an operator an afternoon of
      // regenerating credentials that were fine.
      if (res.kind === "network") {
        log.warn(
          `[start] X keys are present but this server cannot reach api.x.com — ${res.message}. ` +
            "Posts will keep failing until egress to api.x.com (and upload.twitter.com for media) is open. Details: npm run x:check",
        );
        return;
      }
      log.warn(
        `[start] X keys are present but the API REFUSED them — nothing will be tweeted. ${res.message}. ` +
          "Details: npm run x:check",
      );
    })
    .catch(() => {});
}

module.exports = {
  startBot,
  applyMiddleware,
  generateSessionKey,
  rateLimitConfig,
  setCommandsWithRetry,
  publishCommands,
  GROUP_COMMANDS,
  COMMANDS,
  onHandlerError,
  xSelfCheck,
  xSourceReport,
};
