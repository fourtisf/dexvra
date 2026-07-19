// GramJS (MTProto, user-account) channel sender — the ONLY way premium custom
// emoji actually render (a Telegram Premium USER session posts them; a regular
// bot gets them silently stripped). Mirrors fourtis' channels.js client
// lifecycle: string session on disk, 5-min cooldown after a failure, never
// interactive inside the bot process (scripts/gramjs-login.js creates the
// session once). Everything here is best-effort: callers fall back to Bot API.
const fss = require("node:fs");
const fs = require("node:fs/promises");
const { API_ID, API_HASH, GRAMJS_SESSION_FILE, GRAMJS_ENABLED } = require("./config/constants");
const premium = require("./premium");
const log = require("./helpers/logger");

let TG = null; // lazy-loaded 'telegram' module (heavy) — only when actually used
let client = null;
let clientFailedAt = 0;
const CLIENT_COOLDOWN_MS = 5 * 60 * 1000;

function lib() {
  if (TG === undefined) return null;
  if (TG) return TG;
  try {
    TG = require("telegram");
  } catch (e) {
    log.warn(`[gramjs] 'telegram' package unavailable: ${e.message}`);
    TG = undefined;
    return null;
  }
  return TG;
}

/** Cheap availability check — config + session file present (no connect). */
function available() {
  if (!GRAMJS_ENABLED || !API_ID || !API_HASH) return false;
  if (clientFailedAt && Date.now() - clientFailedAt < CLIENT_COOLDOWN_MS) return false;
  try {
    return fss.existsSync(GRAMJS_SESSION_FILE) && fss.statSync(GRAMJS_SESSION_FILE).size > 10;
  } catch {
    return false;
  }
}

async function getClient() {
  if (client && client.connected) return client;
  if (clientFailedAt && Date.now() - clientFailedAt < CLIENT_COOLDOWN_MS) {
    throw new Error(`gramjs on cooldown (${Math.ceil((CLIENT_COOLDOWN_MS - (Date.now() - clientFailedAt)) / 1000)}s)`);
  }
  const t = lib();
  if (!t) throw new Error("telegram package not installed");
  try {
    const session = (await fs.readFile(GRAMJS_SESSION_FILE, "utf8")).trim();
    if (!session) throw new Error(`empty session file ${GRAMJS_SESSION_FILE} — run: node scripts/gramjs-login.js`);
    const { TelegramClient } = t;
    const { StringSession } = require("telegram/sessions");
    client = new TelegramClient(new StringSession(session), API_ID, API_HASH, {
      connectionRetries: 5,
      timeout: 30,
    });
    await client.start({
      phoneNumber: async () => {
        throw new Error("session expired — run scripts/gramjs-login.js again");
      },
      phoneCode: async () => {
        throw new Error("session expired — run scripts/gramjs-login.js again");
      },
      password: async () => {
        throw new Error("session expired — run scripts/gramjs-login.js again");
      },
      onError: (err) => log.warn(`[gramjs] ${err.message}`),
    });
    clientFailedAt = 0;
    log.info("[gramjs] connected (premium emoji posting active)");
    return client;
  } catch (e) {
    clientFailedAt = Date.now();
    if (client) {
      try {
        client.disconnect();
      } catch {
        /* already down */
      }
      client = null;
    }
    throw e;
  }
}

/** Resolve media into something GramJS can upload. Bot API file_ids are NOT
 *  usable over MTProto → null (caller falls back to Bot API). */
async function resolveFile(media) {
  const t = lib();
  if (!media || !t) return null;
  const { CustomFile } = require("telegram/client/uploads");
  if (typeof media === "object" && media.source != null) {
    const src = media.source;
    if (Buffer.isBuffer(src)) return new CustomFile("photo.png", src.length, "", src);
    if (typeof src === "string" && fss.existsSync(src)) return src; // local path
    return null;
  }
  if (typeof media === "string" && /^https?:\/\//.test(media)) {
    try {
      const res = await fetch(media, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return new CustomFile("photo.png", buf.length, "", buf);
    } catch {
      return null;
    }
  }
  return null; // bot-api file_id or unknown → not usable here
}

/** Send a message/photo with premium-emoji entities to a channel the logged-in
 *  user can post in. Returns a Bot-API-shaped { message_id, chat } or throws. */
async function sendToChannel(channel, { text, entities, media, replyTo, pin }) {
  const c = await getClient();
  const t = lib();
  const target = await c.getEntity(channel);
  const formattingEntities = premium.toGramJs(entities || [], t.Api);
  let sent;
  const file = media ? await resolveFile(media) : null;
  if (media && !file) throw new Error("media not gramjs-compatible");
  if (file) {
    sent = await c.sendFile(target, {
      file,
      caption: text || "",
      formattingEntities,
      replyTo: replyTo || undefined,
      forceDocument: false,
      workers: 1,
    });
  } else {
    sent = await c.sendMessage(target, {
      message: text || "",
      formattingEntities,
      replyTo: replyTo || undefined,
      linkPreview: false,
    });
  }
  if (pin) {
    try {
      await c.pinMessage(target, sent.id, { notify: false });
    } catch (e) {
      log.debug(`[gramjs] pin: ${e.message}`);
    }
  }
  return { message_id: sent.id, chat: { id: Number(target.id) || target.id } };
}

module.exports = { available, getClient, sendToChannel, _resolveFile: resolveFile };
