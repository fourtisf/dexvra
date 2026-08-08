// The raid state machine: start → poll → finish, plus the boot sweep.
//
// finishRaid() IS THE ONLY EXIT DOOR. Completed, expired, stopped and
// boot-recovery all go through it, because it is the function that unlocks the
// chat. A second place that sets `status` without unlocking is exactly how a
// group stays shut after its raid ends.
const {
  RAID_POLL_SEC,
  RAID_MAX_MINUTES,
  RAID_BUMP_MINUTES,
} = require("../config/constants");
const store = require("./store");
const xMetrics = require("./xMetrics");
const lock = require("./lock");
const card = require("./card");
const tpl = require("../templates");
const { payloadArgs } = require("../helpers/message");
const { isFatalChatError } = require("../group/fatalChatError");
const log = require("../helpers/logger");

// Hot path: this is consulted on EVERY group message in EVERY group the bot is
// in, so it must be a Set lookup and never a disk read. Rebuilt from the store
// on each tick, so a raid that outlived a restart starts enrolling again
// without anyone pressing anything.
const activeGroups = new Set();
const chatterSinceBump = new Map(); // chatId → messages since the card last moved
const pinnedByUs = new Set(); // `${chatId}:${messageId}` — see handlePinned
const cantDelete = new Set(); // chatIds we've already warned about once

const isRaidActive = (chatId) => activeGroups.has(String(chatId));

function markActive(chatId, active) {
  const k = String(chatId);
  if (active) activeGroups.add(k);
  else {
    activeGroups.delete(k);
    chatterSinceBump.delete(k);
  }
}

function noteChatter(chatId) {
  const k = String(chatId);
  if (!activeGroups.has(k)) return;
  chatterSinceBump.set(k, (chatterSinceBump.get(k) || 0) + 1);
}

/** "likes:replies:reposts:crew" — what the numbers were when the card last
 *  moved. Persisted, so a restart mid-raid can't fabricate a bump out of the
 *  first poll after boot. */
const countsMark = (raid) => {
  const c = raid.current || {};
  return [c.likes || 0, c.replies || 0, c.reposts || 0, (raid.crew || []).length].join(":");
};

// ── Starting ─────────────────────────────────────────────────────────────────

/**
 * Launch a raid. Returns { ok, error, warning } and NEVER throws — it is called
 * straight from a button tap.
 */
