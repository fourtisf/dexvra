// Locking and unlocking a group for the duration of a raid.
//
// THIS IS THE ONLY PART OF THE RAID THAT CAN HURT A CUSTOMER. A lock that
// outlives its raid silences a paying project's community with no error
// anywhere — the chat simply goes quiet, and nobody files a bug about silence.
// Everything below is shaped by that:
//
//  • The chat's CURRENT permissions are read and stored BEFORE anything is
//    changed, and the restore hands back exactly that object — including
//    permission keys this codebase has never heard of. Telegram keeps adding
//    them, and a hand-written "unlocked" default would quietly rewrite a
//    customer's group rules (re-enabling media in a text-only chat, say).
//  • The fallback default exists ONLY for a raid with no snapshot, and it is
//    deliberately permissive: leaving a group locked is far worse than handing
//    back a slightly wider permission set.
//  • unlock() never throws and is idempotent, because four different paths call
//    it and the one that matters is whichever actually runs.
const { isFatalChatError } = require("../group/fatalChatError");
const log = require("../helpers/logger");

// Everything off — except can_invite_users, which was never ours to take.
// Telegram exempts administrators from setChatPermissions automatically, so the
// raid host keeps talking while the room is quiet.
const LOCKED = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_pin_messages: false,
  can_invite_users: true,
};

// Used ONLY when there is no snapshot to restore. Permissive on purpose.
const FALLBACK_UNLOCKED = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: false,
  can_pin_messages: false,
  can_invite_users: true,
};

/**
 * Can we lock this chat at all? → { ok, reason }
 *
 * Checked when the admin switches the lock ON, not at launch — so nobody finds
 * out it was impossible only after telling their group a raid is coming.
 */
async function canLock(telegram, chatId, chatType) {
  // A basic group ACCEPTS setChatPermissions and then never actually restricts
  // anyone: a silent no-op, which is the worst possible answer here.
  if (chatType !== "supergroup") {
    return { ok: false, reason: "Telegram only supports chat locking in supergroups. Upgrade the group first (adding an admin usually does it)." };
  }
  try {
    const me = await telegram.getMe();
    const m = await telegram.getChatMember(chatId, me.id);
    if (!m || m.status !== "administrator") return { ok: false, reason: "Make me an admin of this group first." };
    if (!m.can_restrict_members) return { ok: false, reason: 'I need the "Ban users" permission to lock the chat.' };
    return { ok: true, reason: "" };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || "couldn't check my permissions" };
  }
}

/**
 * Read the chat's permissions as they are RIGHT NOW.
 * Deliberately separate from applyLock so the caller can persist the snapshot
 * before anything in the chat changes.
 */
async function snapshot(telegram, chatId) {
  try {
    const chat = await telegram.getChat(chatId);
    return (chat && chat.permissions) || null;
  } catch (e) {
    log.warn(`[raid] couldn't read permissions for ${chatId} before locking (${e && e.message}) — restore will use safe defaults`);
    return null;
  }
}

async function applyLock(telegram, chatId) {
  try {
    await telegram.setChatPermissions(chatId, LOCKED);
    log.info(`[raid] locked group ${chatId}`);
    return { ok: true, error: null };
  } catch (e) {
    log.error(`[raid] lock failed for ${chatId}: ${e && e.message}`);
    return { ok: false, error: (e && e.message) || "lock failed" };
  }
}

/**
 * Hand the chat back exactly what we took.
 *
 * A FAILED unlock returns ok:false so the caller leaves `locked: true` and the
 * next boot sweep retries — clearing the flag would mark the group free while
 * it is still silenced. The one exception is a fatal chat error: there is no
 * group left to unlock, so it reports ok with `unreachable` rather than
 * retrying forever.
 */
async function unlock(telegram, chatId, prevPermissions) {
  const restore = prevPermissions && typeof prevPermissions === "object" && Object.keys(prevPermissions).length
    ? prevPermissions
    : FALLBACK_UNLOCKED;
  try {
    await telegram.setChatPermissions(chatId, restore);
    log.info(`[raid] unlocked group ${chatId} (${restore === FALLBACK_UNLOCKED ? "safe defaults" : "restored snapshot"})`);
    return { ok: true, error: null };
  } catch (e) {
    if (isFatalChatError(e)) {
      log.warn(`[raid] unlock skipped for ${chatId} — chat unreachable (${e && e.message})`);
      return { ok: true, error: null, unreachable: true };
    }
    log.error(`[raid] UNLOCK FAILED for ${chatId}: ${e && e.message} — will retry on the next boot sweep`);
    return { ok: false, error: (e && e.message) || "unlock failed" };
  }
}

module.exports = { canLock, snapshot, applyLock, unlock, LOCKED, FALLBACK_UNLOCKED };
