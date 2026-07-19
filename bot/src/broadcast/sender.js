// Broadcast sender — runs in the MAIN bot process (only it can DM /start users).
// Polls for pending/in-progress jobs and delivers with fourtis-style rules:
// paced BROADCAST_RATE msg/s in BROADCAST_CONCURRENCY-wide batches, media
// uploaded ONCE then reused by file_id, 429 retry_after honoured, progress
// persisted per batch (restart-resumable).
const { BROADCAST_RATE, BROADCAST_CONCURRENCY, BROADCAST_POLL_MS } = require("../config/constants");
const store = require("./store");
const log = require("../helpers/logger");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function retryAfter(e) {
  const p1 = e && e.response && e.response.parameters && e.response.parameters.retry_after;
  if (p1 != null) return Number(p1);
  const p2 = e && e.parameters && e.parameters.retry_after;
  if (p2 != null) return Number(p2);
  return null;
}

/** Caption/text extra for a job: admin-composed entities (premium emoji kept —
 *  Telegram strips custom emoji it can't send, leaving the unicode fallback)
 *  or legacy HTML when the compose had no entities. */
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

async function sendOne(telegram, job, userId) {
  try {
    if (job.mediaFileId) {
      await telegram.sendPhoto(userId, job.mediaFileId, job.text ? jobExtra(job, true) : {});
    } else {
      await telegram.sendMessage(userId, job.text, jobExtra(job, false));
    }
    return true;
  } catch (e) {
    const ra = retryAfter(e);
    if (ra != null) {
      await sleep((ra + 1) * 1000);
      return sendOne(telegram, job, userId);
    }
    return false; // user blocked / deactivated / bad id — count as failed, don't retry
  }
}

/** Upload media once to the FIRST recipient, capture the main-bot file_id. */
async function primeMedia(telegram, job) {
  if (!job.mediaPath || job.mediaFileId) return;
  const first = job.targets[job.cursor];
  if (first == null) return;
  try {
    const msg = await telegram.sendPhoto(
      first,
      { source: job.mediaPath },
      job.text ? jobExtra(job, true) : {},
    );
    const photos = msg && msg.photo;
    if (photos && photos.length) job.mediaFileId = photos[photos.length - 1].file_id;
    job.sent += 1;
    job.cursor += 1;
    await store.saveJob(job);
  } catch (e) {
    const ra = retryAfter(e);
    if (ra != null) {
      await sleep((ra + 1) * 1000);
      return primeMedia(telegram, job);
    }
    // first recipient unreachable — skip it, still try to get a file_id next batch
    job.failed += 1;
    job.cursor += 1;
    await store.saveJob(job);
  }
}

async function runJob(telegram, job) {
  job.status = "in_progress";
  job.startedAt = job.startedAt || Date.now();
  await store.saveJob(job);
  log.info(`[broadcast] running ${job.id} (${job.total} targets${job.test ? ", TEST" : ""})`);

  await primeMedia(telegram, job); // upload media once

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
  log.report(
    `📣 <b>Broadcast complete</b>${job.test ? " (TEST)" : ""}\n` +
      `<b>Sent:</b> ${job.sent}  <b>Failed:</b> ${job.failed}  <b>Total:</b> ${job.total}\n` +
      `<b>By:</b> ${job.createdByUsername ? "@" + job.createdByUsername : ""} <code>${job.createdBy}</code>`,
  );
}

let running = false;

function start(telegram) {
  const tick = async () => {
    if (running) return;
    // resume an interrupted job first, then start the next pending one
    const jobs = [...store.jobsByStatus("in_progress"), ...store.jobsByStatus("pending")];
    if (!jobs.length) return;
    running = true;
    try {
      await runJob(telegram, jobs[0]);
    } catch (e) {
      log.warn(`[broadcast] ${e.message}`);
    } finally {
      running = false;
    }
  };
  const iv = setInterval(tick, BROADCAST_POLL_MS);
  const kick = setTimeout(tick, 4000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { start, runJob };
