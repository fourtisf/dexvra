// The /raid panel: an admin sets goals, pastes the post, and launches.
//
// Every callback except the crew join is admin-gated. The join is deliberately
// open — it is the one button ordinary members are meant to press.
const store = require("./store");
const runner = require("./runner");
const lock = require("./lock");
const xMetrics = require("./xMetrics");
const card = require("./card");
const { RAID_MAX_MINUTES } = require("../config/constants");
const tpl = require("../templates");
const premium = require("../premium");
const { payloadArgs } = require("../helpers/message");
const log = require("../helpers/logger");

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } };

/** Reply with an admin-editable template. Every prose string in this file goes
 *  through here — the panel is the first thing a project sees of Raid, and it
 *  was the one screen an operator could not reword without a deploy. */
function say(ctx, key, vars) {
  const { text, extra } = payloadArgs(tpl.render(key, vars), false);
  return ctx.reply(text, { ...extra, disable_web_page_preview: true }).catch(() => {});
}

// Each setting cycles through a fixed ladder; 0 means "not tracked". A value
// that isn't in the ladder (an old config, a hand-edited file) yields -1 from
// indexOf and wraps cleanly to the first entry.
const LIKE_STEPS = [5, 10, 15, 25, 50, 100, 0];
const REPLY_STEPS = [2, 5, 10, 25, 50, 0];
const REPOST_STEPS = [0, 2, 5, 10, 25, 50];
const CREW_STEPS = [5, 10, 20, 30, 50, 100, 0];

const nextInCycle = (steps, cur) => steps[(steps.indexOf(cur) + 1) % steps.length];

// How long a "paste the post URL" prompt stays armed. It rides a global text
// handler, so an unbounded wait would eventually eat an unrelated message.
const STEP_TTL_MS = 10 * 60 * 1000;

// Deliberately NOT ctx.session.
//
// handleText runs for EVERY text message in every group the bot is in, and
// Telegraf's session middleware marks a context dirty on any READ, then writes
// it back to a MemorySessionStore whose ttl is Infinity. Touching session here
// would mint a permanent `${userId}:${chatId}` → {} entry for every member who
// ever says anything in any group — none of whom have a flow open. Nothing else
// in the bot reads session for group traffic. A small keyed map with an explicit
// expiry costs nothing and stays bounded.
const awaitingUrl = new Map(); // `${chatId}:${userId}` → armed-at ms
const stepKey = (chatId, userId) => `${chatId}:${userId}`;

function armUrlStep(chatId, userId, at = Date.now()) {
  for (const [k, t] of awaitingUrl) if (at - t > STEP_TTL_MS) awaitingUrl.delete(k);
  awaitingUrl.set(stepKey(chatId, userId), at);
}
const urlStepArmed = (chatId, userId, at = Date.now()) => {
  const t = awaitingUrl.get(stepKey(chatId, userId));
  return !!t && at - t <= STEP_TTL_MS;
};
const clearUrlStep = (chatId, userId) => awaitingUrl.delete(stepKey(chatId, userId));

const isGroup = (ctx) => ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup");

async function isGroupAdmin(ctx) {
  try {
    const { isAdminUser } = require("../config/constants");
    if (isAdminUser(ctx)) return true; // Dexvra staff, for support
    const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return !!m && (m.status === "administrator" || m.status === "creator");
  } catch {
    return false;
  }
}

const fmtTarget = (n) => (n > 0 ? `+${n}` : "off");

/** Name to show on the roster: @handle, else first name, else "anon". Clipped
 *  by CODE POINT — slice() splits a surrogate pair, and Telegram rejects the
 *  result, which crypto display names hit routinely. */
function displayName(from) {
  const raw = from && (from.username ? `@${from.username}` : from.first_name);
  return Array.from(String(raw || "anon")).slice(0, 24).join("");
}

// ── The panel ────────────────────────────────────────────────────────────────

