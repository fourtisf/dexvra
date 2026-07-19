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
    return false;
  }
}

async function primeMedia(telegram, job) {
  if (!job.mediaPath || job.mediaFileId) return;
  const first = job.targets[job.cursor];
  if (first == null) return;
  try {
    const msg = await telegram.sendPhoto(first, { source: job.mediaPath }, job.text ? jobExtra(job, true) : {});
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
    job.failed += 1;
    job.cursor += 1;
    await store.saveJob(job);
  }
}

async function report(telegram, job) {
  if (!job.reportChatId) return;
  try {
    const label = job.test ? " (admin test)" : "";
    await telegram.sendMessage(
      job.reportChatId,
      `📣 <b>Mass DM delivered${label}</b>\n` +
        `<b>Ref:</b> <code>${job.ref || job.id}</code>\n` +
        `<b>Reached:</b> ${job.sent}  <b>Failed:</b> ${job.failed}  <b>Audience:</b> ${job.total}`,
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
  log.info(`[massdm] running ${job.id} (${job.total} targets${job.test ? ", TEST" : ""})`);

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

module.exports = { start, runJob };
