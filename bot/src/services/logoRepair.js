// A LISTING POST THAT WENT OUT WITHOUT ITS LOGO IS REPAIRED, NOT LEFT.
//
// "saya ingin setiap listing token harus ada logonya jika punya logo".
//
// `$DLYN` (DUALYNE, Pons, Robinhood) went out as an Xpress Listing to 12,436
// subscribers drawing the Dexvra mark while ponsfamily.com rendered its logo in
// the same minute, and `$ORCHFLOWS` and `$GG` before it. Every fix since has
// made the FIRST fetch likelier to succeed — gateway failover, a hedged ladder,
// a warm copy fetched while the buyer reads the review card, a second pass
// across every url the token is known by (`fulfillment.readArtwork`) — and
// none of them can make it certain: whether a public IPFS gateway holds a fresh
// CID this minute is a fact about somebody else's cache. A paid post happens
// once, so "likelier" left every remaining miss permanent.
//
// So the promise is kept AFTER the post as well as before it. A post whose
// artwork was wanted and did not load (or whose row is blank only because the
// chain could not be asked) is queued here with the messages it went out as.
// This keeps asking on a widening schedule, and the moment the artwork loads it
//   1. PINS the bytes to our own disk and moves the row onto them (the same CAS
//      the post uses — an admin who changed the logo meanwhile wins), so the
//      site and every later post stop depending on a gateway;
//   2. rebuilds the SAME banner (kind, badge, coin) with the logo in it;
//   3. EDITS each channel post's media in place, re-sending its caption
//      (channels/post.replaceMedia) — never a second post, which would be a
//      duplicate announcement, and never a delete, which breaks every link the
//      buyer was already given.
//
// What it CANNOT reach, stated so it is not mistaken for an oversight:
//   · the X post — a tweet's media cannot be edited;
//   · the community-group mirror — it is a FORWARD, a frozen copy;
//   · the per-token animated emoji pack, which is built once at fulfilment.
//
// RULES, each one a way this could do harm:
//   · A job is CLAIMED (written out of the file) BEFORE any edit. A crash
//     mid-repair then loses one repair — a shrug — rather than re-editing the
//     same posts on every boot for ever.
//   · Persisted (DATA_DIR/logoRepair.json), because this box is redeployed far
//     more often than the schedule is long, and an in-memory queue would lose
//     exactly the repairs a deploy afternoon produces.
//   · Bounded: at most MAX_JOBS queued (oldest dropped, and SAID), and the
//     schedule ends — a logo nobody has pinned after hours is not coming, and
//     a job retried for ever is a request per tick for nothing.
//   · The outcome is REPORTED both ways — "repaired" is a recovery, and a
//     recovery nobody hears about reads exactly like a forgotten outage; "gave
//     up" names the token and the last reason, because the operator was the
//     detector for three rounds of this and must not be again.
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const { LOGO_REPAIR_ENABLED } = require("../config/constants");
const log = require("../helpers/logger");

const FILE = "logoRepair.json";
// Widening, because the failure is a cold cache: the first gateways asked start
// resolving the CID, so an early retry is the likeliest to land, and a CID
// nobody has pinned will not appear any faster for being asked every minute.
// ~3h45m end to end.
const DELAYS_MS = [60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000, 3 * 3600_000];
const TICK_MS = 30_000;
const BOOT_DELAY_MS = 20_000;
const MAX_JOBS = 50;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function load() {
  const v = loadJSONSync(FILE, []);
  return Array.isArray(v) ? v : [];
}

async function save(jobs) {
  await saveJSON(FILE, jobs);
}

const keyOf = (j) => `${j.kind}:${j.chain}:${String(j.address || "").toLowerCase()}`;

/**
 * Queue a repair. `job` = { kind, chain, address, sym, name, urls, bannerCoin,
 * posts: [{ channel, message_id, via, media, badge, caption }] }.
 * A second job for the same post kind and token MERGES into the first (its
 * posts and urls), so a re-fulfilment cannot queue the same edit twice.
 * Returns whether anything was queued. Never throws — a paid order is already
 * delivered by the time this is called.
 */