function renderPanel(g) {
  const s = g.settings;
  const sources = xMetrics.sourcesAvailable();
  const live = g.raid && g.raid.status === "running";
  // GENERATED, like the live card's {progress}: the goal rows carry their own
  // live targets and the icons come from raid_style, so they cannot be a flat
  // string in the template. The copy AROUND them is.
  const [likeIcon, replyIcon, repostIcon, crewIcon] = card.raidStyle();
  const goals = [
    `${crewIcon} **Crew** — ${fmtTarget(s.crew)}`,
    `${likeIcon} **Likes** — ${fmtTarget(s.likes)}`,
    `${replyIcon} **Replies** — ${fmtTarget(s.replies)}`,
    `${repostIcon} **Reposts** — ${fmtTarget(s.reposts)}`,
  ].join("\n");
  // Say up front what this install can actually measure, so nobody sets a
  // likes goal and then discovers at launch that nothing can read it.
  const sourceKey =
    !sources.api && !sources.guest && !sources.embed ? "raid_sources_none" : !sources.api && !sources.guest ? "raid_sources_partial" : null;
  const payload = tpl.render("raid_panel", {
    // The URL is admin-supplied and this template is premium markup, so a ")"
    // in it would close a link early and let the rest inject markup into the
    // group's panel.
    post: s.postUrl ? premium.sanitizeVar(s.postUrl) : "not set yet",
    goals,
    lock: s.lockChat ? "on" : "off",
    record: g.stats.started > 0 ? tpl.t("raid_panel_record", { started: g.stats.started, completed: g.stats.completed || 0 }) : "",
    maxMinutes: RAID_MAX_MINUTES,
    sources: sourceKey ? tpl.t(sourceKey) : "",
  });
  const { text, extra } = payloadArgs(payload, false);

  const kb = live
    ? [[{ text: "🛑 Stop raid", callback_data: "dr_stop" }], [{ text: "✖️ Close", callback_data: "dr_close" }]]
    : [
        [
          { text: `🤝 Crew ${fmtTarget(s.crew)}`, callback_data: "dr_crew" },
          { text: `❤️ Likes ${fmtTarget(s.likes)}`, callback_data: "dr_likes" },
        ],
        [
          { text: `💬 Replies ${fmtTarget(s.replies)}`, callback_data: "dr_replies" },
          { text: `🔁 Reposts ${fmtTarget(s.reposts)}`, callback_data: "dr_reposts" },
        ],
        [
          { text: `🔒 Lock chat: ${s.lockChat ? "on" : "off"}`, callback_data: "dr_lock" },
          { text: "🔗 Set post", callback_data: "dr_seturl" },
        ],
        [{ text: "🚀 Launch raid", callback_data: "dr_start" }],
        [{ text: "✖️ Close", callback_data: "dr_close" }],
      ];

  return { text, extra: { ...extra, disable_web_page_preview: true, reply_markup: { inline_keyboard: kb } } };
}

async function showPanel(ctx) {
  if (!isGroup(ctx)) return say(ctx, "raid_group_only");
  if (!(await isGroupAdmin(ctx))) return say(ctx, "raid_admin_only");
  const g = store.getOrCreate(ctx.chat.id, ctx.chat.title || "");
  await store.save();
  const p = renderPanel(g);
  return ctx.reply(p.text, p.extra).catch(() => {});
}

async function refreshPanel(ctx, g) {
  const p = renderPanel(g);
  try {
    await ctx.editMessageText(p.text, p.extra);
  } catch (e) {
    if (!/not modified/i.test((e && e.message) || "")) log.debug(`[raid] panel refresh: ${e && e.message}`);
  }
}

// ── Callbacks ────────────────────────────────────────────────────────────────

