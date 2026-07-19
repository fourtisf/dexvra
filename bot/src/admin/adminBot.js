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
const BT_KINDS = { listing: "📄 Listing", trending: "🔥 Trending", banner: "📢 Banner Ads" };

function btHomeText() {
  const st = (k) => (bannerTpl.hasUploaded(k) ? "✅ custom" : bannerTpl.hasTemplate(k) ? "💎 bundled" : "— none");
  const on = bannerTpl.postingEnabled();
  return (
    `🎨 <b>Channel Banner Artwork</b>\n\n` +
    `Designed artwork per service; the bot composites each token's <b>logo</b> ` +
    `(or the advertiser's <b>creative</b> for Banner Ads) into the artwork's slot, ` +
    `plus an optional <b>$TICKER + name</b> overlay.\n\n` +
    `Banner posts: <b>${on ? "🟢 ON" : "🔴 OFF — channel posts fall back to the raw token logo!"}</b>\n\n` +
    `📄 Listing: ${st("listing")}\n🔥 Trending: ${st("trending")}\n📢 Banner Ads: ${st("banner")}\n\n` +
    `Pick a service to configure:`
  );
}
function btHomeKb() {
  const on = bannerTpl.postingEnabled();
  return Markup.inlineKeyboard([
    [Markup.button.callback(on ? "🟢 Banner posts: ON — tap to turn OFF" : "🔴 Banner posts: OFF — tap to turn ON", `bt_on:${on ? 0 : 1}`)],
    [Markup.button.callback(BT_KINDS.listing, "btk:listing"), Markup.button.callback(BT_KINDS.trending, "btk:trending")],
    [Markup.button.callback(BT_KINDS.banner, "btk:banner")],
    [Markup.button.callback("⬅ Back", "home")],
  ]);
}
function btKindText(kind) {
  const s = bannerTpl.getSettings(kind);
  const src = bannerTpl.hasUploaded(kind) ? "✅ custom uploaded" : bannerTpl.hasTemplate(kind) ? "💎 bundled default" : "— none (auto-banner used)";
  const slot =
    s.slotShape === "rect"
      ? `slot <b>${s.slotW}×${s.slotH}px</b> at (${s.logoX}, ${s.logoY})`
      : `logo <b>${s.logoSize}px</b> at (${s.logoX}, ${s.logoY})`;
  return (
    `🎨 <b>${BT_KINDS[kind]} artwork</b>\n\n` +
    `Artwork: ${src}\n` +
    `Media slot: ${slot}\n` +
    `Text overlay: <b>${s.showText ? "on" : "off"}</b> (${s.tickerFontSize}px at ${s.tickerX}, ${s.tickerY})\n\n` +
    `Settings are separate per service.`
  );
}
function btKindKb(kind) {
  const s = bannerTpl.getSettings(kind);
  const manualRow =
    s.slotShape === "rect"
      ? [Markup.button.callback("📐 Manual slot (W H X,Y)", `bt_slot:${kind}`), Markup.button.callback("🔤 Text overlay", `bt_text:${kind}`)]
      : [Markup.button.callback("📍 Manual (SIZE X,Y)", `bt_pos:${kind}`), Markup.button.callback("🔤 Text overlay", `bt_text:${kind}`)];
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬆ Upload artwork", `bt_up:${kind}`)],
    [Markup.button.callback("🖱 Logo editor — geser • ukuran • live preview", `bt_ed:${kind}`)],
    manualRow,
    [Markup.button.callback("👁 Preview", `bt_prev:${kind}`), Markup.button.callback("🗑 Remove custom", `bt_rm:${kind}`)],
    [Markup.button.callback("⬅ Artwork menu", "bt")],
  ]);
}

// ── Interactive slot editor — one PHOTO message that edits itself in place ───
// Every arrow/size tap: save the setting, re-compose the preview with a dashed
// guide over the slot, and editMessageMedia the same message. Feels like a
// mini design tool inside Telegram.
const BT_NUDGE = 40; // px per tap on the 2560×1280 artwork

