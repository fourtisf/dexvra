// @dexvraadminbot — admin-only template editor. Lets admins edit every bot
// message + channel-post layout (via src/templates.js) and upload the /start
// banner image, all at runtime (main bot auto-refreshes within ~30s, no redeploy).
// Runs as its own process/token, separate from the main bot.
const { Telegraf, Markup, session } = require("telegraf");
const { promises: fs } = require("node:fs");
const fss = require("node:fs");
const path = require("node:path");
const { isAdminUser, ADMIN_BOT_TOKEN } = require("../config/constants");
const { getMediaFileId } = require("../helpers/message");
const { escapeHtml } = require("../helpers/format");
const { DATA_DIR } = require("../helpers/persist");
const bcStore = require("../broadcast/store");
const bannerTpl = require("../bannerTemplate");
const tpl = require("../templates");
const log = require("../helpers/logger");

const GROUPS = { msg: "Bot Messages", post: "Channel Posts" };
const groupIdOf = (key) => Object.keys(GROUPS).find((g) => GROUPS[g] === tpl.meta(key).group) || "msg";
const HTML = { parse_mode: "HTML", disable_web_page_preview: true };

function guard(ctx) {
  if (ctx.chat && ctx.chat.type !== "private") return false;
  if (!isAdminUser(ctx)) return false;
  return true;
}

// ── Keyboards ────────────────────────────────────────────────────────────────
function mainKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📝 Bot Messages", "grp:msg")],
    [Markup.button.callback("📢 Channel Posts", "grp:post")],
    [Markup.button.callback("🖼 Banner Image", "banner")],
    [Markup.button.callback("🎨 Channel Banner Artwork", "bt")],
    [Markup.button.callback("📣 Broadcast", "bc")],
  ]);
}
function groupKb(gid) {
  const g = tpl.groups()[GROUPS[gid]] || [];
  const rows = g.map((k) => [
    Markup.button.callback(`${tpl.isCustom(k) ? "✏️ " : ""}${tpl.meta(k).label}`, `v:${k}`),
  ]);
  rows.push([Markup.button.callback("⬅ Back", "home")]);
  return Markup.inlineKeyboard(rows);
}
function viewKb(key) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✏️ Edit", `e:${key}`), Markup.button.callback("♻️ Reset default", `r:${key}`)],
    [Markup.button.callback("⬅ Back", `grp:${groupIdOf(key)}`)],
  ]);
}
function bannerKb() {
  const has = bannerExists();
  return Markup.inlineKeyboard([
    [Markup.button.callback(has ? "🔄 Replace banner" : "⬆ Upload banner", "bup")],
    ...(has ? [[Markup.button.callback("🗑 Remove banner", "brm")]] : []),
    [Markup.button.callback("⬅ Back", "home")],
  ]);
}

function bannerExists() {
  try {
    return fss.existsSync(tpl.BANNER_PATH) && fss.statSync(tpl.BANNER_PATH).size > 0;
  } catch {
    return false;
  }
}

// ── Channel banner artwork (fourtis-style template compositor) ───────────────
function btText() {
  const st = (k) => (bannerTpl.hasUploaded(k) ? "✅ custom uploaded" : "💎 bundled default");
  const s = bannerTpl.getSettings("listing");
  return (
    `🎨 <b>Channel Banner Artwork</b>\n\n` +
    `Upload a <b>designed banner image</b> (illustration/3D art — like the fourtis robot banner). ` +
    `For every purchased listing the bot pastes the token's <b>logo</b> into the artwork's circle spot ` +
    `and can overlay the <b>$TICKER + name</b>.\n\n` +
    `Listing artwork: ${st("listing")}\nTrending artwork: ${st("trending")}\n\n` +
    `Logo spot: <b>${s.logoSize}px</b> at (${s.logoX}, ${s.logoY})  ·  Text overlay: <b>${s.showText ? "on" : "off"}</b>\n` +
    `No artwork uploaded → the auto-generated banner is used instead.`
  );
}
function btKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬆ Upload LISTING artwork", "bt_up:listing")],
    [Markup.button.callback("⬆ Upload TRENDING artwork", "bt_up:trending")],
    [
      Markup.button.callback("📐 Logo spot", "bt_logo:listing"),
      Markup.button.callback("🔤 Text overlay", "bt_text:listing"),
    ],
    [
      Markup.button.callback("👁 Preview listing", "bt_prev:listing"),
      Markup.button.callback("👁 Preview trending", "bt_prev:trending"),
    ],
    [
      Markup.button.callback("🗑 Remove listing", "bt_rm:listing"),
      Markup.button.callback("🗑 Remove trending", "bt_rm:trending"),
    ],
    [Markup.button.callback("⬅ Back", "home")],
  ]);
}

