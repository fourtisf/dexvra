// Bot-API channel posting. The dexvra bot is a regular Bot API bot (no GramJS /
// premium emoji), so posts use plain sendMessage/sendPhoto with HTML + Unicode
// emoji. The bot must be an admin in each target channel. attach() wires the
// bot's telegram instance at boot.
const { CHANNELS } = require("../config/constants");
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

/** Send an HTML text post; optionally pin. Returns the message or null. */
async function sendText(channel, text, { replyTo, pin } = {}) {
  if (!tg) throw new Error("channels/post not attached to a bot");
  try {
    const msg = await tg.sendMessage(channel, text, {
      parse_mode: "HTML",
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

/** Send a photo (file_id or public URL) with an HTML caption; text fallback. */
async function sendPhoto(channel, photo, caption, { replyTo, pin } = {}) {
  if (!tg) throw new Error("channels/post not attached to a bot");
  if (!photo) return sendText(channel, caption, { replyTo, pin });
  try {
    const msg = await tg.sendPhoto(channel, photo, {
      caption,
      parse_mode: "HTML",
      ...replyParams(replyTo),
    });
    if (pin) tg.pinChatMessage(channel, msg.message_id, { disable_notification: true }).catch(() => {});
    return msg;
  } catch (e) {
    log.debug(`[channels] sendPhoto ${channel} failed (${e.message}) → text`);
    return sendText(channel, caption, { replyTo, pin });
  }
}

module.exports = { attach, sendText, sendPhoto, CHANNELS, isAttached: () => !!tg };
