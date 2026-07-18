// Free-text + media routers. Dispatch to whichever flow is active on the
// session. Private-chat only. Registered LAST so specific actions win first.
const log = require("../helpers/logger");

const LISTING = new Set(["xpress_listing", "tiered_listing"]);

async function textRouter(ctx) {
  if (!ctx.chat || ctx.chat.type !== "private") return;
  const s = ctx.session || {};
  if (!s.type) return; // no active flow — ignore chatter
  const text = ctx.message && ctx.message.text ? ctx.message.text : "";
  // Let real commands fall through to their bot.command handlers (except /skip,
  // which flows consume as an inline "skip this field").
  if (text.startsWith("/") && text !== "/skip") return;

  try {
    if (LISTING.has(s.type)) return await require("./listing").handleText(ctx);
    if (s.type === "trend") return await require("./trending").handleText(ctx);
    if (s.type === "banner") return await require("./banner").handleText(ctx);
  } catch (e) {
    log.warn(`[text] ${s.type} handler: ${e.message}`);
  }
}

async function mediaRouter(ctx) {
  if (!ctx.chat || ctx.chat.type !== "private") return;
  const s = ctx.session || {};
  if (!s.type) return;
  try {
    if (LISTING.has(s.type)) return await require("./listing").handlePhoto(ctx);
    if (s.type === "banner") return await require("./banner").handlePhoto(ctx);
  } catch (e) {
    log.warn(`[media] ${s.type} handler: ${e.message}`);
  }
}

module.exports = { textRouter, mediaRouter };