function btGuideOverlay(buf, kind) {
  const cv = require("@napi-rs/canvas");
  return cv.loadImage(buf).then((img) => {
    const c = cv.createCanvas(img.width, img.height);
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const s = bannerTpl.getSettings(kind);
    const rect = s.slotShape === "rect";
    const sw = rect ? Number(s.slotW) : Number(s.logoSize);
    const sh = rect ? Number(s.slotH) : Number(s.logoSize);
    const lx = s.logoX === "center" ? (img.width - sw) / 2 : Number(s.logoX) || 0;
    const ly = s.logoY === "center" ? (img.height - sh) / 2 : Number(s.logoY) || 0;
    const stroke = (color, width) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.setLineDash([22, 16]);
      g.beginPath();
      if (rect) g.rect(lx, ly, sw, sh);
      else g.arc(lx + sw / 2, ly + sh / 2, sw / 2, 0, Math.PI * 2);
      g.stroke();
    };
    stroke("rgba(0,0,0,.65)", 12);
    stroke("#FFD84D", 5);
    // crosshair at slot center
    g.setLineDash([]);
    g.strokeStyle = "#FFD84D";
    g.lineWidth = 3;
    const cx = lx + sw / 2;
    const cy = ly + sh / 2;
    g.beginPath();
    g.moveTo(cx - 26, cy);
    g.lineTo(cx + 26, cy);
    g.moveTo(cx, cy - 26);
    g.lineTo(cx, cy + 26);
    g.stroke();
    return c.toBuffer("image/png");
  });
}

function btEditorCaption(kind) {
  const s = bannerTpl.getSettings(kind);
  const rect = s.slotShape === "rect";
  const pos = `(${s.logoX}, ${s.logoY})`;
  return (
    `🖱 <b>${BT_KINDS[kind]} — logo editor</b>\n` +
    (rect ? `Slot <b>${s.slotW}×${s.slotH}px</b> di ${pos}` : `Logo <b>${s.logoSize}px</b> di ${pos}`) +
    `\nGaris kuning putus-putus = posisi slot. Panah menggeser ${BT_NUDGE}px per tap; hasil langsung terlihat.`
  );
}

function btEditorKb(kind) {
  const s = bannerTpl.getSettings(kind);
  const rect = s.slotShape === "rect";
  const cb = Markup.button.callback;
  const rows = [
    [
      cb("◀", `bt_emv:${kind}:${-BT_NUDGE}:0`),
      cb("🔼", `bt_emv:${kind}:0:${-BT_NUDGE}`),
      cb("🔽", `bt_emv:${kind}:0:${BT_NUDGE}`),
      cb("▶", `bt_emv:${kind}:${BT_NUDGE}:0`),
    ],
  ];
  if (rect) {
    rows.push([
      cb("↔️ W−", `bt_ewh:${kind}:${-BT_NUDGE}:0`),
      cb(`${s.slotW}×${s.slotH}`, `bt_slot:${kind}`),
      cb("↔️ W+", `bt_ewh:${kind}:${BT_NUDGE}:0`),
    ]);
    rows.push([cb("↕️ H−", `bt_ewh:${kind}:0:${-BT_NUDGE}`), cb("↕️ H+", `bt_ewh:${kind}:0:${BT_NUDGE}`)]);
  } else {
    rows.push([
      cb("➖ Kecil", `bt_esz:${kind}:${-BT_NUDGE}`),
      cb(`${s.logoSize}px`, `bt_pos:${kind}`),
      cb("➕ Besar", `bt_esz:${kind}:${BT_NUDGE}`),
    ]);
  }
  rows.push([cb("✅ Selesai", `bt_done:${kind}`)]);
  return Markup.inlineKeyboard(rows);
}

async function btEditorImage(kind) {
  const buf = await bannerTpl.compose(kind, sampleMedia(kind), {
    symbol: "SAMPLE", name: "Sample Token", chain: "SOLANA", price: "$0.0042", mcap: "$1.2M", badge: "Diamond Tier",
  });
  if (!buf) return null;
  return btGuideOverlay(buf, kind).catch(() => buf);
}