async function startRaid(telegram, g, { startedBy = "" } = {}) {
  const s = g.settings || {};
  if (g.raid && g.raid.status === "running") {
    // Guarded HERE and not only in the panel: a second raid would overwrite the
    // first one's permission snapshot, and the group could then never be
    // restored to how it was before the FIRST lock.
    return { ok: false, error: "A raid is already running in this group." };
  }
  const postId = xMetrics.parseTweetId(s.postUrl);
  if (!postId) return { ok: false, error: "That post link doesn't look right. Paste the full URL of an X post." };

  const wantsX = (s.likes || 0) > 0 || (s.replies || 0) > 0 || (s.reposts || 0) > 0;
  const crewTarget = (s.crew || 0) > 0 ? s.crew : 0;
  if (!wantsX && !crewTarget) return { ok: false, error: "Set at least one goal first." };

  let baseline = { likes: 0, replies: 0, reposts: 0 };
  let target = { likes: 0, replies: 0, reposts: 0 };
  let postText = "";
  let crewOnly = !wantsX; // a crew-only raid never calls X at all
  let xUnavailable = false;
  let pendingX = { likes: 0, replies: 0, reposts: 0 };
  let warning = "";

  if (wantsX) {
    // force: the baseline defines what "+15 likes" MEANS for the whole raid, so
    // it must never come from a cached reading.
    const m = await xMetrics.fetchTweetMetrics(postId, { force: true });
    if (m.ok) {
      // null, not 0: the answering source cannot SEE reposts.
      const seesReposts = m.retweets != null;
      baseline = { likes: m.likes, replies: m.replies, reposts: seesReposts ? m.retweets : 0 };
      target = {
        likes: s.likes > 0 ? baseline.likes + s.likes : baseline.likes,
        replies: s.replies > 0 ? baseline.replies + s.replies : baseline.replies,
        reposts: s.reposts > 0 && seesReposts ? baseline.reposts + s.reposts : baseline.reposts,
      };
      postText = m.text || "";
      if (s.reposts > 0 && !seesReposts) {
        warning =
          "⚠️ Repost tracking needs a paid X API key — that goal was dropped. Every other goal is running.";
        log.warn(`[raid] ${g.chatId} dropped the repost goal — the answering source can't see reposts`);
      }
      const measurable =
        target.likes > baseline.likes || target.replies > baseline.replies || target.reposts > baseline.reposts;
      if (!measurable && !crewTarget) {
        return {
          ok: false,
          error:
            "Reposts are the only goal set, and they can't be counted without a paid X API key.\n\n" +
            "Set a ❤️ Likes, 💬 Replies or 🤝 Crew goal and launch again.",
        };
      }
      if (!measurable) crewOnly = true;
    } else if (crewTarget > 0) {
      // DEGRADE rather than refuse — the crew goal never needed X.
      crewOnly = true;
      xUnavailable = true;
      // Stored as raw DELTAS, not absolute targets: a baseline resolved at
      // minute 10 must mean "fifteen more than minute 10 had", or the group is
      // handed the likes that arrived while we were blind.
      pendingX = { likes: s.likes || 0, replies: s.replies || 0, reposts: s.reposts || 0 };
      warning =
        `⚠️ Launched, but the X counts aren't available yet — ${m.error}.` +
        (m.advice ? `\n${m.advice}` : "") +
        "\n\nThe 🤝 Crew goal is running normally, and the X goals will join in automatically if X starts answering.";
      log.warn(`[raid] ${g.chatId} starting in CREW-ONLY mode: ${m.error}`);
    } else {
      return {
        ok: false,
        error:
          `Can't read that post's numbers — ${m.error}.` +
          (m.advice ? `\n\n${m.advice}` : "") +
          "\n\nYou can still run this raid: set a 🤝 Crew goal and launch without the X counts.",
      };
    }
  }

  const now = Date.now();
  const raid = {
    status: "running",
    seq: (g.stats.started || 0) + 1,
    postId,
    postUrl: xMetrics.tweetUrl(postId),
    postText,
    messageId: 0,
    startedBy: String(startedBy || ""),
    crew: [],
    crewTarget,
    crewOnly,
    xUnavailable,
    pendingX,
    baseline,
    target,
    current: { ...baseline },
    startedAt: now,
    lastPolledAt: now,
    // The DURABLE deadline. The in-memory poll timer dies with the process; a
    // locked group must not.
    expiresAt: now + RAID_MAX_MINUTES * 60000,
    finishedAt: null,
    lastError: "",
    lastBumpAt: now,
    lastBumpMark: "",
    locked: false,
    prevPermissions: null,
  };
  raid.lastBumpMark = countsMark(raid);

  // RECORD BEFORE ACT. The snapshot is taken and written BEFORE the chat is
  // touched, so a crash in between can only leave a record claiming a lock that
  // was never applied — whose eventual "restore" is a no-op. The other ordering
  // leaves a locked group with no record, which no sweep can ever find.
  if (s.lockChat) {
    raid.prevPermissions = await lock.snapshot(telegram, g.chatId);
    raid.locked = true;
  }
  g.raid = raid;
  g.stats.started = (g.stats.started || 0) + 1;
  await store.save();

  if (raid.locked) {
    const res = await lock.applyLock(telegram, g.chatId);
    if (!res.ok) {
      // The raid is the product; the lock is a mode. Run without it — and clear
      // the flag so the finish path doesn't "restore" a lock that never was.
      g.raid.locked = false;
      g.raid.prevPermissions = null;
      await store.save();
      log.warn(`[raid] running ${g.chatId} WITHOUT the chat lock: ${res.error}`);
    }
  }

  const rendered = card.renderCard(g.raid, { now, status: "running" });
  try {
    const sent = await telegram.sendMessage(g.chatId, rendered.text, rendered.extra);
    g.raid.messageId = (sent && sent.message_id) || 0;
    await pinCard(telegram, g.chatId, g.raid.messageId);
    await store.save();
  } catch (e) {
    // A locked group with no card is a silenced chat with no visible reason.
    log.error(`[raid] couldn't post the card in ${g.chatId}: ${e && e.message}`);
    if (g.raid.locked) await lock.unlock(telegram, g.chatId, g.raid.prevPermissions);
    g.raid = { status: "idle" };
    await store.save();
    return { ok: false, error: `Couldn't post the raid card — ${e && e.message}` };
  }

  markActive(g.chatId, true);
  log.info(
    `[raid] started group=${g.chatId} post=${postId} targets=${JSON.stringify(target)} crew=${crewTarget} locked=${g.raid.locked}`,
  );
  return { ok: true, error: null, warning };
}

