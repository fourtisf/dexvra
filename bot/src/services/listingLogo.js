'use strict';
/*
 * THE ARTWORK A FREE LISTING IS BORN WITH — found across every source, checked
 * the way the RENDERER draws it, and copied onto our own disk BEFORE the row
 * exists.
 *
 * "mengapa bot free listing without logo pdahl tokenya ada logonaya saya ingin
 * bot setiap free listing harus ada logonya cari di sumber2 lain". $W (Wormhole
 * Token, Solana) went out to 12,406 subscribers drawing the Dexvra mark, over a
 * token whose artwork is on every index there is. Three holes, and every one of
 * them is this repo's own recurring shape:
 *
 *  1. THE GATE ASKED WHETHER A URL EXISTED, NEVER WHETHER IT COULD BE DRAWN.
 *     `listingQuality`'s "no logo" passes any http string, and discovery handed
 *     the auto-lister `https://wormhole.com/token.png` — the project's own file,
 *     on a host /api/logo's allowlist refuses. So the row was created holding a
 *     url its own page can never draw (a monogram FOR EVER: `pickLogo` ranks a
 *     stored url first, so the site's resolver never queues it), and the banner
 *     fell back to the Dexvra mark. `fonts:check`'s nine green ticks over a
 *     banner publishing boxes, one feature over: a guard is only honest while
 *     it measures the stack the renderer actually uses.
 *  2. ONE SOURCE WAS THE WHOLE ANSWER. A token whose discovery record carried
 *     no logo was refused outright, and one whose record carried a bad one was
 *     listed with it — while `tokenLogo.js` already knows seven other places
 *     the artwork could be, and nothing on this path ever asked them.
 *  3. NOTHING KEPT THE BYTES. A url that loads today is a third party's promise
 *     about tomorrow — the `$GG` lesson, where one CID flipped ✓/✗ across four
 *     deploys with zero lines changed.
 *
 * So, in order of authority, each candidate fetched through /api/logo (with
 * the guarded direct fetch behind it for a host the proxy refuses — see
 * helpers/safeImage): the url the row already carries (a heal), the url
 * discovery found, then `tokenLogo.resolveLogo`'s whole ladder with THIS check
 * as its verifier. The first that yields an image is uploaded to /api/media,
 * and the listing is created pointing at OUR copy — so the site, the banner,
 * the tweet and every later post read a file on this disk.
 *
 * The answer has three states, because "nothing there" and "could not ask" are
 * different facts and this repo has paid for confusing them every time:
 *   · `{ok:true,  url}`        — artwork, on our disk where it could be kept;
 *   · `{ok:true,  url:null}`   — every source ANSWERED and none has artwork a
 *                                renderer can draw: the token is refused as
 *                                "no logo", which a real project never is;
 *   · `{ok:false}`             — a source, the proxy or a host could not be
 *                                asked: NOT a verdict, and never cooled.
 *
 * `FREE_LISTING_LOGO=0` restores the old behaviour exactly (the url discovery
 * found, unchecked). The test runner sets it, because every test stubs the
 * network; this module's own tests turn it back on. Blank is ON.
 */
const { mediaPath } = require('../helpers/mediaUrl');
const { bounded } = require('../helpers/bounded');
const log = require('../helpers/logger');

const enabled = () =>
  !/^(0|false|off|no)$/i.test(String(process.env.FREE_LISTING_LOGO == null ? '' : process.env.FREE_LISTING_LOGO).trim());

const envMs = (name, def, min) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return def; // blank is ABSENT, never 0
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, n) : def;
};
// The whole lookup's ceiling. Generous on purpose: it runs once per token that
// has already cleared every market and safety gate, in a background scan, and
// the ladder's slow half (GeckoTerminal's queue, CoinGecko's pacing) is exactly
// the half a token with no indexed artwork needs.
const RESOLVE_MS = envMs('FREE_LISTING_LOGO_MS', 60_000, 5_000);

const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const hostOf = (u) => {
  if (mediaPath(u)) return '(our upload)';
  try {
    return new URL(u).hostname;
  } catch {
    return '?';
  }
};

/** A url worth fetching: an http(s) url, or one of our own uploads (either spelling). */
function fetchable(u) {
  const s = typeof u === 'string' ? u.trim() : '';
  if (!s) return null;
  if (mediaPath(s)) return s;
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
}

/** Could a later ask change this proxy answer? A timeout, a refusal of US, a
 *  5xx — yes. A 404 or an HTML page — no, that is an answer about the url. */
function flakyWhy(why) {
  return /no answer|body died|HTTP (401|403|408|425|429|5\d\d)\b/i.test(String(why || ''));
}

/** Real collaborators, lazily: fulfillment requires half the bot. */
function realDeps(over = {}) {
  return {
    fetchArt: (url) => require('../fulfillment').fetchLogoUrlX(url, { quiet: true }),
    ladder: (chain, address, verify) => require('./tokenLogo').resolveLogo(chain, address, { deps: { isImage: verify } }),
    upload: (bytes, name, mime) => require('../api/dexvra').uploadImage(bytes, name, mime),
    ...over,
  };
}