function sampleLogo() {
  try {
    const cv = require("@napi-rs/canvas");
    const c = cv.createCanvas(300, 300);
    const g = c.getContext("2d");
    const lg = g.createLinearGradient(0, 0, 300, 300);
    lg.addColorStop(0, "#7C3AED");
    lg.addColorStop(1, "#22D3EE");
    g.fillStyle = lg;
    g.fillRect(0, 0, 300, 300);
    g.fillStyle = "rgba(255,255,255,.95)";
    g.font = "800 170px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("J", 150, 158);
    return c.toBuffer("image/png");
  } catch {
    return null;
  }
}

async function btPreview(ctx, kind) {
  if (!bannerTpl.hasTemplate(kind)) {
    return ctx.reply(`❌ No ${kind} artwork uploaded yet. Tap ⬆ Upload first.`).catch(() => {});
  }
  const buf = await bannerTpl.compose(kind, sampleLogo(), { symbol: "SAMPLE", name: "Sample Token" });
  if (!buf) return ctx.reply("⚠️ Preview failed — check pm2 logs.").catch(() => {});
  await ctx
    .replyWithPhoto({ source: buf }, { caption: `👁 ${kind} preview — adjust 📐 Logo spot / 🔤 Text overlay until the logo sits in the ring.` })
    .catch(() => {});
}

// ── Views ────────────────────────────────────────────────────────────────────
function homeText() {
  return "🛠 <b>Dexvra Admin — Templates</b>\n\nEdit any bot message or channel-post layout. Changes go live within ~30s (no redeploy). Pick a category:";
}
function viewText(key) {
  const m = tpl.meta(key);
  const raw = tpl.getRaw(key);
  const val = tpl.getRawValue(key);
  const premiumNote =
    val && typeof val === "object" && val.entities && val.entities.length
      ? `\n💎 Saved with ${val.entities.filter((e) => e.type === "custom_emoji").length} premium emoji (entities preserved).\n`
      : "";
  const ph = m.ph.length ? m.ph.map((p) => `{${p}}`).join(" ") : "(none)";
  return (
    `<b>${escapeHtml(m.label)}</b> — ${tpl.isCustom(key) ? "✏️ custom" : "default"}\n\n` +
    `Placeholders: <code>${escapeHtml(ph)}</code>\n${premiumNote}\n` +
    `Current:\n<pre>${escapeHtml(raw)}</pre>\n\n` +
    `Tap <b>✏️ Edit</b> to change it.`
  );
}

async function edit(ctx, text, kb) {
  try {
    await ctx.editMessageText(text, { ...HTML, ...(kb || {}) });
  } catch {
    await ctx.reply(text, { ...HTML, ...(kb || {}) });
  }
}

async function saveBanner(telegram, fileId) {
  await downloadTo(telegram, fileId, tpl.BANNER_PATH);
}
async function downloadTo(telegram, fileId, destPath) {
  const link = await telegram.getFileLink(fileId);
  const res = await fetch(link.href || String(link), { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, buf);
}

// ── Broadcast ────────────────────────────────────────────────────────────────
function bcControlKb(count) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`✅ Send to all (${count})`, "bc_send")],
    [Markup.button.callback("🧪 Test (me only)", "bc_test")],
    [Markup.button.callback("❌ Cancel", "bc_cancel")],
  ]);
}

