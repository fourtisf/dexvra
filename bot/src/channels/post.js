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
const { CHANNELS, GROUP_CHAT } = require("../config/constants");
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

// Telegram media captions are capped at 1024 UTF-16 units — a longer caption
// makes sendPhoto/sendVideo THROW ("caption is too long"), which silently
// dropped the whole post to a text-only message (no banner image). Trim the
// caption to fit at a word boundary, dropping entities that fall past the cut,
// so the image always survives. Text-only posts (sendText) keep the 4096 limit.
const CAPTION_LIMIT = 1024;
function fitCaption(p) {
  if (!p || typeof p.text !== "string" || p.text.length <= CAPTION_LIMIT) return p;
  let text = p.text.slice(0, CAPTION_LIMIT - 8);
  text = text.replace(/[\uD800-\uDBFF]$/, ""); // never end on a split surrogate (emoji)
  const lastSpace = text.lastIndexOf(" ");
  if (lastSpace > CAPTION_LIMIT - 240) text = text.slice(0, lastSpace);
  text = text.trimEnd() + "…";
  const entities = (p.entities || []).filter((e) => e.offset + e.length <= text.length);
  return { ...p, text, entities };
}

/** GramJS media compatibility: Buffers / local paths / URLs upload fine over
 *  MTProto; a Bot API file_id means nothing there. */
