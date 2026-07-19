// Channel posting with premium emoji. Captions/text arrive as a PAYLOAD:
//   { text, entities }  — premium markup (rendered by templates.js) → try
//                         GramJS first (premium emoji animate), Bot API second
//                         (entities pass through; Telegram strips custom emoji
//                         for regular bots, leaving the unicode fallback)
//   { html }            — legacy HTML (admin-saved old template) → Bot API HTML
//   "string"            — legacy HTML string → Bot API HTML
// The bot must be an admin in each target channel; for GramJS the logged-in
// premium USER must be able to post there. attach() wires the bot's telegram
// instance at boot.
const { CHANNELS } = require("../config/constants");
const gramjs = require("../gramjs");
const log = require("../helpers/logger");

let tg = null;

function attach(telegram) {
  tg = telegram;
}

function replyParams(replyTo) {
  return replyTo
    ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
    : {};
}

/** Normalize a caption payload → { text, entities?, html? }. */
function norm(payload) {
  if (payload && typeof payload === "object") {
    if (payload.html != null) return { text: payload.html, html: payload.html };
    return { text: payload.text || "", entities: payload.entities || [] };
  }
  return { text: String(payload == null ? "" : payload), html: String(payload == null ? "" : payload) };
}

/** GramJS media compatibility: Buffers / local paths / URLs upload fine over
 *  MTProto; a Bot API file_id means nothing there. */
function gramMedia(media) {
  if (!media) return true; // text-only
  if (typeof media === "object" && media.source != null) return true;
  if (typeof media === "string" && /^https?:\/\//.test(media)) return true;
  return false;
}

async function viaGramJs(channel, media, p, { replyTo, pin }) {
  if (!p.entities || !gramjs.available() || !gramMedia(media)) return null;
  try {
    const msg = await gramjs.sendToChannel(channel, {
      text: p.text,
      entities: p.entities,
      media: media || null,
      replyTo,
      pin,
    });
    log.info(`[channels] gramjs → ${channel} #${msg.message_id}`);
    return msg;
  } catch (e) {
    log.warn(`[channels] gramjs ${channel} failed (${e.message}) → bot api`);
    return null;
  }
}

function botApiExtra(p, forCaption) {
  if (p.html != null) return { parse_mode: "HTML" };
  const ents = p.entities || [];
  if (!ents.length) return {};
  return forCaption ? { caption_entities: ents } : { entities: ents };
}

/** Send a text post; optionally pin. Returns { message_id, ... } or null. */
async function sendText(channel, payload, { replyTo, pin } = {}) {
  if (!tg) throw new Error("channels/post not attached to a bot");
  const p = norm(payload);
  const viaGram = await viaGramJs(channel, null, p, { replyTo, pin });
  if (viaGram) return viaGram;
  try {
    const msg = await tg.sendMessage(channel, p.text, {
      ...botApiExtra(p, false),
      disable_web_page_preview: true,
      ...replyParams(replyTo),
    });
    if (pin) tg.pinChatMessage(channel, msg.message_id, { disable_notification: true }).catch(() => {});
    return msg;
  } catch (e) {
    log.warn(`[channels] sendText ${channel}: ${e.message}`);
    return null;
  }
}

/** Send a photo ({source}, file_id, or URL) with a caption payload. */
async function sendPhoto(channel, photo, payload, { replyTo, pin } = {}) {
  if (!tg) throw new Error("channels/post not attached to a bot");
  if (!photo) return sendText(channel, payload, { replyTo, pin });
  const p = norm(payload);
  const viaGram = await viaGramJs(channel, photo, p, { replyTo, pin });
  if (viaGram) return viaGram;
  try {
    const msg = await tg.sendPhoto(channel, photo, {
      caption: p.text,
      ...botApiExtra(p, true),
      ...replyParams(replyTo),
    });
    if (pin) tg.pinChatMessage(channel, msg.message_id, { disable_notification: true }).catch(() => {});
    return msg;
  } catch (e) {
    log.debug(`[channels] sendPhoto ${channel} failed (${e.message}) → text`);
    return sendText(channel, payload, { replyTo, pin });
  }
}

/**
 * Send any media descriptor with a caption. `media` is:
 *   { type: 'photo'|'animation'|'video', source }  — animated posts (gif/mp4)
 *   a plain photo (source/file_id/URL)             — back-compat → sendPhoto
 * GramJS (premium emoji) handles any media via {source}; the Bot API path
 * dispatches to sendPhoto/sendAnimation/sendVideo. Falls back to text on error.
 */
async function sendMedia(channel, media, payload, { replyTo, pin } = {}) {
  if (!tg) throw new Error("channels/post not attached to a bot");
  if (!media) return sendText(channel, payload, { replyTo, pin });
  const type = media && media.type ? media.type : "photo";
  const source = media && media.source !== undefined ? media.source : media;
  if (type === "photo") return sendPhoto(channel, source, payload, { replyTo, pin });

  const p = norm(payload);
  const viaGram = await viaGramJs(channel, { source }, p, { replyTo, pin });
  if (viaGram) return viaGram;
  const method = type === "video" ? "sendVideo" : "sendAnimation";
  try {
    const msg = await tg[method](channel, source, {
      caption: p.text,
      ...botApiExtra(p, true),
      ...replyParams(replyTo),
    });
    if (pin) tg.pinChatMessage(channel, msg.message_id, { disable_notification: true }).catch(() => {});
    return msg;
  } catch (e) {
    log.debug(`[channels] ${method} ${channel} failed (${e.message}) → text`);
    return sendText(channel, payload, { replyTo, pin });
  }
}

module.exports = { attach, sendText, sendPhoto, sendMedia, CHANNELS, isAttached: () => !!tg };