async function handleJoin(ctx) {
  if (!isGroup(ctx) || !ctx.from) return ctx.answerCbQuery().catch(() => {});
  const g = store.get(ctx.chat.id);
  if (!g || !g.raid || g.raid.status !== "running") {
    return ctx.answerCbQuery("That raid has already finished.").catch(() => {});
  }
  const added = store.joinCrew(ctx.chat.id, ctx.from.id, displayName(ctx.from));
  if (!added) return ctx.answerCbQuery("You're already counted 🤝").catch(() => {});
  await ctx.answerCbQuery("You're in 🤝 thanks for showing up!").catch(() => {});
  log.info(`[raid] crew join group=${ctx.chat.id} user=${ctx.from.id}`);
  // If that tap finished the raid, celebrate now rather than making the group
  // wait out a poll interval for it.
  if (card.isComplete(g.raid)) return runner.finishRaid(ctx.telegram, g, "completed");
  const rendered = card.renderCard(g.raid, { status: "running" });
  try {
    await ctx.editMessageText(rendered.text, rendered.extra);
  } catch (e) {
    if (!/not modified/i.test((e && e.message) || "")) log.debug(`[raid] card repaint: ${e && e.message}`);
  }
}

async function handleCallback(ctx) {
  const data = (ctx.callbackQuery && ctx.callbackQuery.data) || "";
  if (!data.startsWith("dr_")) return;
  try {
    // The join skips the admin gate — it is the members' button. Checked before
    // anything else so the gate below can stay unconditional.
    if (data === "dr_join") return await handleJoin(ctx);
    if (!isGroup(ctx)) return await ctx.answerCbQuery().catch(() => {});
    if (!(await isGroupAdmin(ctx))) return await ctx.answerCbQuery("Admins only", { show_alert: true }).catch(() => {});

    const g = store.getOrCreate(ctx.chat.id, ctx.chat.title || "");
    const s = g.settings;

    if (data === "dr_close") {
      clearUrlStep(ctx.chat.id, ctx.from && ctx.from.id); // closing the panel ends the wait
      await ctx.answerCbQuery().catch(() => {});
      return ctx.deleteMessage().catch(() => {});
    }
    if (data === "dr_likes") s.likes = nextInCycle(LIKE_STEPS, s.likes);
    else if (data === "dr_replies") s.replies = nextInCycle(REPLY_STEPS, s.replies);
    else if (data === "dr_reposts") s.reposts = nextInCycle(REPOST_STEPS, s.reposts);
    else if (data === "dr_crew") s.crew = nextInCycle(CREW_STEPS, s.crew);
    else if (data === "dr_lock") {
      if (!s.lockChat) {
        // Checked when it is switched ON, not at launch — so an admin doesn't
        // find out it was impossible after telling their group a raid is coming.
        const can = await lock.canLock(ctx.telegram, g.chatId, ctx.chat.type);
        if (!can.ok) return ctx.answerCbQuery(can.reason, { show_alert: true }).catch(() => {});
      }
      s.lockChat = !s.lockChat;
    } else if (data === "dr_seturl") {
      // Scoped to who and where, and it expires: this rides a global text
      // handler, and anything looser would consume an unrelated member's message.
      armUrlStep(ctx.chat.id, ctx.from && ctx.from.id);
      await ctx.answerCbQuery().catch(() => {});
      return say(ctx, "raid_seturl_prompt");
    } else if (data === "dr_start") {
      await ctx.answerCbQuery("Launching…").catch(() => {});
      const res = await runner.startRaid(ctx.telegram, g, { startedBy: ctx.from && ctx.from.id });
      if (!res.ok) return ctx.reply(`❌ ${res.error}`, HTML).catch(() => {});
      // The warning goes to the ADMIN who launched, never onto the members'
      // card — members can't act on it, and it makes a healthy raid look broken.
      if (res.warning) await ctx.reply(res.warning).catch(() => {});
      return refreshPanel(ctx, g);
    } else if (data === "dr_stop") {
      await ctx.answerCbQuery().catch(() => {});
      if (g.raid && g.raid.status === "running") await runner.finishRaid(ctx.telegram, g, "cancelled");
      else await say(ctx, "raid_none_running");
      return refreshPanel(ctx, g);
    }

    await store.save();
    await ctx.answerCbQuery().catch(() => {});
    return refreshPanel(ctx, g);
  } catch (e) {
    log.warn(`[raid] callback failed: ${e && e.message}`);
    // Without this the admin taps a button that does nothing, forever.
    return ctx.answerCbQuery("Something went wrong — try again.", { show_alert: true }).catch(() => {});
  }
}