async function enqueue(job, now = Date.now()) {
  try {
    if (!LOGO_REPAIR_ENABLED) return false;
    const posts = (job && job.posts ? job.posts : []).filter((p) => p && p.channel && p.message_id && p.caption);
    if (!job || !job.chain || !job.address || !posts.length) return false;
    const jobs = load();
    const fresh = {
      kind: job.kind || "listing",
      chain: job.chain,
      address: job.address,
      sym: job.sym || "",
      name: job.name || "",
      urls: (job.urls || []).filter((u) => typeof u === "string" && u.trim()),
      pinFrom: job.pinFrom || null,
      bannerCoin: job.bannerCoin || {},
      posts,
      attempts: 0,
      createdAt: now,
      nextAt: now + DELAYS_MS[0],
      why: job.why || null,
    };
    const at = jobs.findIndex((j) => keyOf(j) === keyOf(fresh));
    if (at >= 0) {
      const old = jobs[at];
      const seen = new Set(old.posts.map((p) => `${p.channel}/${p.message_id}`));
      for (const p of posts) if (!seen.has(`${p.channel}/${p.message_id}`)) old.posts.push(p);
      for (const u of fresh.urls) if (!old.urls.includes(u)) old.urls.push(u);
    } else {
      jobs.push(fresh);
    }
    while (jobs.length > MAX_JOBS) {
      const dropped = jobs.shift();
      log.warn(`[logoRepair] queue full — dropped the oldest repair (${dropped.kind} ${dropped.chain}/${dropped.address})`);
    }
    await save(jobs);
    log.info(
      `[logoRepair] queued: ${fresh.kind} $${String(fresh.sym).replace(/^\$/, "")} ${fresh.chain}/${fresh.address} — ` +
        `${posts.length} post(s) will be edited when the artwork loads (first retry in ${DELAYS_MS[0] / 1000}s)`,
    );
    return true;
  } catch (e) {
    log.warn(`[logoRepair] could not queue ${job && job.chain}/${job && job.address}: ${e.message}`);
    return false;
  }
}

/** The real collaborators, required lazily: fulfillment requires THIS module. */
function realDeps() {
  const f = require("../fulfillment");
  return {
    readArtwork: (urls) => f.readArtwork(urls, { tries: 1 }),
    readMarket: (chain, address) => f.readPostMarket(chain, address, "repair"),
    adoptChainLogo: f._adoptChainLogo,
    pinLogo: f._pinLogo,
    postMedia: f.postMedia,
    replaceMedia: require("../channels/post").replaceMedia,
    alert: (html) => log.alert(html),
  };
}

/**
 * Try ONE job. Returns { done, repaired, failed, why } — `done` false means
 * the artwork still did not load and the job should be rescheduled.
 */
async function attempt(job, deps) {
  const urls = [...(job.urls || [])];
  // A row that was BLANK because the chain could not be asked has no url to
  // retry — ask the chain again for one. Never written to the row here: the
  // pin CAS refuses to fill a blank, and the site's resolver sweep owns that.
  if (!urls.length) {
    try {
      const { live } = await deps.readMarket(job.chain, job.address);
      const probe = { logoUrl: null };
      if (deps.adoptChainLogo(probe, live)) urls.push(probe.logoUrl);
      else if (live && live.logoWhy) return { done: false, why: String(live.logoWhy) };
    } catch (e) {
      return { done: false, why: e.message };
    }
    if (!urls.length) return { done: true, repaired: 0, failed: [], why: "the chain answered and publishes no artwork" };
  }
  const art = await deps.readArtwork(urls);
  if (!art || !art.bytes) return { done: false, why: (art && art.why) || (art && art.status ? `HTTP ${art.status}` : "no answer") };

  let url = art.url || urls[0];
  if (job.pinFrom && url === job.pinFrom) {
    url = await deps.pinLogo({ chain: job.chain, address: job.address }, url, art.bytes);
  }
  let repaired = 0;
  const failed = [];
  const built = new Map(); // one render per (media kind, badge) — the listing and announce posts share one
  for (const p of job.posts) {
    const k = `${p.media}|${p.badge || ""}`;
    if (!built.has(k)) {
      built.set(k, await deps.postMedia(p.media || "listing", job.bannerCoin || {}, art.bytes, null, url, p.badge || null).catch(() => null));
    }
    const media = built.get(k);
    if (!media) {
      failed.push(`${p.channel}/${p.message_id}: the banner could not be rebuilt`);
      continue;
    }
    const r = await deps.replaceMedia(p.channel, { message_id: p.message_id, via: p.via }, media, p.caption);
    if (r && r.ok) repaired++;
    else failed.push(`${p.channel}/${p.message_id}: ${(r && r.why) || "edit refused"}`);
  }
  return { done: true, repaired, failed, url };
}

let running = false;