function gramMedia(media) {
  if (!media) return true; // text-only
  if (typeof media === "object" && media.source != null) return true;
  if (typeof media === "string" && /^https?:\/\//.test(media)) return true;
  return false;
}

async function viaGramJs(channel, media, p, { replyTo, pin, mediaType }) {
  if (!p.entities || !gramjs.available() || !gramMedia(media)) return null;
  try {
    const msg = await gramjs.sendToChannel(channel, {
      text: p.text,
      entities: p.entities,
      media: media || null,
      // Carried all the way down: without it a GIF/MP4 uploads as a document and
      // Telegram renders a file card instead of an inline, autoplaying clip.
      mediaType,
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

/**
 * Pin a message we just posted — with the BOT, whatever posted it.
 *
 * Pinning is not author-restricted the way editing is: the bot can pin a
 * message the GramJS premium account sent, and vice versa. That matters,
 * because the premium account is frequently an admin for POSTING only, so its
 * own pin call fails with CHAT_ADMIN_REQUIRED while the post lands fine — which
 * looks exactly like "the bot doesn't pin".
 *
 * Awaited and logged, never fire-and-forget: a swallowed .catch(() => {}) is
 * why this went unnoticed. If BOTH transports are refused, the warning names
 * the channel and the reason, so the fix (give the bot "Pin Messages" in that
 * channel) is one read away.
 */
async function ensurePinned(channel, msg, alreadyPinned) {
  if (!msg || !msg.message_id || alreadyPinned) return Boolean(alreadyPinned);
  try {
    await tg.pinChatMessage(channel, msg.message_id, { disable_notification: true });
    log.info(`[channels] pinned ${channel}/${msg.message_id}`);
    return true;
  } catch (e) {
    log.warn(`[channels] pin ${channel}/${msg.message_id} FAILED: ${e.message} — is the bot an admin with "Pin Messages" there?`);
    return false;
  }
}

// ── Community-group mirror ───────────────────────────────────────────────────
// Every listing also lands in the group. FORWARD rather than re-post, for three
// reasons that all matter: a forward keeps the premium custom emoji (a Bot-API
// re-post would strip them), it costs one call with no media re-upload, and it
// carries the "Forwarded from Dexvra Listing Alerts" header — so the group post
// drives readers to the channel instead of competing with it.
//
// Best-effort by construction: a listing must never fail because the bot was
// removed from the group or the group went read-only. The failure is logged
// once with what to check, and the caller is told nothing.
async function mirrorToGroup(fromChannel, msg, { label = "listing" } = {}) {
  if (!tg || !GROUP_CHAT || !msg || !msg.message_id) return null;
  try {
    const fwd = await tg.forwardMessage(GROUP_CHAT, fromChannel, msg.message_id);
    log.info(`[channels] mirrored ${label} ${fromChannel}/${msg.message_id} → ${GROUP_CHAT}`);
    return fwd;
  } catch (e) {
    log.warn(`[channels] mirror ${label} → ${GROUP_CHAT} FAILED: ${e.message} — is the bot a member of the group, and can it post there?`);
    return null;
  }
}

/** Send a text post; optionally pin. Returns { message_id, ... } or null. */
async function sendText(channel, payload, { replyTo, pin } = {}) {
  if (!tg) throw new Error("channels/post not attached to a bot");
  const p = norm(payload);
  const viaGram = await viaGramJs(channel, null, p, { replyTo, pin });
  if (viaGram) {
    if (pin) await ensurePinned(channel, viaGram, viaGram.pinned);
    return viaGram;
  }
  try {
    const msg = await tg.sendMessage(channel, p.text, {
      ...botApiExtra(p, false),
      disable_web_page_preview: true,
      ...replyParams(replyTo),
    });
    if (pin) await ensurePinned(channel, msg, false);
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
  const p = fitCaption(norm(payload));
  const viaGram = await viaGramJs(channel, photo, p, { replyTo, pin, mediaType: "photo" });
  if (viaGram) {
    if (pin) await ensurePinned(channel, viaGram, viaGram.pinned);
    return viaGram;
  }
  try {
    const msg = await tg.sendPhoto(channel, photo, {
      caption: p.text,
      ...botApiExtra(p, true),
      ...replyParams(replyTo),
    });
    if (pin) await ensurePinned(channel, msg, false);
    return msg;
  } catch (e) {
    // Loud on purpose — a swallowed photo failure is exactly why a banner
    // silently degraded to a text-only post (previously logged at debug).
    log.warn(`[channels] sendPhoto ${channel} failed (${e.message}) → text-only fallback`);
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
  // PRESERVE the {source} wrapper for Buffers / local paths — Telegraf needs it
  // to treat the value as an upload. Passing a bare Buffer (or path string) made
  // sendPhoto/sendVideo misread it as a file_id and throw, silently dropping the
  // banner to a text-only post. Bare file_id / URL strings pass through as-is.
  const input = media && media.source !== undefined ? { source: media.source } : media;
  if (type === "photo") return sendPhoto(channel, input, payload, { replyTo, pin });

  const p = fitCaption(norm(payload));
  const viaGram = await viaGramJs(channel, input, p, { replyTo, pin, mediaType: type });
  if (viaGram) {
    if (pin) await ensurePinned(channel, viaGram, viaGram.pinned);
    return viaGram;
  }
  // Bot API: sendAnimation already marks the document animated (and converts a
  // GIF to MP4 server-side), so this path was never the broken one.
  const method = type === "video" ? "sendVideo" : "sendAnimation";
  try {
    const msg = await tg[method](channel, input, {
      caption: p.text,
      ...botApiExtra(p, true),
      ...replyParams(replyTo),
    });
    if (pin) await ensurePinned(channel, msg, false);
    return msg;
  } catch (e) {
    log.warn(`[channels] ${method} ${channel} failed (${e.message}) → text-only fallback`);
    return sendText(channel, payload, { replyTo, pin });
  }
}

/**
 * REPLACE the media of a post that is already out, keeping its caption.
 *
 * The one caller is services/logoRepair.js: a listing that went out drawing
 * the Dexvra mark because the token's artwork had not loaded yet gets that
 * artwork the moment it does, IN PLACE — a second post would be a duplicate
 * announcement, and deleting the first would break every link to it (the
 * buyer's receipt, the tweet's "Announce On X" reply, the group mirror).
 *
 * The caption is RE-SENT, not kept: Telegram's editMessageMedia replaces the
 * caption with whatever the new InputMedia carries, so omitting it would wipe
 * the whole listing card off the post while fixing its picture.
 *
 * Two transports, like every send here, and the order follows who POSTED it
 * (`msg.via`): the account that sent a message can always edit it; the other
 * can only if it holds "edit messages of others" in that channel. Both are
 * tried; the reasons travel back. Never throws.
 */
async function replaceMedia(channel, msg, media, payload) {
  if (!tg) throw new Error("channels/post not attached to a bot");
  const id = msg && msg.message_id;
  if (!id || !media) return { ok: false, why: "nothing to edit" };
  const type = media && media.type ? media.type : "photo";
  const input = media && media.source !== undefined ? { source: media.source } : media;
  const p = fitCaption(norm(payload));
  const viaBot = async () => {
    await tg.editMessageMedia(channel, id, undefined, {
      type,
      media: input,
      caption: p.text,
      ...(p.html != null ? { parse_mode: "HTML" } : p.entities && p.entities.length ? { caption_entities: p.entities } : {}),
    });
    return "bot";
  };
  const viaGram = async () => {
    if (!p.entities || !gramjs.available() || !gramMedia(input)) throw new Error("gramjs unavailable for this media");
    await gramjs.editChannelMedia(channel, id, { media: input, mediaType: type, text: p.text, entities: p.entities });
    return "gramjs";
  };
  const order = msg.via === "gramjs" ? [viaGram, viaBot] : [viaBot, viaGram];
  const whys = [];
  for (const attempt of order) {
    try {
      const via = await attempt();
      log.info(`[channels] media replaced ${channel}/${id} via ${via}`);
      return { ok: true, via };
    } catch (e) {
      // Nothing to change IS the outcome we wanted.
      if (/not modified/i.test((e && (e.errorMessage || e.message)) || "")) return { ok: true, via: "unchanged" };
      whys.push(`${attempt === viaBot ? "bot" : "gramjs"}: ${(e && (e.errorMessage || e.message)) || e}`);
    }
  }
  log.warn(`[channels] media replace ${channel}/${id} FAILED — ${whys.join("; ")}`);
  return { ok: false, why: whys.join("; ") };
}

// The attached Telegram, for the one caller that needs the instance rather than
// a send helper: the board refresh runs trendingPoster.runOnce(tg) in this
// process on behalf of @dexvraadminbot, which has no Telegram of its own that
// owns the board message.
// fitCaption is exported under its own name: it has real callers outside this
// module (the gainers preview, and the listing broadcast, which must cut a
// caption exactly where a channel post does) and an underscore said "test only"
// about a function two features already depend on.
// CAPTION_LIMIT is exported beside fitCaption because a second caller needs
// the NUMBER rather than the cut: the Mass DM flow lets a buyer attach a photo
// to text they have already composed, and a caption that will not fit must be
// REFUSED there (truncating two thirds of a paid broadcast is worse than losing
// the photo). One owner for the limit, or the two disagree the day Telegram
// moves it.
module.exports = { attach, sendText, sendPhoto, sendMedia, replaceMedia, fitCaption, CAPTION_LIMIT, ensurePinned, mirrorToGroup, CHANNELS, GROUP_CHAT, isAttached: () => !!tg, telegram: () => tg };
