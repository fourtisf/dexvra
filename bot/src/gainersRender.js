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
const gb = require("./gainersBanner");
const log = require("./helpers/logger");

const PREMIUM_IDS = gb.PREMIUM_IDS;
const CLASSIC_IDS = gb.CLASSIC_IDS;
const TEMPLATE_IDS = gb.TEMPLATE_IDS;

const isTemplate = (id) => gb.isTemplate(id);
const countOf = (id) => gb.countOf(id);
const labelOf = (id) => gb.labelOf(id);
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
 * @returns {Promise<null | {id, kind:"image", media: Buffer, mediaType: "photo", ext: "png", still: Buffer}>}
 *   `still` is the same PNG — the tweet reads it under that name.
 */
async function render({ template, coins, dateText = "", showPct = true, showMcap = true, showPrice = true, bgPath = null }) {
  try {
    const png = await gb.render({ template, coins, dateText, showPct, showMcap, showPrice, bgPath });
    return png ? { id: template, kind: "image", media: png, mediaType: "photo", ext: "png", still: png } : null;
  } catch (e) {
    log.warn(`[gainers] render ${template} failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  PREMIUM_IDS,
  CLASSIC_IDS,
  TEMPLATE_IDS,
  isTemplate,
  isPremium,
  countOf,
  labelOf,
  pickTemplate,
  render,
  available: () => gb.available(),
};
