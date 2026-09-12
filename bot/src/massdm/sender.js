// Paid Mass DM sender — runs in the MAIN bot process (only it can DM users who
// /start-ed it). Polls ONLY the mass_dm store for in_progress jobs (an admin
// approval flips pending_review→in_progress). Same delivery engine as the admin
// broadcast (paced, concurrent, media uploaded once + reused by file_id, 429
// retry_after, per-batch persistence) but a SEPARATE runner + dir so the two
// systems never collide (fourtis gotcha 14).
const { BROADCAST_RATE, BROADCAST_CONCURRENCY, BROADCAST_POLL_MS } = require("../config/constants");
const store = require("./store");
const tpl = require("../templates");
const { payloadArgs } = require("../helpers/message");
const log = require("../helpers/logger");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function retryAfter(e) {
  const p1 = e && e.response && e.response.parameters && e.response.parameters.retry_after;
  if (p1 != null) return Number(p1);
  const p2 = e && e.parameters && e.parameters.retry_after;
  if (p2 != null) return Number(p2);
  return null;
}

function jobExtra(job, forCaption) {
  const ents = job.entities || [];
  if (ents.length) {
    return forCaption
      ? { caption: job.text, caption_entities: ents }
      : { entities: ents, disable_web_page_preview: true };
  }
  return forCaption
    ? job.text
      ? { caption: job.text, parse_mode: "HTML" }
      : {}
    : { parse_mode: "HTML", disable_web_page_preview: true };
}

// ── Premium (custom) emoji ──────────────────────────────────────────────────
//
// ⚠️ A DM IS A PRIVATE CHAT, AND THAT IS THE WHOLE POINT. Telegram's rule is
// that custom-emoji entities may be used "by bots that purchased additional
// usernames on Fragment, OR in the messages directly sent by the bot to
// private, group and supergroup chats if the owner of the bot has a Telegram
// Premium subscription". A CHANNEL is in neither list — which is why
// channels/post.js needs the GramJS premium account and why premium.js's own
// header says animation needs it. That sentence is true of the channel and NOT
// of this sender, and reading it as a general fact is how a broadcast was
// reported as unable to do something it can do.
//
// So this module sends the entities untouched and lets Telegram decide. Two
// rules follow, because "it worked" and "it was silently downgraded" are
// otherwise the same observation — the defect the 🔄 Refresh board button was
// built to end one surface over.
const EMOJI_REFUSED = /custom[_ ]?emoji|EMOJI_INVALID/i;
const customCount = (ents) => (ents || []).filter((e) => e.type === "custom_emoji").length;

/**
 * Did the custom emoji actually go out?
 *
 * Telegram ECHOES the entities it accepted on the Message it returns, so one
 * missing from the echo is one it stripped — which is exactly the question this
 * cannot otherwise answer: is this bot allowed to use them at all. ⚠️ What it
 * can NEVER say is whether a given RECIPIENT sees them animated; that is their
 * own Telegram Premium, decided client-side, and claiming it here would be a
 * fact nobody measured.
 *
 * Recorded from the FIRST send only — the answer is a property of the bot, not
 * of the recipient, so 12,000 identical readings are the same reading.
 */
function notePremium(job, msg) {
  if (job.premiumOut != null || !msg) return;
  const want = customCount(job.entities);
  if (!want) return; // nothing premium in this job — the report says nothing
  job.premiumOut = customCount(msg.entities || msg.caption_entities) >= want;
  job.premiumWhy = job.premiumOut
    ? null
    : "Telegram stripped them — the bot's OWNER needs Telegram Premium (or the bot a Fragment username)";
}

/**
 * ⚠️ THE EMOJI MAY NEVER COST THE BROADCAST.
 *
 * If Telegram refuses the entities outright rather than stripping them, every
 * one of 12,000 sends fails the same way and a broadcast somebody PAID for
 * reaches nobody. Dropping them job-wide on the first refusal costs the
 * animation and delivers the message, which is the trade this repo makes
 * everywhere else ("losing a link beats losing the listing and the link with
 * it"). Job-wide because `job` is shared by reference: the sibling sends
 * already in flight are fixed by whichever one gets here first.
 */
function stripCustomEmoji(job) {
  if (!customCount(job.entities)) return;
  job.entities = (job.entities || []).filter((e) => e.type !== "custom_emoji");
  job.premiumOut = false;
  job.premiumWhy = "Telegram REFUSED the custom emoji — resent with the plain fallback";
  log.warn(`[massdm] ${job.id}: ${job.premiumWhy}`);
}

// ⚠️ A CLIP SENT THROUGH sendPhoto IS AN ERROR, NOT A STILL. The listing
// broadcast add-on carries the SAME artwork the channel post does, and on a box
// with an admin banner clip configured that is a GIF/MP4 — so the method has to
// follow the media, exactly as channels/post.sendMedia already does. Anything
// unknown is a photo, which is what every job before this one was.
const METHOD = { animation: "sendAnimation", video: "sendVideo" };
const sendMethod = (job) => METHOD[job && job.mediaType] || "sendPhoto";
/** The file_id Telegram hands back, under whichever key this media type uses. */
function fileIdOf(msg, kind) {
  if (!msg) return null;
  if (kind === "animation") return msg.animation && msg.animation.file_id;
  if (kind === "video") return msg.video && msg.video.file_id;
  const photos = msg.photo;
  return photos && photos.length ? photos[photos.length - 1].file_id : null;
}

