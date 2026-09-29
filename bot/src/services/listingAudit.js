'use strict';
/**
 * RE-CHECK WHAT IS ALREADY LISTED — so the operator is never the detector again.
 *
 * "ok bagaimana agar masalah ini tidak terjadi lgi", asked the moment the scam
 * filters deployed. They answer the question at the DOOR, and two things never
 * pass through that door again:
 *
 *  1. Every row listed BEFORE the gates existed — the fake $SHIB was found by a
 *     person reading the channel, and no gate reaches backwards.
 *  2. A token that turns bad AFTER it was listed. A contract owner can raise the
 *     sell tax to 99% or pause transfers the day after a listing, and nothing
 *     looks at a listing twice.
 *
 * This sweeps the BOT'S OWN listings on a timer — FREE-tier rows (the tier
 * nobody can buy) and the rows the auto-lister's scan picked — and asks them
 * the same two questions the door asks: `listingQuality` (a copied ticker, no
 * artwork, a pool holding the supply, a pinned price) and `listingSafety`
 * (honeypot, tax, authorities, holders). One owner for each question, called
 * from here rather than restated — a second idea of "is it a scam" drifts.
 *
 * ⚠️ PAID LISTINGS ARE NOT AUDITED. The gates are the bar for what the BOT lists
 * on its own; a purchase is not ours to flag over a heuristic.
 *
 * ⚠️ "WE COULD NOT ASK" IS NEVER A FLAG. A row whose market or safety read did
 * not answer is left un-audited (its timestamp untouched, so it is asked first
 * next sweep) — an outage must not page as a wave of scams.
 *
 * Alerts go on the TRANSITION only: a row newly found bad pages once, naming
 * every offender and the command that removes them; a row that stays bad says
 * nothing more; a flagged row that clears is dropped with an info line. An
 * alert every sweep is a channel nobody reads by the second hour.
 *
 * ⚠️ IT NEVER DELETES. Nothing in the running bot may remove a listing on its
 * own (unseed.test.js pins that for every service): a listing is public and
 * has been announced, and a false positive — a proxy contract GoPlus flags, a
 * logo the indexer lost — should cost a human's glance, not a deletion. The
 * page names the one command that removes them, which an operator runs.
 */
const { loadJSONSync, saveJSON } = require('../helpers/persist');
const { SITE_URL } = require('../config/constants');
const log = require('../helpers/logger');
const api = require('../api/dexvra');
const discovery = require('../discovery');
const { qualityRefusal } = require('./listingQuality');
const listingSafety = require('./listingSafety');

const FILE = 'listingAudit.json'; // under DATA_DIR, shared by both bot processes

const envMs = (name, def, min) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return def; // blank is ABSENT, never 0
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, n) : def;
};
const enabled = () => !/^(0|false|off|no)$/i.test(String(process.env.LISTING_AUDIT || '').trim());

const TICK_MS = envMs('LISTING_AUDIT_MS', 30 * 60_000, 60_000);
const BATCH = envMs('LISTING_AUDIT_BATCH', 15, 1);
const BOOT_DELAY_MS = 3 * 60_000;

const symOf = (r) => String(r.sym ?? r.symbol ?? '').replace(/^\$+/, '');
const keyOf = (chain, address) => `${chain}:${String(address).toLowerCase()}`;

function load() {
  const s = loadJSONSync(FILE, {});
  return { checked: s.checked || {}, flagged: s.flagged || {} };
}

/** The rows this service may judge: the bot's own, never a purchase. */
function auditable(rows, autoKeys) {
  return (rows || []).filter((r) => {
    if (!r || !r.chain || !r.address) return false;
    if (r.status && r.status !== 'approved') return false;
    const tier = String(r.tier || '').toUpperCase();
    return tier === 'FREE' || autoKeys.has(keyOf(r.chain, r.address));
  });
}

/** Least-recently audited first — never-audited first of all — so every row is
 *  reached within ceil(n / BATCH) sweeps, the auto-trend probe rotation's rule. */
function pick(rows, state, n = BATCH) {
  const at = (r) => (state.checked[keyOf(r.chain, r.address)] || {}).at || 0;
  return [...rows].sort((a, b) => at(a) - at(b)).slice(0, n);
}

