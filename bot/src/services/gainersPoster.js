// Runs in the MAIN bot process. Two jobs, both about the Top-Gainers banner:
//
//   1. PUBLISH what @dexvraadminbot queued (gainerspost/store) — this process is
//      the only one that can: channels/post is attached here and the GramJS
//      premium session lives here.
//   2. The DAILY auto-post at the operator's configured local time, when they've
//      turned it on.
//
// Both paths are fail-safe in the same direction: no live gainers, no canvas, a
// dead API → nothing is posted and the reason is logged. A gainers banner that
// prints stale or invented numbers is worse than a day with no banner.
const cfgStore = require("./gainersConfig");
const store = require("../gainerspost/store");
const gainers = require("../gainers");
const gb = require("../gainersBanner");
const post = require("../channels/post");
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const log = require("../helpers/logger");

const POLL_MS = Math.max(1000, Number(process.env.GAINERS_POLL_MS) || 3000);
// The daily check runs far more often than once a day so a minute is never
// missed to timer drift; `dayKey` in the state file is what makes it idempotent.
const DAILY_CHECK_MS = Math.max(10000, Number(process.env.GAINERS_DAILY_CHECK_MS) || 30000);
const STATE_FILE = "gainersPosterState.json";

const tmeLink = (channel, msgId) =>
  String(channel).startsWith("@") ? `https://t.me/${String(channel).slice(1)}/${msgId}` : `message ${msgId}`;

const loadState = () => loadJSONSync(STATE_FILE, {}) || {};
const saveState = (s) => saveJSON(STATE_FILE, s).catch(() => {});

// ── queued admin posts ──────────────────────────────────────────────────────
async function drainQueue() {
  await store.expireStale().catch(() => {});
  for (const job of store.pending()) {
    if (!(await store.claim(job.id))) continue; // another tick got it
    try {
      const msg = await post.sendPhoto(job.channel, { source: job.imagePath }, job.caption, { pin: job.pin });
      const ok = Boolean(msg && msg.message_id);
      const result = ok ? { channel: job.channel, messageId: msg.message_id, url: tmeLink(job.channel, msg.message_id) } : null;
      await store.finish(job.id, { ok, result, error: ok ? null : "channel refused the post" });
      if (ok) log.info(`[gainers] ${job.template} posted → ${result.url} (${job.symbols.join(", ")}) by ${job.by}`);
      else log.warn(`[gainers] ${job.template} FAILED to post in ${job.channel}`);
    } catch (e) {
      log.warn(`[gainers] publish ${job.id} failed: ${e.message}`);
      await store.finish(job.id, { ok: false, error: e.message }).catch(() => {});
    }
  }
}

// ── the daily auto-post ─────────────────────────────────────────────────────
/**
 * Build and publish one banner from live data. Shared by the daily timer and the
 * `/gainers now` path, so both produce exactly the same post.
 * @returns {Promise<{ok:boolean, reason?:string, url?:string, template?:string, symbols?:string[]}>}
 */
async function postNow({ template = null, by = "schedule" } = {}) {
  const cfg = cfgStore.get();
  if (!gb.available()) return { ok: false, reason: "canvas unavailable on this host" };
  const id = gb.pickTemplate(template || cfg.template, { pool: cfg.pool });
  const res = await gainers.topGainers({
    limit: gb.countOf(id),
    minGainPct: cfg.minGainPct,
    minLiqUsd: cfg.minLiqUsd,
  });
  if (!res.coins.length) return { ok: false, reason: res.notes.join(" ") || "no live gainers" };

  const image = await gb.render({
    template: id,
    coins: res.coins,
    dateText: cfg.showDate ? gainers.dateText(cfg.tz) : "",
    bgPath: cfgStore.bgForRender(),
  });
  if (!image) return { ok: false, reason: "banner render failed" };

  const channel = cfgStore.targetChannel(cfg);
  const caption = gainers.captionPayload(res.coins, { tz: cfg.tz, showMcap: cfg.showMcap });
  const msg = await post.sendPhoto(channel, { source: image }, caption, { pin: cfg.pin });
  if (!msg || !msg.message_id) return { ok: false, reason: `${channel} refused the post — is the bot an admin there?` };
  const symbols = res.coins.map((c) => c.symbol);
  log.info(`[gainers] daily ${id} → ${tmeLink(channel, msg.message_id)} (${symbols.join(", ")}) by ${by}`);
  return { ok: true, url: tmeLink(channel, msg.message_id), template: id, symbols, source: res.source };
}

/** One scheduler beat. `post` is injectable so the once-a-day guarantee can be
 *  tested without a Telegram connection — the guard is the whole point of this
 *  function, and it is exactly the kind of logic that is wrong until it is
 *  exercised. */
async function dailyTick(now = new Date(), { post: doPost = postNow } = {}) {
  const cfg = cfgStore.get();
  if (!cfg.daily) return false;
  if (cfgStore.nowHHMM(cfg, now) !== cfg.dailyTime) return false;
  const key = cfgStore.dayKey(cfg, now);
  const st = loadState();
  if (st.lastDay === key) return false; // already posted today
  // Claim the day BEFORE posting: the check runs every 30s, and a post that takes
  // longer than the minute window would otherwise be started twice.
  await saveState({ ...st, lastDay: key, lastAt: Date.now() });
  const res = await doPost({ by: "daily" });
  if (!res.ok) {
    // Nothing was published, so release the day — the next tick inside this same
    // minute can retry a transient failure, and a real one just logs again.
    await saveState({ ...loadState(), lastDay: st.lastDay || null, lastError: res.reason, lastErrorAt: Date.now() });
    log.warn(`[gainers] daily post skipped: ${res.reason}`);
    return false;
  }
  await saveState({ ...loadState(), lastDay: key, lastAt: Date.now(), lastUrl: res.url, lastTemplate: res.template, lastError: null });
  return true;
}

function start() {
  let stopped = false;
  let qTimer = null;
  let dTimer = null;

  const queueLoop = async () => {
    if (stopped) return;
    await drainQueue().catch((e) => log.debug(`[gainers] queue: ${e.message}`));
    if (!stopped) qTimer = setTimeout(queueLoop, POLL_MS);
  };
  const dailyLoop = async () => {
    if (stopped) return;
    await dailyTick().catch((e) => log.warn(`[gainers] daily tick: ${e.message}`));
    if (!stopped) dTimer = setTimeout(dailyLoop, DAILY_CHECK_MS);
  };
  qTimer = setTimeout(queueLoop, 2500);
  dTimer = setTimeout(dailyLoop, 15000);
  const pruner = setInterval(() => store.prune().catch(() => {}), 60 * 60 * 1000);

  const cfg = cfgStore.get();
  log.info(
    `[gainers] poster ready (queue every ${POLL_MS / 1000}s; daily ${cfg.daily ? `ON at ${cfg.dailyTime} ${cfg.tz} → ${cfgStore.targetChannel(cfg)}` : "OFF"})`,
  );
  return {
    stop: () => {
      stopped = true;
      clearTimeout(qTimer);
      clearTimeout(dTimer);
      clearInterval(pruner);
    },
  };
}

module.exports = { start, postNow, _drainQueue: drainQueue, _dailyTick: dailyTick, STATE_FILE };