async function btEditorOpen(ctx, kind) {
  if (!bannerTpl.hasTemplate(kind)) {
    return ctx.reply(`❌ No ${kind} artwork available yet. Tap ⬆ Upload first.`).catch(() => {});
  }
  const img = await btEditorImage(kind);
  if (!img) return ctx.reply("⚠️ Editor render failed — check pm2 logs.").catch(() => {});
  await ctx
    .replyWithPhoto({ source: img }, { caption: btEditorCaption(kind), parse_mode: "HTML", ...btEditorKb(kind) })
    .catch(() => {});
}

async function btEditorRefresh(ctx, kind) {
  const img = await btEditorImage(kind);
  if (!img) return;
  await ctx
    .editMessageMedia(
      { type: "photo", media: { source: img }, caption: btEditorCaption(kind), parse_mode: "HTML" },
      { reply_markup: btEditorKb(kind).reply_markup },
    )
    .catch(() => btEditorOpen(ctx, kind)); // message too old / edit failed → fresh editor
}

function sampleMedia(kind) {
  try {
    const cv = require("@napi-rs/canvas");
    const rect = bannerTpl.getSettings(kind).slotShape === "rect";
    const w = rect ? 800 : 300;
    const h = rect ? 320 : 300;
    const c = cv.createCanvas(w, h);
    const g = c.getContext("2d");
    const lg = g.createLinearGradient(0, 0, w, h);
    lg.addColorStop(0, "#7C3AED");
    lg.addColorStop(1, "#22D3EE");
    g.fillStyle = lg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(255,255,255,.95)";
    g.font = `800 ${rect ? 90 : 170}px sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(rect ? "SAMPLE AD" : "J", w / 2, h / 2 + (rect ? 4 : 8));
    return c.toBuffer("image/png");
  } catch {
    return null;
  }
}

async function btPreview(ctx, kind) {
  if (!bannerTpl.hasTemplate(kind)) {
    return ctx.reply(`❌ No ${kind} artwork available yet. Tap ⬆ Upload first.`).catch(() => {});
  }
  const buf = await bannerTpl.compose(kind, sampleMedia(kind), { symbol: "SAMPLE", name: "Sample Token", chain: "SOLANA", price: "$0.0042", mcap: "$1.2M", badge: "Diamond Tier" });
  if (!buf) return ctx.reply("⚠️ Preview failed — check pm2 logs.").catch(() => {});
  await ctx
    .replyWithPhoto({ source: buf }, { caption: `👁 ${BT_KINDS[kind]} preview — tune the slot/text until it sits perfectly.` })
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
  let premiumNote = "";
  if (val && typeof val === "object" && val.entities && val.entities.length) {
    const nPrem = val.entities.filter((e) => e.type === "custom_emoji").length;
    premiumNote = nPrem
      ? `\n💎 Saved with ${nPrem} premium emoji (entities preserved).\n`
      : `\nℹ️ Saved with ${val.entities.length} formatting entities.\n`;
  }
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

  // ── Channel banner artwork (template compositor, per service) ──
  const K = "(listing|trending|banner)";
  bot.action("bt", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, btHomeText(), btHomeKb());
  });
  bot.action(new RegExp(`^btk:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, btKindText(ctx.match[1]), btKindKb(ctx.match[1]));
  });
  bot.action(new RegExp(`^bt_up:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBt = { mode: "upload", kind: ctx.match[1] };
    await ctx.reply(
      `⬆ Send the <b>${BT_KINDS[ctx.match[1]]} artwork</b> as a photo or file (PNG/JPG, ~1280×640 or 2560×1280). Send /cancel to abort.`,
      HTML,
    );
  });
  // Banner posts master switch — persisted config, beats POST_BANNERS env.
  bot.action(/^bt_on:(0|1)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const on = ctx.match[1] === "1";
    await bannerTpl.setPostingEnabled(on);
    log.info(`[adminbot] banner posts turned ${on ? "ON" : "OFF"} by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery(on ? "🟢 Banner posts ON" : "🔴 Banner posts OFF").catch(() => {});
    await edit(ctx, btHomeText(), btHomeKb());
  });

  // Interactive editor: open + nudge + resize, all editing one photo in place.
  bot.action(new RegExp(`^bt_ed:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await btEditorOpen(ctx, ctx.match[1]);
  });
  bot.action(new RegExp(`^bt_emv:${K}:(-?\\d+):(-?\\d+)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    const s = bannerTpl.getSettings(kind);
    const num = (v, d) => (v === "center" ? d : Number(v) || 0);
    const lx = Math.max(-800, Math.min(3200, num(s.logoX, 1070) + Number(ctx.match[2])));
    const ly = Math.max(-800, Math.min(3200, num(s.logoY, 430) + Number(ctx.match[3])));
    await bannerTpl.updateSettings(kind, { logoX: lx, logoY: ly });
    ctx.answerCbQuery(`📍 ${lx}, ${ly}`).catch(() => {});
    await btEditorRefresh(ctx, kind);
  });
  bot.action(new RegExp(`^bt_esz:${K}:(-?\\d+)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    const s = bannerTpl.getSettings(kind);
    const size = Math.max(60, Math.min(1600, Number(s.logoSize) + Number(ctx.match[2])));
    // grow/shrink around the slot CENTER so the ring stays put while resizing
    const num = (v, d) => (v === "center" ? d : Number(v) || 0);
    const dx = (Number(s.logoSize) - size) / 2;
    await bannerTpl.updateSettings(kind, {
      logoSize: size,
      logoX: Math.round(num(s.logoX, 1070) + dx),
      logoY: Math.round(num(s.logoY, 430) + dx),
    });
    ctx.answerCbQuery(`Logo ${size}px`).catch(() => {});
    await btEditorRefresh(ctx, kind);
  });
  bot.action(new RegExp(`^bt_ewh:${K}:(-?\\d+):(-?\\d+)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    const s = bannerTpl.getSettings(kind);
    const w = Math.max(200, Math.min(2560, Number(s.slotW) + Number(ctx.match[2])));
    const h = Math.max(120, Math.min(1280, Number(s.slotH) + Number(ctx.match[3])));
    await bannerTpl.updateSettings(kind, { slotW: w, slotH: h });
    ctx.answerCbQuery(`📐 ${w}×${h}`).catch(() => {});
    await btEditorRefresh(ctx, kind);
  });
  bot.action(new RegExp(`^bt_done:${K}$`), async (ctx) => {
    ctx.answerCbQuery("✅ Tersimpan").catch(() => {});
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    await ctx.reply(btKindText(kind), { ...HTML, ...btKindKb(kind) }).catch(() => {});
  });

  bot.action(new RegExp(`^bt_sz:${K}:(-?\\d+)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    const s = bannerTpl.getSettings(kind);
    const size = Math.max(60, Math.min(1600, Number(s.logoSize) + Number(ctx.match[2])));
    await bannerTpl.updateSettings(kind, { logoSize: size });
    ctx.answerCbQuery(`Logo ${size}px`).catch(() => {});
    await edit(ctx, btKindText(kind), btKindKb(kind));
    if (bannerTpl.hasTemplate(kind)) await btPreview(ctx, kind);
  });
  bot.action(new RegExp(`^bt_pos:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    ctx.session.awaitingBt = { mode: "pos", kind };
    const s = bannerTpl.getSettings(kind);
    await ctx.reply(
      `📍 <b>Logo spot — ${BT_KINDS[kind]}</b>\n` +
        `Current: <b>${s.logoSize}px</b> at (${s.logoX}, ${s.logoY})\n\n` +
        `Send: <code>SIZE X,Y</code> — e.g. <code>420 1890,410</code>\n` +
        `(<code>center</code> works for X or Y). /cancel to abort.`,
      HTML,
    );
  });
  bot.action(new RegExp(`^bt_slot:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    ctx.session.awaitingBt = { mode: "slot", kind };
    const s = bannerTpl.getSettings(kind);
    await ctx.reply(
      `📐 <b>Creative slot — ${BT_KINDS[kind]}</b>\n` +
        `Current: <b>${s.slotW}×${s.slotH}px</b> at (${s.logoX}, ${s.logoY})\n\n` +
        `Send: <code>WIDTH HEIGHT X,Y</code> — e.g. <code>1680 800 690,310</code>\n` +
        `(<code>center</code> works for X or Y). /cancel to abort.`,
      HTML,
    );
  });
  bot.action(new RegExp(`^bt_text:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    ctx.session.awaitingBt = { mode: "text", kind };
    const s = bannerTpl.getSettings(kind);
    await ctx.reply(
      `🔤 <b>Text overlay — ${BT_KINDS[kind]}</b> ($TICKER + name on the artwork).\n` +
        `Current: <b>${s.showText ? "on" : "off"}</b>, ${s.tickerFontSize}px at (${s.tickerX}, ${s.tickerY})\n\n` +
        `Send: <code>SIZE X,Y</code> — e.g. <code>96 430,660</code>\n` +
        `Or <code>off</code> / <code>on</code> to toggle it.\n\n/cancel to abort.`,
      HTML,
    );
  });
  bot.action(new RegExp(`^bt_prev:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await btPreview(ctx, ctx.match[1]);
  });
  bot.action(new RegExp(`^bt_rm:${K}$`), async (ctx) => {
    ctx.answerCbQuery("Custom artwork removed").catch(() => {});
    if (!guard(ctx)) return;
    await bannerTpl.removeTemplate(ctx.match[1]);
    await edit(ctx, btKindText(ctx.match[1]), btKindKb(ctx.match[1]));
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
    // Banner-artwork settings input (per service: logo spot / creative slot /
    // text overlay)
    if (ctx.session.awaitingBt && ctx.session.awaitingBt.mode !== "upload") {
      const { mode, kind } = ctx.session.awaitingBt;
      ctx.session.awaitingBt = null;
      const low = text.trim().toLowerCase();
      const cv = (v) => (v === "center" ? "center" : Number(v));
      try {
        if (mode === "text" && (low === "off" || low === "on")) {
          await bannerTpl.updateSettings(kind, { showText: low === "on" });
          await ctx.reply(`✅ ${BT_KINDS[kind]}: text overlay <b>${low}</b>.`, HTML);
        } else if (mode === "slot") {
          const m = low.match(/^(\d+)\s+(\d+)\s+(center|-?\d+)\s*,\s*(center|-?\d+)$/);
          if (!m) return ctx.reply("❌ Format: <code>WIDTH HEIGHT X,Y</code> — e.g. <code>1680 800 690,310</code>", HTML).catch(() => {});
          await bannerTpl.updateSettings(kind, { slotW: Number(m[1]), slotH: Number(m[2]), logoX: cv(m[3]), logoY: cv(m[4]) });
          await ctx.reply(`✅ ${BT_KINDS[kind]}: slot saved. Previewing…`, HTML);
        } else {
          const m = low.match(/^(\d+)\s+(center|-?\d+)\s*,\s*(center|-?\d+)$/);
          if (!m) return ctx.reply("❌ Format: <code>SIZE X,Y</code> — e.g. <code>420 1890,410</code>", HTML).catch(() => {});
          const patch =
            mode === "pos"
              ? { logoSize: Number(m[1]), logoX: cv(m[2]), logoY: cv(m[3]) }
              : { tickerFontSize: Number(m[1]), tickerX: cv(m[2]), tickerY: cv(m[3]), showText: true };
          await bannerTpl.updateSettings(kind, patch);
          await ctx.reply(`✅ ${BT_KINDS[kind]}: saved. Previewing…`, HTML);
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
    // A message pasted with AUTHORED formatting (premium emoji, bold, links…)
    // is stored verbatim as {text, entities} so custom emoji survive. Telegram
    // auto-detects url/command/mention entities on ANY plain message — those
    // alone must NOT freeze a typed markup template into verbatim storage.
    const premiumLib = require("../premium");
    const value = premiumLib.hasAuthoredFormatting(entities) ? { text, entities } : text;
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
          `✅ <b>${BT_KINDS[kind]} artwork saved.</b> Now set the media slot so the logo/creative lands right, then 👁 Preview.`,
          { ...HTML, ...btKindKb(kind) },
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