// ── Card upkeep ──────────────────────────────────────────────────────────────

async function pinCard(telegram, chatId, messageId) {
  if (!messageId) return;
  try {
    await telegram.pinChatMessage(chatId, messageId, { disable_notification: true });
    pinnedByUs.add(`${chatId}:${messageId}`);
  } catch {
    /* pinning is a nicety, never a reason to fail a raid */
  }
}

/**
 * Telegram posts a "X pinned a message" service message on every pin, and
 * because a bump deletes the previous card each notice decays into "pinned
 * Deleted message". An hour-long raid can leave 30 of them.
 *
 * Deletes ONLY ids we pinned ourselves — an admin's own pinned announcement is
 * never touched.
 */
async function handlePinned(ctx) {
  const svc = ctx.message && ctx.message.pinned_message;
  if (!svc || !ctx.chat) return false;
  if (!pinnedByUs.has(`${ctx.chat.id}:${svc.message_id}`)) return false;
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
    return true;
  } catch (e) {
    if (!cantDelete.has(String(ctx.chat.id))) {
      cantDelete.add(String(ctx.chat.id));
      log.warn(
        `[raid] can't tidy the pin notice in ${ctx.chat.id} (${e && e.message}) — ` +
          'give the bot "Delete messages" to keep the chat clean',
      );
    }
    return false;
  }
}

/** Edit the card in place. Swallows "not modified", which is not an error. */
async function editCard(telegram, g, status) {
  if (!g.raid.messageId) return;
  const rendered = card.renderCard(g.raid, { status });
  try {
    await telegram.editMessageText(g.chatId, g.raid.messageId, undefined, rendered.text, rendered.extra);
  } catch (e) {
    if (!/not modified/i.test((e && e.message) || "")) {
      log.debug(`[raid] edit failed in ${g.chatId}: ${e && e.message}`);
    }
  }
}

/**
 * Delete the card and re-send it at the bottom of the chat.
 *
 * The new card is SENT BEFORE the old one is deleted. The reverse ordering
 * leaves the group with no card at all if the send fails — losing the raid's
 * only surface to save one message.
 */
async function bumpCard(telegram, g) {
  const rendered = card.renderCard(g.raid, { status: "running" });
  let sent;
  try {
    sent = await telegram.sendMessage(g.chatId, rendered.text, rendered.extra);
  } catch (e) {
    log.debug(`[raid] bump send failed in ${g.chatId}: ${e && e.message}`);
    return false;
  }
  const old = g.raid.messageId;
  g.raid.messageId = (sent && sent.message_id) || old;
  g.raid.lastBumpAt = Date.now();
  g.raid.lastBumpMark = countsMark(g.raid);
  chatterSinceBump.set(String(g.chatId), 0);
  await store.save();
  if (old && old !== g.raid.messageId) {
    await telegram.deleteMessage(g.chatId, old).catch(() => {});
    pinnedByUs.delete(`${g.chatId}:${old}`);
  }
  await pinCard(telegram, g.chatId, g.raid.messageId);
  log.debug(`[raid] bumped card in ${g.chatId}`);
  return true;
}

// ── Finishing ────────────────────────────────────────────────────────────────