// ── Message pass-throughs ────────────────────────────────────────────────────

/**
 * Anyone who talks while a raid is live is counted.
 *
 * A button is friction, and the people you most want on the roster are the ones
 * already busy engaging. Three limits keep it cheap and honest: the hot path is
 * a Set lookup because it runs on EVERY group message the bot sees; bots and
 * slash-commands never enrol (so the admin's own /raid doesn't pad the roster);
 * and it NEVER repaints the card — a busy group would trigger an edit per
 * message and burn the group's edit rate limit. The poll picks the count up,
 * because crew size is part of the card signature.
 */
function maybeAutoEnroll(ctx) {
  try {
    if (!isGroup(ctx) || !ctx.from || ctx.from.is_bot) return;
    if (!runner.isRaidActive(ctx.chat.id)) return;
    // Counted as chatter even for members already on the roster: three people
    // talking is exactly when moving the card earns its keep.
    runner.noteChatter(ctx.chat.id);
    const text = (ctx.message && ctx.message.text) || "";
    if (text.startsWith("/")) return;
    if (store.joinCrew(ctx.chat.id, ctx.from.id, displayName(ctx.from))) {
      log.debug(`[raid] auto-enrolled group=${ctx.chat.id} user=${ctx.from.id}`);
    }
  } catch (e) {
    // Never let this break the message pipeline it rides on.
    log.debug(`[raid] auto-enrol: ${e && e.message}`);
  }
}

/** Consume the "paste the post URL" answer. Returns true when it did. */
async function handleText(ctx) {
  maybeAutoEnroll(ctx);
  if (!isGroup(ctx) || !ctx.from) return false;
  if (!urlStepArmed(ctx.chat.id, ctx.from.id)) return false;

  const raw = (ctx.message && ctx.message.text) || "";
  // A COMMAND IS NEVER CONSUMED. This handler is registered before every other
  // command in the bot, so returning true here stops next() and the command
  // never runs: an admin who armed the step and then sent /buybot off got told
  // "that isn't an X post link", and /settoken, /start and /help kept being
  // eaten for the full ten minutes.
  if (raw.startsWith("/")) return false;

  if (!(await isGroupAdmin(ctx))) return false;

  const id = xMetrics.parseTweetId(raw);
  if (!id) {
    await say(ctx, "raid_bad_url");
    return true; // consumed: the admin is still in this step
  }
  clearUrlStep(ctx.chat.id, ctx.from.id);
  const g = store.getOrCreate(ctx.chat.id, ctx.chat.title || "");
  g.settings.postUrl = xMetrics.tweetUrl(id);
  await store.save();
  log.info(`[raid] post set group=${ctx.chat.id} post=${id} by=${ctx.from && ctx.from.id}`);
  const p = renderPanel(g);
  await ctx.reply(p.text, p.extra).catch(() => {});
  return true;
}

module.exports = {
  showPanel,
  renderPanel,
  handleCallback,
  handleJoin,
  handleText,
  maybeAutoEnroll,
  isGroupAdmin,
  displayName,
  nextInCycle,
  fmtTarget,
  armUrlStep,
  urlStepArmed,
  clearUrlStep,
  LIKE_STEPS,
  REPLY_STEPS,
  REPOST_STEPS,
  CREW_STEPS,
  STEP_TTL_MS,
};
