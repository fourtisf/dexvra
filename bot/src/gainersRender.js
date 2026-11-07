"use strict";
// One door onto the Top-Gainers renderer (gainersBanner.js, PNG).
//
// The admin panel, the queue and the daily poster all ask the same four
// questions — which layout, how many coins, what does it render to, and how is
// it sent — and a second copy of the answer in each of them is how the preview
// comes to show one thing while the daily post sends another. So they ask here.
//
// ⚠️ THE MOTION BOARDS ARE GONE. "hapus top gainer yang vidio ganti ke foto
// banner aja" (2026-10-03): the ten MP4 layouts were removed on the operator's
// call and the PREMIUM still set (gainersPremium.js, one design per count,
// Top 1 → Top 10) took their place on the panel's front screen. A stored
// `template` / `pool` that still names a motion id is dropped by
// gainersConfig's validation (an unknown id), so an install that was set to a
// video layout falls back to 🎲 random over the premium set — never to a
// render error on the daily post.
//
// 💠 PRISM is the one exception, and it is ADDITIVE (2026-11): the operator
// approved an animated set ("thats good buatkan dari top 1 sampai 10 premium
// visual dan annimasinya bagus") and asked for it as an extra row, not a
// replacement ("Tambahan saja"). So the premium still set stays the front set
// and the 🎲 random default, and a Prism id renders through gainersPrism.js
// to a looping MP4 plus its frame 0 as the still. See CLAUDE.md, "💠 Prism".
const gb = require("./gainersBanner");
const prism = require("./gainersPrism");
const log = require("./helpers/logger");

const PREMIUM_IDS = gb.PREMIUM_IDS;
const CLASSIC_IDS = gb.CLASSIC_IDS;
const PRISM_IDS = prism.IDS;
// Every id the panel may pick or store: the stills, then the Prism row.
const TEMPLATE_IDS = [...gb.TEMPLATE_IDS, ...PRISM_IDS];

const isPrism = (id) => prism.isTemplate(id);
const isTemplate = (id) => gb.isTemplate(id) || isPrism(id);
const countOf = (id) => (isPrism(id) ? prism.countOf(id) : gb.countOf(id));
const labelOf = (id) => (isPrism(id) ? prism.labelOf(id) : gb.labelOf(id));
const isPremium = (id) => PREMIUM_IDS.includes(id);

/**
 * Resolve a template choice to a concrete id. A concrete id is honoured as
 * given (the admin picked it). "random" draws from the rotation `pool`, and
 * from the PREMIUM set when the pool is empty — the set the operator asked
 * for is what an untouched install publishes.
 */
function pickTemplate(id, { pool = [], rng = Math.random } = {}) {
  if (isTemplate(id)) return id;
  const from = (Array.isArray(pool) ? pool : []).filter(isTemplate);
  const list = from.length ? from : PREMIUM_IDS;
  return list[Math.floor(rng() * list.length) % list.length];
}

/**
 * Render a board. Never throws.
 *
 * @returns {Promise<null | {id, kind:"image"|"animation", media: Buffer, mediaType: "photo"|"animation", ext: "png"|"mp4", still: Buffer}>}
 *   `still` is the board as a PNG — the tweet reads it under that name (for a
 *   still it IS `media`; for 💠 Prism it is the clip's frame 0).
 */
async function render({ template, coins, dateText = "", showPct = true, showMcap = true, showPrice = true, bgPath = null }) {
  if (isPrism(template)) return renderPrism({ template, coins, dateText, showPct, showMcap, showPrice });
  try {
    const png = await gb.render({ template, coins, dateText, showPct, showMcap, showPrice, bgPath });
    return png ? { id: template, kind: "image", media: png, mediaType: "photo", ext: "png", still: png } : null;
  } catch (e) {
    log.warn(`[gainers] render ${template} failed: ${e.message}`);
    return null;
  }
}

/**
 * 💠 Prism: the looping MP4, or — when this host cannot encode one (no
 * ffmpeg, a broken encoder) — its frame 0 as a still, so the operator's pick
 * still posts the approved design instead of nothing. Never throws.
 * (bgPath is not taken: Prism's poster panel IS its backdrop.)
 */
async function renderPrism(o) {
  try {
    const out = await prism.render(o);
    if (out) return { id: o.template, kind: "animation", ...out };
    const png = await prism.still(o);
    if (png) {
      log.warn(`[gainers] ${o.template}: the clip did not render — posting its still frame instead`);
      return { id: o.template, kind: "image", media: png, mediaType: "photo", ext: "png", still: png };
    }
    return null;
  } catch (e) {
    log.warn(`[gainers] render ${o.template} failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  PREMIUM_IDS,
  CLASSIC_IDS,
  PRISM_IDS,
  TEMPLATE_IDS,
  isTemplate,
  isPremium,
  isPrism,
  buttonOf: (id) => prism.buttonOf(id),
  countOf,
  labelOf,
  pickTemplate,
  render,
  available: () => gb.available(),
};