/** The ONLY exit door. status ∈ completed | expired | cancelled. */
async function finishRaid(telegram, g, status) {
  const raid = g.raid;
  if (!raid || raid.status !== "running") return; // idempotent: double-calls are no-ops

  // UNLOCK FIRST, before any status write. A crash in between leaves
  // status:"running" with locked:false — the next sweep re-finishes, and the
  // unlock is idempotent. The other order can strand a locked group.
  if (raid.locked) {
    const res = await lock.unlock(telegram, g.chatId, raid.prevPermissions);
    if (res.ok) {
      raid.locked = false;
      raid.prevPermissions = null;
    }
    // On failure `locked` deliberately stays true so the boot sweep retries.
  }

  markActive(g.chatId, false);
  raid.status = status;
  raid.finishedAt = Date.now();
  if (status === "completed") {
    g.stats.completed = (g.stats.completed || 0) + 1;
    g.stats.lastCompletedAt = Date.now();
  } else if (status === "expired") {
    g.stats.expired = (g.stats.expired || 0) + 1;
  }
  await store.save();

  // A finished raid KEEPS its numbers on screen — the card is the record.
  await editCard(telegram, g, status);

  if (status === "completed") {
    try {
      const payload = tpl.render("raid_complete_note", {
        crew: String((raid.crew || []).length),
        url: raid.postUrl || "",
      });
      const { text, extra } = payloadArgs(payload, false);
      await telegram.sendMessage(g.chatId, text, {
        ...extra,
        ...(raid.messageId ? { reply_to_message_id: raid.messageId } : {}),
      });
    } catch (e) {
      log.debug(`[raid] completion note failed in ${g.chatId}: ${e && e.message}`);
    }
  }
  if (raid.messageId) await telegram.unpinChatMessage(g.chatId, raid.messageId).catch(() => {});
  log.info(`[raid] ${status} group=${g.chatId} post=${raid.postId}`);
}

// ── Polling ──────────────────────────────────────────────────────────────────

/**
 * A raid degraded at launch re-arms itself.
 *
 * `xUnavailable` used to be a one-way latch in the design this is modelled on:
 * if X was unreadable at second zero — including because a DIFFERENT group's
 * rate limit armed the process-wide cooldown — the whole raid ran crew-only,
 * and a real like arriving ten minutes later could never appear, with nothing
 * anywhere saying why.
 */
async function tryRearmX(g) {
  const raid = g.raid;
  const p = raid.pendingX || {};
  if (!(p.likes > 0 || p.replies > 0 || p.reposts > 0)) return false;
  const m = await xMetrics.fetchTweetMetrics(raid.postId);
  if (!m.ok) {
    // A dead post clears the pending goals but does NOT end the raid — the crew
    // goal never depended on the post.
    if (m.gone) {
      raid.pendingX = { likes: 0, replies: 0, reposts: 0 };
      await store.save();
    }
    return false;
  }
  const seesReposts = m.retweets != null;
  raid.baseline = { likes: m.likes, replies: m.replies, reposts: seesReposts ? m.retweets : 0 };
  raid.target = {
    likes: p.likes > 0 ? raid.baseline.likes + p.likes : raid.baseline.likes,
    replies: p.replies > 0 ? raid.baseline.replies + p.replies : raid.baseline.replies,
    reposts: p.reposts > 0 && seesReposts ? raid.baseline.reposts + p.reposts : raid.baseline.reposts,
  };
  raid.current = { ...raid.baseline };
  raid.postText = m.text || raid.postText;
  raid.pendingX = { likes: 0, replies: 0, reposts: 0 };
  raid.xUnavailable = false;
  raid.crewOnly = false;
  await store.save();
  log.info(`[raid] X came back for ${g.chatId} — X goals re-armed from the current counts`);
  return true;
}