/** The bytes for one url the way the renderer gets them — or why not. Never throws. */
async function artFor(url, deps) {
  let r;
  try {
    r = await deps.fetchArt(url);
  } catch (e) {
    return { bytes: null, why: (e && e.message) || 'fetch failed', flaky: true };
  }
  if (r && r.bytes) return { bytes: r.bytes, via: r.source || 'proxy', ext: r.ext || null };
  if (!r || !r.reached) return { bytes: null, why: '/api/logo did not answer — is the web app up?', flaky: true };
  // The proxy refused the host and the guarded fetch of the project's own file
  // also failed — ITS reason is the one about the artwork.
  if (r.guardedWhy) return { bytes: null, why: r.guardedWhy, flaky: !!r.guardedFlaky };
  const why = r.why || (r.status ? `HTTP ${r.status}` : 'no image');
  return { bytes: null, why, flaky: flakyWhy(why) || Number(r.status) >= 500 };
}

/** The type from the bytes — the four the upload route keeps. */
function extOf(bytes) {
  return require('../helpers/safeImage').sniff(bytes);
}

/**
 * Keep a copy. Returns `{url, pinned}` for the url the listing should carry, or
 * null when this candidate cannot be used at all.
 *
 * A copy we could not keep (an SVG the upload route refuses, a site that will
 * not take the upload) still leaves a url the PROXY serves usable — it renders
 * exactly as it would have before this existed. One only the guarded fetch
 * could reach does NOT render anywhere but here, so it is no candidate at all.
 */
async function keep(url, art, deps) {
  if (mediaPath(url)) return { url, pinned: false }; // already ours
  const ext = art.ext || extOf(art.bytes);
  let why = null;
  if (ext) {
    try {
      const to = await deps.upload(art.bytes, `logo.${ext}`, MIME[ext]);
      if (to && mediaPath(to)) return { url: to, pinned: true };
      why = 'the upload returned no url';
    } catch (e) {
      why = (e && e.message) || String(e);
    }
  } else {
    why = 'not a PNG, JPG, GIF or WEBP — the upload route keeps nothing else';
  }
  if (art.via === 'proxy') return { url, pinned: false, why };
  log.info(`[listingLogo] could not keep a copy of ${url} (${why}) — only this server can reach it, so it is not used`);
  return null;
}

/**
 * Find renderable artwork for a token. See the header for the three states.
 *
 * @param {object} info     the discovery record (`info.logoUrl` is one candidate)
 * @param {object} [opts]
 *   `pin`            false = verify only, keep nothing (🔎 Test scan)
 *   `prefer`         a url to try FIRST — the one a live row already carries
 *   `keepRenderable` when `prefer` already renders through the proxy, answer
 *                    `{renders:true}` and keep nothing (the heal's question is
 *                    "is this broken", not "can it be improved")
 *   `deps`           test seams: fetchArt, ladder, upload
 */
async function resolveX(chain, address, info = {}, opts = {}) {
  const { pin = true, prefer = null, keepRenderable = false } = opts;
  if (!enabled()) {
    // The old behaviour, byte for byte: discovery's url, unchecked.
    const url = fetchable(prefer) || fetchable(info && info.logoUrl);
    return { ok: true, url, from: url, source: url ? 'unchecked' : null, pinned: false, off: true, why: url ? null : 'no logo url', tried: [], misses: [] };
  }
  const deps = realDeps(opts.deps);
  const tried = [];
  const misses = [];
  let flaky = false;
  const arts = new Map(); // url → art — the ladder may hand back a url already tried
  const kept = new Map(); // url → keep() result — at most one upload per url

  const check = async (source, url) => {
    if (!url) return null;
    if (!arts.has(url)) {
      const art = await artFor(url, deps);
      arts.set(url, art);
      tried.push(source);
      if (!art.bytes) {
        // The HOST rides on the line: "discovery: HTTP 400" cannot tell an
        // operator whose server it was, and that is the whole diagnosis.
        misses.push(`${source} ${hostOf(url)}: ${String(art.why).slice(0, 140)}`);
        if (art.flaky) flaky = true;
      }
    }
    const art = arts.get(url);
    if (!art.bytes) return null;
    if (keepRenderable && source === 'row' && art.via === 'proxy') return { url, from: url, source, via: art.via, pinned: false, renders: true };
    if (!pin) return { url, from: url, source, via: art.via, pinned: false };
    if (!kept.has(url)) kept.set(url, await keep(url, art, deps));
    const k = kept.get(url);
    return k ? { url: k.url, from: url, source, via: art.via, pinned: k.pinned } : null;
  };

  const work = (async () => {
    for (const [source, u] of [['row', prefer], ['discovery', info && info.logoUrl]]) {
      const hit = await check(source, fetchable(u));
      if (hit) return { ok: true, ...hit, tried, misses };
    }
    // Every other source tokenLogo knows — each candidate verified by the same
    // check, so "found a logo" can only ever mean "found one we can draw".
    let lad;
    try {
      lad = await deps.ladder(chain, address, async (url) => !!(await check('ladder', fetchable(url))));
    } catch (e) {
      lad = { ok: false, url: null, blocking: [`sources: ${(e && e.message) || e}`] };
    }
    if (lad && lad.url) {
      const hit = await check('ladder', fetchable(lad.url));
      if (hit) return { ok: true, ...hit, source: lad.source || 'ladder', tried, misses };
    }
    const unasked = (lad && lad.ok === false ? lad.blocking || lad.unreachable || [] : []).map(String);
    if (unasked.length || flaky) {
      return { ok: false, url: null, why: [...unasked, ...misses.filter(flakyMiss)].slice(0, 3).join('; ') || 'a source could not be asked', tried, misses };
    }
    return {
      ok: true, url: null, tried, misses,
      why: tried.length ? `none of ${tried.length} candidate(s) served an image` : 'no source has artwork for this token',
    };
  })();
  return bounded(work, RESOLVE_MS, () => ({ ok: false, url: null, why: `the artwork lookup passed ${RESOLVE_MS}ms`, tried, misses }));
}