// Returns the sent Message (truthy) or null — the caller only counts, but the
// MESSAGE is what carries Telegram's verdict on the emoji.
async function sendOne(telegram, job, userId, afterStrip) {
  try {
    const msg = job.mediaFileId
      ? await telegram[sendMethod(job)](userId, job.mediaFileId, job.text ? jobExtra(job, true) : {})
      : await telegram.sendMessage(userId, job.text, jobExtra(job, false));
    notePremium(job, msg);
    return msg || true;
  } catch (e) {
    const ra = retryAfter(e);
    if (ra != null) {
      await sleep((ra + 1) * 1000);
      return sendOne(telegram, job, userId, afterStrip);
    }
    if (!afterStrip && EMOJI_REFUSED.test(String((e && e.message) || ""))) {
      stripCustomEmoji(job);
      return sendOne(telegram, job, userId, true);
    }
    return null;
  }
}

async function primeMedia(telegram, job) {
  if (!job.mediaPath || job.mediaFileId) return;
  const first = job.targets[job.cursor];
  if (first == null) return;
  try {
    const msg = await telegram[sendMethod(job)](first, { source: job.mediaPath }, job.text ? jobExtra(job, true) : {});
    notePremium(job, msg);
    const id = fileIdOf(msg, job.mediaType);
    if (id) job.mediaFileId = id;
    job.sent += 1;
    job.cursor += 1;
    await store.saveJob(job);
  } catch (e) {
    const ra = retryAfter(e);
    if (ra != null) {
      await sleep((ra + 1) * 1000);
      return primeMedia(telegram, job);
    }
    job.failed += 1;
    job.cursor += 1;
    await store.saveJob(job);
  }
}

async function report(telegram, job) {
  if (!job.reportChatId) return;
  try {
    const label = job.test ? " (admin test)" : "";
    // ⚠️ A PLAIN SEND MUST NEVER RENDER AS A ✅ — the rule the trending board's
    // 🔄 Refresh had to learn: to anyone without Telegram Premium the two are
    // identical, so "it worked" and "it was downgraded" reach the operator as
    // one observation unless the line says which. Absent when the job carried
    // no custom emoji at all: a verdict on nothing is noise.
    const prem =
      job.premiumOut == null
        ? ""
        : job.premiumOut
          ? `\n<b>Premium emoji:</b> ✅ ${customCount(job.entities)} accepted by Telegram`
          : `\n<b>Premium emoji:</b> ⚠️ PLAIN — ${job.premiumWhy}`;
    await telegram.sendMessage(
      job.reportChatId,
      `📣 <b>Mass DM delivered${label}</b>\n` +
        `<b>Ref:</b> <code>${job.ref || job.id}</code>\n` +
        `<b>Reached:</b> ${job.sent}  <b>Failed:</b> ${job.failed}  <b>Audience:</b> ${job.total}${prem}`,
      { parse_mode: "HTML" },
    );
  } catch (e) {
    log.debug(`[massdm] report failed: ${e.message}`);
  }
}

async function receipt(telegram, job) {
  // counts-only receipt to the buyer (never a raw number of recipients in copy;
  // this is a private confirmation, so the delivered count is fine here).
  if (job.test || !job.createdBy) return;
  try {
    const payload = tpl.render("massdm_done", { ref: job.ref || job.id, reached: job.sent });
    const { text, extra } = payloadArgs(payload, false);
    await telegram.sendMessage(job.createdBy, text, extra);
  } catch (e) {
    log.debug(`[massdm] receipt failed: ${e.message}`);
  }
}

async function runJob(telegram, job) {
  job.status = "in_progress";
  job.startedAt = job.startedAt || Date.now();
  await store.saveJob(job);
  log.info(
    `[massdm] running ${job.id} (${job.total} targets${job.test ? ", TEST" : ""}${job.autoSend ? ", auto" : ""}, ${job.mediaFileId || job.mediaPath ? job.mediaType || "photo" : "text"})`,
  );

  await primeMedia(telegram, job);

  const CONC = BROADCAST_CONCURRENCY;
  const targetMs = (CONC / BROADCAST_RATE) * 1000;
  for (let i = job.cursor; i < job.targets.length; i += CONC) {
    const batch = job.targets.slice(i, i + CONC);
    const t0 = Date.now();
    const res = await Promise.all(batch.map((uid) => sendOne(telegram, job, uid)));
    job.sent += res.filter(Boolean).length;
    job.failed += res.filter((r) => !r).length;
    job.cursor = Math.min(i + CONC, job.targets.length);
    await store.saveJob(job);
    const elapsed = Date.now() - t0;
    if (elapsed < targetMs) await sleep(targetMs - elapsed);
  }

  job.status = "completed";
  job.finishedAt = Date.now();
  await store.saveJob(job);
  await report(telegram, job);
  await receipt(telegram, job);
  log.info(`[massdm] ${job.id} complete — sent ${job.sent}, failed ${job.failed}`);
}

let running = false;

function start(telegram) {
  const tick = async () => {
    if (running) return;
    const jobs = store.jobsByStatus("in_progress"); // approval flips the status; we only run approved jobs
    if (!jobs.length) return;
    running = true;
    try {
      await runJob(telegram, jobs[0]);
    } catch (e) {
      log.warn(`[massdm] ${e.message}`);
    } finally {
      running = false;
    }
  };
  const iv = setInterval(tick, BROADCAST_POLL_MS);
  const kick = setTimeout(tick, 6000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { start, runJob, _sendMethod: sendMethod, _fileIdOf: fileIdOf, _notePremium: notePremium, _stripCustomEmoji: stripCustomEmoji, _customCount: customCount };