async function tickOne(telegram, g) {
  const raid = g.raid;
  if (!raid || raid.status !== "running") return;

  // The deadline is checked BEFORE the metrics call, so an X outage can never
  // hold a group's chat shut past its expiry.
  if (raid.expiresAt && Date.now() >= raid.expiresAt) {
    return finishRaid(telegram, g, "expired");
  }

  const before = card.signature(raid, "running");

  if (raid.crewOnly && raid.xUnavailable) await tryRearmX(g);

  if (!raid.crewOnly && raid.postId) {
    const m = await xMetrics.fetchTweetMetrics(raid.postId);
    if (m.ok) {
      raid.current = {
        likes: m.likes,
        replies: m.replies,
        // A null must never make a live repost count fall to zero mid-raid.
        reposts: m.retweets != null ? m.retweets : (raid.current && raid.current.reposts) || 0,
      };
      if (m.text) raid.postText = m.text;
      raid.lastError = "";
    } else if (m.gone) {
      log.warn(`[raid] post for ${g.chatId} is gone — stopping the raid`);
      return finishRaid(telegram, g, "cancelled");
    } else {
      // Keep the previous numbers and SAY they are stale. A tracker that
      // silently freezes is worse than one that admits it.
      raid.lastError = m.error || "unavailable";
    }
  }
  raid.lastPolledAt = Date.now();

  if (card.isComplete(raid)) {
    await store.save();
    return finishRaid(telegram, g, "completed");
  }

  // A raid with no bump mark yet seeds one instead of claiming progress.
  if (!raid.lastBumpMark) raid.lastBumpMark = countsMark(raid);
  await store.save();

  const after = card.signature(raid, "running");
  const bumpDue = Date.now() - (raid.lastBumpAt || 0) >= RAID_BUMP_MINUTES * 60000;
  const chattered = (chatterSinceBump.get(String(g.chatId)) || 0) > 0;
  // TWO independent reasons to re-post, and they are not the same thing:
  //  • the group has been talking, so the card has scrolled away and the raid
  //    is dying of invisibility;
  //  • the numbers moved — an in-place edit updates the count and NOTIFIES
  //    NOBODY, so the group never learns the raid is progressing, which is the
  //    one thing a raid exists to broadcast.
  const movedSinceBump = countsMark(raid) !== raid.lastBumpMark;

  if (bumpDue && (chattered || movedSinceBump)) {
    // A bump REPLACES this poll's edit rather than adding a second call.
    await bumpCard(telegram, g);
    return;
  }
  if (after !== before) await editCard(telegram, g, "running");
}

// ── Boot recovery ────────────────────────────────────────────────────────────

/**
 * Release every raid whose deadline has passed — this, not the in-memory
 * interval, is what frees a group whose process was killed mid-raid. A raid
 * with NO deadline at all is also released, because nothing else ever will.
 */
async function recoverOnBoot(telegram) {
  let released = 0;
  let resumed = 0;
  for (const g of store.running()) {
    const deadline = g.raid.expiresAt || 0;
    if (!deadline || Date.now() >= deadline) {
      log.info(`[raid] boot recovery: releasing stale raid in ${g.chatId}`);
      await finishRaid(telegram, g, "expired").catch((e) => log.warn(`[raid] boot release failed for ${g.chatId}: ${e && e.message}`));
      released++;
    } else {
      markActive(g.chatId, true);
      resumed++;
      log.info(`[raid] boot recovery: resuming raid in ${g.chatId}, ${Math.round((deadline - Date.now()) / 60000)}min left`);
    }
  }
  if (released || resumed) log.info(`[raid] boot sweep: ${released} released, ${resumed} resumed`);
  return { released, resumed };
}

function start(bot) {
  const telegram = (bot && bot.telegram) || bot;
  let timer = null;
  let busy = false;

  const tick = async () => {
    if (busy) return; // a slow tick must not stack a second on top of itself
    busy = true;
    try {
      const live = store.running();
      activeGroups.clear();
      for (const g of live) markActive(g.chatId, true);
      for (const g of live) {
        await tickOne(telegram, g).catch((e) => log.warn(`[raid] tick failed for ${g.chatId}: ${e && e.message}`));
      }
    } catch (e) {
      log.warn(`[raid] tick error: ${e && e.message}`);
    } finally {
      busy = false;
    }
  };

  // The boot sweep runs BEFORE the poll timer is armed — it is the only thing
  // that unlocks a group whose raid died with the process, so it must not wait
  // in line behind a poll.
  recoverOnBoot(telegram)
    .catch((e) => log.warn(`[raid] boot recovery failed: ${e && e.message}`))
    .finally(() => {
      timer = setInterval(tick, RAID_POLL_SEC * 1000);
      log.info(`[raid] runner started — poll ${RAID_POLL_SEC}s, max raid ${RAID_MAX_MINUTES}min, bump ${RAID_BUMP_MINUTES}min`);
    });

  return { stop: () => timer && clearInterval(timer) };
}

module.exports = {
  start,
  startRaid,
  finishRaid,
  tickOne,
  tryRearmX,
  recoverOnBoot,
  editCard,
  bumpCard,
  pinCard,
  handlePinned,
  isRaidActive,
  markActive,
  noteChatter,
  countsMark,
  isFatalChatError,
  _activeGroups: activeGroups,
  _chatterSinceBump: chatterSinceBump,
  _pinnedByUs: pinnedByUs,
};