/** Poll a broadcast job and live-edit a status message until it completes. */
function pollProgress(telegram, chatId, messageId, jobId) {
  const started = Date.now();
  let lastText = "";
  const iv = setInterval(async () => {
    const job = bcStore.loadJob(jobId);
    if (!job || Date.now() - started > 20 * 60 * 1000) {
      clearInterval(iv);
      return;
    }
    const done = job.status === "completed";
    const pct = job.total ? Math.round((job.cursor / job.total) * 100) : 100;
    const text = done
      ? `✅ <b>Broadcast complete</b>${job.test ? " (test)" : ""}\nSent: <b>${job.sent}</b>  ·  Failed: <b>${job.failed}</b>  ·  Total: <b>${job.total}</b>`
      : `📣 <b>Broadcasting…</b>${job.test ? " (test)" : ""}\nProgress: <b>${pct}%</b> (${job.cursor}/${job.total})\nSent: ${job.sent}  ·  Failed: ${job.failed}`;
    if (text !== lastText) {
      lastText = text;
      try {
        await telegram.editMessageText(chatId, messageId, undefined, text, HTML);
      } catch {
        /* not modified / too old */
      }
    }
    if (done) clearInterval(iv);
  }, 3000);
}

async function launchBroadcast(ctx, test) {
  const draft = ctx.session.bcDraft;
  if (!draft) return ctx.reply("Nothing composed. Tap 📣 Broadcast to start.").catch(() => {});
  const targets = test ? [String(ctx.from.id)] : bcStore.audience();
  if (!targets.length) {
    return ctx.reply("No /start users yet — nobody to broadcast to.").catch(() => {});
  }
  let mediaPath = null;
  if (draft.adminFileId) {
    try {
      mediaPath = path.join(bcStore.BC_DIR, `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.img`);
      await downloadTo(ctx.telegram, draft.adminFileId, mediaPath);
    } catch (e) {
      return ctx.reply(`⚠️ Couldn't prepare the image: ${e.message}`).catch(() => {});
    }
  }
  const job = await bcStore.createJob({
    text: draft.text || "",
    entities: draft.entities || [],
    mediaPath,
    createdBy: String(ctx.from.id),
    createdByUsername: ctx.from.username,
    targets,
    test,
  });
  ctx.session.bcDraft = null;
  const msg = await ctx.reply(
    `📣 <b>Broadcast queued</b> to <b>${targets.length}</b> user(s). Delivering via the main bot…`,
    HTML,
  );
  pollProgress(ctx.telegram, msg.chat.id, msg.message_id, job.id);
}