/**
 * One pass over the due jobs. Never throws. `deps` is the test seam; nothing
 * in production passes it.
 */
async function runOnce({ now = Date.now(), deps } = {}) {
  if (running) return { skipped: true };
  running = true;
  const out = { due: 0, repaired: 0, rescheduled: 0, gaveUp: 0 };
  try {
    const d = deps || realDeps();
    const due = load().filter((j) => Number(j.nextAt) <= now);
    for (const job of due) {
      out.due++;
      // CLAIM before acting — see the header. The job is back in the file only
      // if it has to be retried.
      await save(load().filter((j) => keyOf(j) !== keyOf(job)));
      let r;
      try {
        r = await attempt(job, d);
      } catch (e) {
        r = { done: false, why: e.message };
      }
      const sym = esc(String(job.sym || "").replace(/^\$/, ""));
      if (r.done) {
        if (r.repaired || (r.failed && r.failed.length)) {
          out.repaired += r.repaired;
          log.info(`[logoRepair] $${sym} ${job.chain}/${job.address}: ${r.repaired}/${job.posts.length} post(s) now carry the artwork`);
          d.alert(
            `🖼✅ <b>Logo repaired</b> — ${esc(job.kind)} $${sym}\n` +
              `<code>${esc(job.chain)}/${esc(job.address)}</code>\n` +
              `${r.repaired}/${job.posts.length} channel post(s) now carry the token's artwork` +
              ` (after ${job.attempts + 1} retr${job.attempts ? "ies" : "y"}).` +
              (r.failed && r.failed.length ? `\nNot edited: ${esc(r.failed.join("; ")).slice(0, 600)}` : "") +
              `\nThe X post and the group forward keep the original — neither can be edited.`,
          );
        } else {
          log.info(`[logoRepair] $${sym} ${job.chain}/${job.address}: ${r.why || "nothing to repair"}`);
        }
        continue;
      }
      const attempts = (job.attempts || 0) + 1;
      if (attempts >= DELAYS_MS.length) {
        out.gaveUp++;
        log.warn(`[logoRepair] $${sym} ${job.chain}/${job.address}: gave up after ${attempts} retries — ${r.why}`);
        d.alert(
          `🖼❌ <b>Logo repair gave up</b> — ${esc(job.kind)} $${sym}\n` +
            `<code>${esc(job.chain)}/${esc(job.address)}</code>\n` +
            `The artwork did not load in ${attempts} retries over ~${Math.round(DELAYS_MS.reduce((a, b) => a + b, 0) / 60000)} min, ` +
            `so ${job.posts.length} channel post(s) keep the Dexvra mark.\n` +
            `Last reason: ${esc(r.why || "unknown")}\n` +
            `Run <code>npm run logos:check -- ${esc(job.chain)} ${esc(job.address)}</code> on the box.`,
        );
        continue;
      }
      out.rescheduled++;
      const next = { ...job, attempts, nextAt: now + DELAYS_MS[attempts], why: r.why || job.why };
      await save([...load().filter((j) => keyOf(j) !== keyOf(next)), next]);
      log.info(`[logoRepair] $${sym} ${job.chain}/${job.address}: still no artwork (${r.why}) — retry ${attempts + 1} in ${Math.round(DELAYS_MS[attempts] / 1000)}s`);
    }
  } catch (e) {
    log.warn(`[logoRepair] pass failed: ${e.message}`);
  } finally {
    running = false;
  }
  return out;
}

function start() {
  if (!LOGO_REPAIR_ENABLED) {
    log.info("[logoRepair] off (LOGO_REPAIR=0) — a post that went out without its logo stays that way");
    return null;
  }
  const tick = () => runOnce().catch((e) => log.warn(`[logoRepair] ${e.message}`));
  const boot = setTimeout(tick, BOOT_DELAY_MS);
  const iv = setInterval(tick, TICK_MS);
  if (boot.unref) boot.unref();
  if (iv.unref) iv.unref();
  const queued = load().length;
  log.info(`[logoRepair] started — ${queued} repair(s) queued; retries at ${DELAYS_MS.map((m) => (m >= 3600_000 ? m / 3600_000 + "h" : m / 60_000 + "m")).join(", ")}`);
  return {
    stop() {
      clearTimeout(boot);
      clearInterval(iv);
    },
    runOnce,
  };
}

module.exports = { enqueue, runOnce, start, DELAYS_MS, FILE, _attempt: attempt, _load: load, _reset: () => save([]) };