/** A recorded miss that is about US or a bad minute, not about the url. */
function flakyMiss(m) {
  return flakyWhy(m) || /did not answer|could not reach|no answer/i.test(m);
}

/**
 * HEAL ONE LIVE ROW whose logo cannot be drawn — `services/listingAudit` asks.
 *
 * No gate reaches backwards, and `$W` was already live when this was written:
 * its row holds `wormhole.com/token.png` and the site draws a monogram there
 * for ever. Returns `{state, …}`:
 *   ours      — already one of our uploads (the site's lostUploads owns a missing file)
 *   renders   — the stored url draws through the proxy; nothing to do
 *   healed    — artwork found and the row moved onto our copy
 *   kept      — the row changed under us (an admin's decision wins — the CAS)
 *   none      — every source answered and none has artwork
 *   undecided — something could not be asked; next sweep asks again
 *   blank     — no url, or not an http(s) one: the pin CAS will not fill a blank
 *               (a blank is somebody's decision), so this does not try
 */
async function healRow(row, { deps: over = {}, pinLogo } = {}) {
  const cur = String((row && row.logoUrl) || '').trim();
  if (!enabled()) return { state: 'off' };
  if (!cur || !/^https?:\/\//i.test(cur)) return mediaPath(cur) ? { state: 'ours' } : { state: 'blank' };
  if (mediaPath(cur)) return { state: 'ours' };
  const r = await resolveX(row.chain, row.address, {}, { prefer: cur, keepRenderable: true, deps: over });
  if (!r.ok) return { state: 'undecided', why: r.why };
  if (r.renders) return { state: 'renders' };
  if (!r.url) return { state: 'none', why: r.why };
  // A url the proxy serves but we could not copy cannot be CAS-pinned (the
  // destination must be one of our uploads) — ask again next sweep.
  if (!r.pinned) return { state: 'undecided', why: r.why || 'could not keep a copy' };
  const cas = pinLogo || ((a) => require('../api/dexvra').pinLogo(a));
  let moved = false;
  try {
    moved = await cas({ chain: row.chain, address: row.address, fromUrl: cur, toUrl: r.url });
  } catch (e) {
    return { state: 'undecided', why: `the pin was refused: ${(e && e.message) || e}` };
  }
  return moved ? { state: 'healed', url: r.url, from: r.from, source: r.source, was: cur } : { state: 'kept' };
}

/**
 * WHAT WOULD THE HEAL FIND — read-only, for `listing:check`.
 *
 * "bagaimana agar masalah ini tidak terjadi lgi". The fix for `$W` was written
 * where no logo host could be reached, so whether the guarded fetch, the
 * proxy and the logo sources actually answer is a property of the SERVER's
 * egress — and the only honest place to learn it is on the box, with the same
 * code the bot runs. This is `healRow` with nothing kept and nothing written
 * (`pin:false`, no CAS), so the check measures the bot's own question rather
 * than a second copy of it — the `fonts:check` scar.
 *
 * States: ours · ours-missing · renders · fixable (the heal would move it,
 * from `source`) · none · undecided · blank · off.
 */
async function inspectRow(row, { deps: over = {} } = {}) {
  const cur = String((row && row.logoUrl) || '').trim();
  if (!enabled()) return { state: 'off' };
  if (!cur) return { state: 'blank' };
  if (mediaPath(cur)) {
    const a = await artFor(cur, realDeps(over));
    return a.bytes ? { state: 'ours' } : { state: 'ours-missing', why: a.why };
  }
  if (!/^https?:\/\//i.test(cur)) return { state: 'blank', why: 'not an http(s) url' };
  const r = await resolveX(row.chain, row.address, {}, { prefer: cur, keepRenderable: true, pin: false, deps: over });
  if (!r.ok) return { state: 'undecided', why: r.why };
  if (r.renders) return { state: 'renders' };
  if (!r.url) return { state: 'none', why: r.why };
  return { state: 'fixable', source: r.source, from: r.from, via: r.via };
}

module.exports = { resolveX, healRow, inspectRow, enabled, RESOLVE_MS, _artFor: artFor, _flakyWhy: flakyWhy };
