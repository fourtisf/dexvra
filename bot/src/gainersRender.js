"use strict";
// One door onto the two Top-Gainers renderers: the still banners
// (gainersBanner.js, PNG) and the motion banners (gainersMotion.js, MP4 that
// Telegram plays as a looping GIF).
//
// The admin panel, the queue and the daily poster all ask the same four
// questions — which layout, how many coins, what does it render to, and how is
// it sent — and a second copy of the answer in each of them is how the preview
// comes to show a video while the daily post sends a PNG. So they ask here.
const gb = require("./gainersBanner");
const gm = require("./gainersMotion");
const log = require("./helpers/logger");

const FORMATS = ["animated", "image"];
const MOTION_IDS = gm.TEMPLATE_IDS;
const IMAGE_IDS = gb.TEMPLATE_IDS;
const TEMPLATE_IDS = [...MOTION_IDS, ...IMAGE_IDS];

const kindOf = (id) => (gm.isTemplate(id) ? "animated" : gb.isTemplate(id) ? "image" : null);
const isTemplate = (id) => kindOf(id) !== null;
const countOf = (id) => (gm.isTemplate(id) ? gm.countOf(id) : gb.countOf(id));
const labelOf = (id) => (gm.isTemplate(id) ? gm.labelOf(id) : gb.labelOf(id));
const idsOf = (format) => (format === "image" ? IMAGE_IDS : MOTION_IDS);

/**
 * Resolve a template choice to a concrete id. A concrete id is honoured as
 * given (the admin picked it). "random" draws from the rotation `pool` — only
 * the part of it in the chosen FORMAT, so a video setting never rolls a still —
 * and from every layout of that format when the pool has none.
 */
function pickTemplate(id, { pool = [], format = "animated", rng = Math.random } = {}) {
  if (isTemplate(id)) return id;
  const want = FORMATS.includes(format) ? format : "animated";
  const from = (Array.isArray(pool) ? pool : []).filter((t) => kindOf(t) === want);
  const list = from.length ? from : idsOf(want);
  return list[Math.floor(rng() * list.length) % list.length];
}

/**
 * Render a board. Never throws.
 *
 * @returns {Promise<null | {id, kind, media: Buffer, mediaType: "animation"|"photo", ext: "mp4"|"png", still: Buffer}>}
 *   `still` is always a PNG — the tweet and the fallback use it.
 *
 * A motion render that fails (no ffmpeg on the box, an encode error) degrades
 * to the SAME layout's final frame as a photo, and says so in the log: a
 * gainers post a day late is worse than one without motion.
 */
async function render({ template, coins, dateText = "", showPct = true, bgPath = null }) {
  try {
    if (gm.isTemplate(template)) {
      const opts = { template, coins, dateText, showPct, bgPath };
      const [media, still] = await Promise.all([gm.render(opts), gm.renderStill(opts)]);
      if (media && still) return { id: template, kind: "animated", media, mediaType: "animation", ext: "mp4", still };
      if (still) {
        log.warn(`[gainers] motion ${template} did not encode — sending its still frame instead`);
        return { id: template, kind: "image", media: still, mediaType: "photo", ext: "png", still };
      }
      return null;
    }
    const png = await gb.render({ template, coins, dateText, showPct, bgPath });
    return png ? { id: template, kind: "image", media: png, mediaType: "photo", ext: "png", still: png } : null;
  } catch (e) {
    log.warn(`[gainers] render ${template} failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  FORMATS,
  MOTION_IDS,
  IMAGE_IDS,
  TEMPLATE_IDS,
  kindOf,
  isTemplate,
  countOf,
  labelOf,
  pickTemplate,
  render,
  available: () => gb.available(),
};