/** One row's verdict: `{ ok:false }` (could not ask), `{ ok:true, why:null }`, or a reason. */
async function judge(row, deps) {
  const price = await deps.priceX(row.chain, row.address).catch((e) => ({ info: null, ok: false, why: e.message }));
  if (!price || !price.ok) return { ok: false, why: (price && price.why) || 'could not price it' };
  const info = price.info;
  if (info) {
    // The ROW's own artwork counts: a project may have uploaded one the indexer
    // does not carry, and "no logo" about a row that renders one is false.
    // A relative url is one of OUR uploads (/api/media/…) — absolute it against
    // the site, because the quality check asks for a url that can be drawn.
    const raw = String(row.logoUrl || '').trim();
    const rowLogo = /^https?:\/\//.test(raw) ? raw : /^\/[^/]/.test(raw) ? SITE_URL + raw : null;
    const merged = { ...info, symbol: info.symbol || symOf(row), name: info.name || row.name, logoUrl: rowLogo || info.logoUrl };
    const bad = qualityRefusal(row.chain, row.address, merged);
    if (bad) return { ok: true, why: bad };
  }
  const safe = await deps.safetyX(row.chain, row.address).catch((e) => ({ ok: false, why: e.message }));
  if (!safe || !safe.ok) return { ok: false, why: (safe && safe.why) || 'safety check: no answer' };
  return { ok: true, why: safe.refusal || null };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function realDeps() {
  return {
    getListings: () => api.getListings(),
    priceX: (c, a) => discovery.fetchTokenInfoX(c, a),
    safetyX: (c, a) => listingSafety.checkX(c, a),
    autoKeys: () => require('./autoLister').autoListedKeys(),
    alert: (html) => log.alert(html),
  };
}

let running = false;

async function runOnce({ now = Date.now(), deps = realDeps() } = {}) {
  if (running) return null;
  running = true;
  try {
    const rows = auditable(await deps.getListings(), deps.autoKeys());
    const state = load();
    const live = new Set(rows.map((r) => keyOf(r.chain, r.address)));
    // A row that left the site (deleted, or bought up to a paid tier) leaves the
    // audit too — or a cleared flag would page again the day it came back.
    for (const k of Object.keys(state.flagged)) if (!live.has(k)) delete state.flagged[k];
    for (const k of Object.keys(state.checked)) if (!live.has(k)) delete state.checked[k];

    const out = { audited: 0, unasked: 0, newlyBad: [], cleared: [] };
    for (const r of pick(rows, state)) {
      const k = keyOf(r.chain, r.address);
      const v = await judge(r, deps);
      if (!v.ok) {
        out.unasked++;
        log.debug(`[listingAudit] ${r.chain}/${r.address}: could not check — ${v.why}`);
        continue;
      }
      out.audited++;
      state.checked[k] = { at: now };
      if (v.why) {
        if (!state.flagged[k]) {
          state.flagged[k] = { since: now, why: v.why, sym: symOf(r), chain: r.chain, address: r.address, id: r.id };
          out.newlyBad.push(state.flagged[k]);
        } else state.flagged[k].why = v.why;
      } else if (state.flagged[k]) {
        out.cleared.push(state.flagged[k]);
        delete state.flagged[k];
      }
    }

    await saveJSON(FILE, state).catch((e) => log.error(`[listingAudit] could not persist ${FILE}: ${e.message}`));

    if (out.newlyBad.length) {
      const lines = out.newlyBad
        .slice(0, 12)
        .map((f) => `• <b>$${esc(f.sym)}</b> (${esc(f.chain)}) — ${esc(f.why)}`);
      const more = out.newlyBad.length > 12 ? `\n…and ${out.newlyBad.length - 12} more` : '';
      const tail = 'Review, then remove them with:\n<code>cd /opt/dexvra/bot &amp;&amp; npm run listings:nostables</code>\n(dry run first — add <code>--apply</code> to delete)';
      deps.alert(`🚩 <b>Free listing audit</b> — ${out.newlyBad.length} listed token(s) now fail the scam checks\n${lines.join('\n')}${more}\n\n${tail}`);
    }
    for (const f of out.cleared) log.info(`[listingAudit] $${f.sym} (${f.chain}) passes again — flag cleared`);
    log.info(
      `[listingAudit] sweep: ${out.audited} checked · ${out.unasked} could not be asked · ` +
        `${Object.keys(state.flagged).length} flagged of ${rows.length} bot-made listing(s)`,
    );
    return out;
  } finally {
    running = false;
  }
}

/** Flagged rows, for the cleanup script: `{ key → {why, sym, chain, address} }`. */
const flagged = () => load().flagged;

function start() {
  if (!enabled()) {
    log.info('[listingAudit] off (LISTING_AUDIT=0) — listed tokens are never re-checked');
    return null;
  }
  const tick = () => runOnce().catch((e) => log.warn(`[listingAudit] ${e.message}`));
  const boot = setTimeout(tick, BOOT_DELAY_MS);
  const iv = setInterval(tick, TICK_MS);
  if (boot.unref) boot.unref();
  if (iv.unref) iv.unref();
  log.info(`[listingAudit] started — ${BATCH} listing(s) re-checked every ${Math.round(TICK_MS / 60_000)} min`);
  return { stop: () => (clearTimeout(boot), clearInterval(iv)), runOnce };
}

module.exports = { start, runOnce, flagged, auditable, pick, judge, FILE, _reset: () => saveJSON(FILE, {}) };