// ── Bot ──────────────────────────────────────────────────────────────────────
function build() {
  const bot = new Telegraf(ADMIN_BOT_TOKEN, { handlerTimeout: 60000 });
  bot.use(session({ getSessionKey: (ctx) => (ctx.from && ctx.chat ? `${ctx.from.id}:${ctx.chat.id}` : undefined), defaultSession: () => ({}) }));

  const start = async (ctx) => {
    if (!guard(ctx)) return ctx.reply("⛔ Admins only.").catch(() => {});
    ctx.session = {};
    await ctx.reply(homeText(), { ...HTML, ...mainKb() });
  };
  bot.start(start);
  bot.command("home", start);

  bot.action("home", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session = {};
    await edit(ctx, homeText(), mainKb());
  });

  bot.action(/^grp:(msg|post)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, `<b>${GROUPS[ctx.match[1]]}</b>\n\nPick a template:`, groupKb(ctx.match[1]));
  });

  bot.action(/^v:(.+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!tpl.keys().includes(key)) return;
    await edit(ctx, viewText(key), viewKb(key));
  });

  bot.action(/^e:(.+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!tpl.keys().includes(key)) return;
    ctx.session.awaitingTemplate = key;
    const m = tpl.meta(key);
    const ph = m.ph.length ? m.ph.map((p) => `{${p}}`).join(" ") : "(none)";
    await ctx.reply(
      `✏️ Send the new text for <b>${escapeHtml(m.label)}</b>.\n\n` +
        `Formatting: <code>**bold**</code>, <code>[text](url)</code>, <code>\`code\`</code>, ` +
        `<code>[😀](emoji/ID)</code> for premium emoji — or just paste a message that ` +
        `<b>contains real premium emoji</b> and they'll be preserved as-is.\n\n` +
        `Placeholders: <code>${escapeHtml(ph)}</code>\n\nSend /cancel to abort.`,
      HTML,
    );
  });

  bot.action(/^r:(.+)$/, async (ctx) => {
    ctx.answerCbQuery("Reset to default").catch(() => {});
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!tpl.keys().includes(key)) return;
    await tpl.resetTemplate(key);
    await edit(ctx, viewText(key), viewKb(key));
  });

  bot.action("banner", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(
      ctx,
      `🖼 <b>Banner Image</b>\n\nShown on /start in the main bot.\nStatus: ${bannerExists() ? "✅ set" : "— none"}`,
      bannerKb(),
    );
  });
  bot.action("bup", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBanner = true;
    await ctx.reply("⬆ Send the banner <b>image as a photo</b>. Send /cancel to abort.", HTML);
  });
  bot.action("brm", async (ctx) => {
    ctx.answerCbQuery("Removed").catch(() => {});
    if (!guard(ctx)) return;
    try {
      await fs.unlink(tpl.BANNER_PATH);
    } catch {
      /* already gone */
    }
    await edit(ctx, `🖼 <b>Banner Image</b>\n\nStatus: — none`, bannerKb());
  });

  // ── Channel banner artwork (template compositor) ──
  bot.action("bt", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, btText(), btKb());
  });
  bot.action(/^bt_up:(listing|trending)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBt = { mode: "upload", kind: ctx.match[1] };
    await ctx.reply(
      `⬆ Send the <b>${ctx.match[1]} artwork</b> as a photo or file (PNG/JPG, ~1280×640 recommended). Send /cancel to abort.`,
      HTML,
    );
  });
  bot.action(/^bt_logo:(listing|trending)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBt = { mode: "logo", kind: ctx.match[1] };
    const s = bannerTpl.getSettings(ctx.match[1]);
    await ctx.reply(
      `📐 <b>Logo spot</b> — where the token logo is pasted into the artwork.\n` +
        `Current: <b>${s.logoSize}px</b> at (${s.logoX}, ${s.logoY})\n\n` +
        `Send: <code>SIZE X,Y</code> — e.g. <code>180 925,240</code>\n` +
        `(<code>center</code> works for X or Y: <code>200 center,center</code>)\n\nApplies to BOTH artworks. /cancel to abort.`,
      HTML,
    );
  });
  bot.action(/^bt_text:(listing|trending)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBt = { mode: "text", kind: ctx.match[1] };
    const s = bannerTpl.getSettings(ctx.match[1]);
    await ctx.reply(
      `🔤 <b>Text overlay</b> ($TICKER + token name on the artwork).\n` +
        `Current: <b>${s.showText ? "on" : "off"}</b>, ${s.tickerFontSize}px at (${s.tickerX}, ${s.tickerY})\n\n` +
        `Send: <code>SIZE X,Y</code> — e.g. <code>44 60,300</code>\n` +
        `Or <code>off</code> / <code>on</code> to toggle it.\n\n/cancel to abort.`,
      HTML,
    );
  });
  bot.action(/^bt_prev:(listing|trending)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await btPreview(ctx, ctx.match[1]);
  });
  bot.action(/^bt_rm:(listing|trending)$/, async (ctx) => {
    ctx.answerCbQuery("Removed").catch(() => {});
    if (!guard(ctx)) return;
    await bannerTpl.removeTemplate(ctx.match[1]);
    await edit(ctx, btText(), btKb());
  });

  bot.action("bc", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBroadcast = true;
    ctx.session.bcDraft = null;
    await ctx.reply(
      `📣 <b>Broadcast</b>\n\nSend the message to broadcast to all /start users — <b>text</b>, or a <b>photo with a caption</b> (HTML allowed). /cancel to abort.`,
      HTML,
    );
  });
  bot.action("bc_send", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await launchBroadcast(ctx, false);
  });
  bot.action("bc_test", async (ctx) => {
    ctx.answerCbQuery("Sending test to you").catch(() => {});
    if (!guard(ctx)) return;
    await launchBroadcast(ctx, true);
  });
  bot.action("bc_cancel", async (ctx) => {
    ctx.answerCbQuery("Cancelled").catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.bcDraft = null;
    ctx.session.awaitingBroadcast = false;
    await edit(ctx, homeText(), mainKb());
  });

  bot.command("cancel", async (ctx) => {
    if (!guard(ctx)) return;
    ctx.session.awaitingTemplate = null;
    ctx.session.awaitingBanner = false;
    ctx.session.awaitingBroadcast = false;
    ctx.session.awaitingBt = null;
    ctx.session.bcDraft = null;
    await ctx.reply("Cancelled.", { ...HTML, ...mainKb() });
  });

  // Text = new template value (when awaiting)
  bot.on("text", async (ctx) => {
    if (!guard(ctx)) return;
    const text = ctx.message.text || "";
    if (text.startsWith("/")) return; // commands handled above
    const entities = ctx.message.entities || [];
    // Banner-artwork settings input (logo spot / text overlay)
    if (ctx.session.awaitingBt && ctx.session.awaitingBt.mode !== "upload") {
      const { mode, kind } = ctx.session.awaitingBt;
      ctx.session.awaitingBt = null;
      const low = text.trim().toLowerCase();
      try {
        if (mode === "text" && (low === "off" || low === "on")) {
          await bannerTpl.updateSettings("listing", { showText: low === "on" });
          await bannerTpl.updateSettings("trending", { showText: low === "on" });
          await ctx.reply(`✅ Text overlay <b>${low}</b>.`, HTML);
        } else {
          const m = low.match(/^(\d+)\s+(center|-?\d+)\s*,\s*(center|-?\d+)$/);
          if (!m) return ctx.reply("❌ Format: <code>SIZE X,Y</code> — e.g. <code>180 925,240</code>", HTML).catch(() => {});
          const size = Number(m[1]);
          const x = m[2] === "center" ? "center" : Number(m[2]);
          const y = m[3] === "center" ? "center" : Number(m[3]);
          const patch =
            mode === "logo"
              ? { logoSize: size, logoX: x, logoY: y }
              : { tickerFontSize: size, tickerX: x, tickerY: y, showText: true };
          // spot settings apply to both artworks (same layout family)
          await bannerTpl.updateSettings("listing", patch);
          await bannerTpl.updateSettings("trending", patch);
          await ctx.reply(`✅ Saved. Previewing…`, HTML);
        }
        if (bannerTpl.hasTemplate(kind)) await btPreview(ctx, kind);
      } catch (e) {
        await ctx.reply(`⚠️ ${e.message}`).catch(() => {});
      }
      return;
    }
    if (ctx.session.awaitingBroadcast) {
      ctx.session.awaitingBroadcast = false;
      ctx.session.bcDraft = { text, entities };
      // rendered preview — re-send with the admin's entities so premium emoji show
      const prevExtra = entities.length
        ? { entities, disable_web_page_preview: true }
        : HTML;
      await ctx.reply(text, prevExtra).catch(() => {});
      await ctx.reply("Send this broadcast?", bcControlKb(bcStore.audience().length));
      return;
    }
    const key = ctx.session.awaitingTemplate;
    if (!key) return;
    ctx.session.awaitingTemplate = null;
    // A message pasted WITH entities (premium emoji / formatting) is stored
    // verbatim as {text, entities} so custom emoji survive; plain text stays a
    // string and is rendered as premium markup by the main bot.
    const value = entities.length ? { text, entities } : text;
    await tpl.setTemplate(key, value);
    const nPrem = entities.filter((e) => e.type === "custom_emoji").length;
    log.info(
      `[adminbot] template '${key}' updated by @${ctx.from.username || ctx.from.id} (${text.length} chars, ${entities.length} entities, ${nPrem} premium emoji)`,
    );
    await ctx.reply(
      `✅ Saved <b>${escapeHtml(tpl.meta(key).label)}</b>${nPrem ? ` with 💎 ${nPrem} premium emoji` : ""}. It goes live within ~30s.`,
      HTML,
    );
    await ctx.reply(viewText(key), { ...HTML, ...viewKb(key) });
  });

  // Photo = banner upload (when awaiting)
  bot.on(["photo", "document"], async (ctx) => {
    if (!guard(ctx)) return;
    // Channel banner artwork upload
    if (ctx.session.awaitingBt && ctx.session.awaitingBt.mode === "upload") {
      const { kind } = ctx.session.awaitingBt;
      const fileId = getMediaFileId(ctx);
      if (!fileId) return ctx.reply("Couldn't read that image — send it as a photo or file.").catch(() => {});
      ctx.session.awaitingBt = null;
      try {
        const link = await ctx.telegram.getFileLink(fileId);
        const res = await fetch(link.href || String(link), { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`download ${res.status}`);
        await bannerTpl.saveTemplate(kind, Buffer.from(await res.arrayBuffer()));
        log.info(`[adminbot] ${kind} banner artwork uploaded by @${ctx.from.username || ctx.from.id}`);
        await ctx.reply(
          `✅ <b>${kind} artwork saved.</b> Now set 📐 Logo spot so the token logo lands in the circle, then 👁 Preview.`,
          { ...HTML, ...btKb() },
        );
        await btPreview(ctx, kind);
      } catch (e) {
        await ctx.reply(`⚠️ Couldn't save the artwork: ${e.message}`).catch(() => {});
      }
      return;
    }
    if (ctx.session.awaitingBroadcast) {
      const fileId = getMediaFileId(ctx);
      if (!fileId) return ctx.reply("Couldn't read that image — send it as a photo.").catch(() => {});
      ctx.session.awaitingBroadcast = false;
      const capEntities = ctx.message.caption_entities || [];
      ctx.session.bcDraft = { adminFileId: fileId, text: ctx.message.caption || "", entities: capEntities };
      try {
        const prevExtra = capEntities.length
          ? { caption: ctx.message.caption, caption_entities: capEntities }
          : ctx.message.caption
            ? { caption: ctx.message.caption, parse_mode: "HTML" }
            : {};
        await ctx.replyWithPhoto(fileId, prevExtra);
      } catch {
        /* preview best-effort */
      }
      await ctx.reply("Send this broadcast?", bcControlKb(bcStore.audience().length));
      return;
    }
    if (!ctx.session.awaitingBanner) return;
    const fileId = getMediaFileId(ctx);
    if (!fileId) return ctx.reply("Couldn't read that image — send it as a photo.").catch(() => {});
    ctx.session.awaitingBanner = false;
    try {
      await saveBanner(ctx.telegram, fileId);
      log.info(`[adminbot] banner updated by @${ctx.from.username || ctx.from.id}`);
      await ctx.reply("✅ Banner saved. It shows on /start within ~30s.", { ...HTML, ...bannerKb() });
    } catch (e) {
      await ctx.reply(`⚠️ Couldn't save the banner: ${e.message}`, HTML);
    }
  });

  bot.catch((err, ctx) => log.error(`[adminbot] ${ctx && ctx.updateType}: ${err && err.message}`));
  return bot;
}

async function startAdminBot() {
  if (!ADMIN_BOT_TOKEN) {
    log.warn("[adminbot] ADMIN_BOT_TOKEN not set — admin bot disabled");
    return;
  }
  const bot = build();
  await bot.telegram.setMyCommands([
    { command: "start", description: "Open the template editor" },
    { command: "home", description: "Back to the menu" },
    { command: "cancel", description: "Cancel the current edit" },
  ]).catch(() => {});
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
  log.info("[adminbot] launching (long-polling)…");
  await bot.launch({ allowedUpdates: ["message", "callback_query"] });
}

module.exports = { startAdminBot, build };
