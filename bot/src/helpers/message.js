// User-facing Telegram helpers. Enforces the fourtis "single live card" UX:
// each step deletes the previous bot message and sends a fresh one, so the flow
// feels like one updating message. All text is HTML (parse_mode:"HTML").
const log = require("./logger");

const HTML = { parse_mode: "HTML", disable_web_page_preview: true };

/** answerCbQuery, swallowing the "query is too old" errors on stale taps. */
async function answer(ctx, text, extra) {
  try {
    await ctx.answerCbQuery(text, extra);
  } catch {
    /* stale / double-tap */
  }
}

async function deleteLatest(ctx) {
  const id = ctx.session && ctx.session.latest_bot_message;
  if (!id) return;
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, id);
  } catch {
    /* already gone / too old */
  }
  if (ctx.session) ctx.session.latest_bot_message = null;
}

/** Delete the previous card, send a fresh text card, remember its id. */
async function sendCard(ctx, text, keyboard, opts = {}) {
  await deleteLatest(ctx);
  try {
    const msg = await ctx.reply(text, { ...HTML, ...opts, ...(keyboard || {}) });
    if (ctx.session) ctx.session.latest_bot_message = msg.message_id;
    return msg;
  } catch (e) {
    log.warn(`[msg] sendCard failed: ${e.message}`);
    return null;
  }
}

/** Same, but with a photo (used for the listing review card). `photo` is a
 *  file_id, URL string, or { source }. Falls back to a text card on failure. */
async function sendPhotoCard(ctx, photo, caption, keyboard, opts = {}) {
  await deleteLatest(ctx);
  try {
    const msg = await ctx.replyWithPhoto(photo, { caption, ...HTML, ...opts, ...(keyboard || {}) });
    if (ctx.session) ctx.session.latest_bot_message = msg.message_id;
    return msg;
  } catch (e) {
    log.debug(`[msg] photo card failed (${e.message}) — falling back to text`);
    return sendCard(ctx, caption, keyboard, opts);
  }
}

/** Plain reply that does NOT touch the single-card slot (transient notices). */
async function toast(ctx, text, opts = {}) {
  try {
    return await ctx.reply(text, { ...HTML, ...opts });
  } catch {
    return null;
  }
}

/** Extract the file_id of any media in the incoming message (photo/doc/anim/video). */
function getMediaFileId(ctx) {
  const m = (ctx && ctx.message) || {};
  if (m.photo && m.photo.length) return m.photo[m.photo.length - 1].file_id;
  if (m.document) return m.document.file_id;
  if (m.animation) return m.animation.file_id;
  if (m.video) return m.video.file_id;
  return null;
}

module.exports = { answer, deleteLatest, sendCard, sendPhotoCard, toast, getMediaFileId, HTML };
