// @dexvraadminbot → "📊 Banner Top Gainers": generate a premium Top-Gainers
// banner from LIVE data, preview it in the chat, swap any slot by link, and
// publish it to a channel. Plus the settings for the daily auto-post.
//
// Split out of adminBot.js (which is already ~3k lines) and registered by it, so
// this feature owns its own keyboards, session keys and input handlers. It shares
// adminBot's guard/edit/HTML helpers rather than re-implementing them — passed in
// as `deps` at registration.
//
// WHY THE ADMIN BOT DOESN'T POST DIRECTLY: it is a separate process from
// @dexvrabot, which is the account that is admin in the channels, and only that
// process has the GramJS premium session (see gainerspost/store.js). So this
// module RENDERS the banner and queues it; the main bot publishes it seconds
// later and writes the result back, which is what the ack below reports.
const { Markup } = require("telegraf");
const { promises: fs } = require("node:fs");
const gainers = require("../gainers");
const gb = require("../gainersBanner");
const cfgStore = require("../services/gainersConfig");
const store = require("../gainerspost/store");
const mediaMirror = require("../db/mediaMirror");
const { DATA_DIR } = require("../helpers/persist");
const { escapeHtml, fmtCap } = require("../helpers/format");
const log = require("../helpers/logger");

// The background artwork's name and location belong to gainersConfig — the main
// bot's poster reads the same file, and two modules spelling out one filename is
// how they end up disagreeing.
const { BG_FILE: BG_NAME, bgPath, hasBg, bgForRender } = cfgStore;

const ON = "✅";
const OFF = "▫️";
const mark = (b) => (b ? ON : OFF);

// ── panels ──────────────────────────────────────────────────────────────────
function homeText() {
  const c = cfgStore.get();
  const tplName = c.template === "random" ? `🎲 random${c.pool.length ? ` (${c.pool.length} in rotation)` : " (all)"}` : gb.labelOf(c.template);
  const filters = [`≥ +${c.minGainPct}%`, c.minLiqUsd ? `liq ≥ ${fmtCap(c.minLiqUsd)}` : null].filter(Boolean).join(" · ");
  const lines = [
    "📊 <b>Banner Top Gainers</b>",
    "",
    "Live 24h movers across every Dexvra listing, drawn onto a premium banner and posted to a channel. Every figure comes from live market data — a token with no live 24h change is left off, never filled in.",
    "",
    `📢 <b>Channel:</b> <code>${escapeHtml(cfgStore.targetChannel(c))}</code>`,
    `🖼 <b>Layout:</b> ${escapeHtml(tplName)}`,
    `🎯 <b>Filters:</b> ${escapeHtml(filters)}`,
    `⏰ <b>Daily post:</b> ${c.daily ? `ON at <b>${c.dailyTime}</b> ${escapeHtml(c.tz)}` : "OFF"}`,
  ];
  if (hasBg()) lines.push("🎨 <b>Background:</b> custom artwork set");
  if (!gb.available()) lines.push("\n⚠️ <b>canvas is unavailable on this host</b> — banners cannot be rendered here.");
  lines.push("", "Pick a layout to preview it with live data:");
  return lines.join("\n");
}

function homeKb() {
  const rows = [];
  const ids = gb.TEMPLATE_IDS;
  for (let i = 0; i < ids.length; i += 2) {
    rows.push(
      ids.slice(i, i + 2).map((id) => Markup.button.callback(`${gb.labelOf(id)} · ${gb.countOf(id)}`, `gn_t:${id}`)),
    );
  }
  rows.push([Markup.button.callback("🎲 Random layout", "gn_t:random")]);
  rows.push([Markup.button.callback("📡 Check live data", "gn_data"), Markup.button.callback("⚙️ Settings", "gn_set")]);
  rows.push([Markup.button.callback("⬅ Back to menu", "home")]);
  return Markup.inlineKeyboard(rows);
}

function setText() {
  const c = cfgStore.get();
  return [
    "⚙️ <b>Top Gainers — settings</b>",
    "",
    `📢 <b>Channel:</b> <code>${escapeHtml(cfgStore.targetChannel(c))}</code>${c.channel ? "" : " <i>(default: trending)</i>"}`,
    `🖼 <b>Default layout:</b> ${escapeHtml(c.template === "random" ? "random" : gb.labelOf(c.template))}`,
    `🎲 <b>Random rotation:</b> ${c.pool.length ? escapeHtml(c.pool.map((t) => gb.labelOf(t)).join(", ")) : "every layout"}`,
    "",
    `⏰ <b>Daily auto-post:</b> ${c.daily ? "ON" : "OFF"} — <b>${c.dailyTime}</b> (${escapeHtml(c.tz)})`,
    `📌 <b>Pin the post:</b> ${c.pin ? "yes" : "no"}`,
    "",
    `🎯 <b>Minimum gain:</b> +${c.minGainPct}%`,
    `💧 <b>Minimum liquidity:</b> ${c.minLiqUsd ? fmtCap(c.minLiqUsd) : "off"}`,
    `🗓 <b>Date line on the banner:</b> ${c.showDate ? "yes" : "no"}`,
    `🏦 <b>Market cap in the caption:</b> ${c.showMcap ? "yes" : "no"}`,
    `🎨 <b>Background artwork:</b> ${hasBg() ? "custom" : "built-in gradient"}`,
    "",
    "<i>The caption itself is a template — edit it under 📢 Channel Posts → “Post: Top Gainers banner”.</i>",
  ].join("\n");
}

function setKb() {
  const c = cfgStore.get();
  return Markup.inlineKeyboard([
    [Markup.button.callback("📢 Channel", "gn_ch"), Markup.button.callback("🖼 Default layout", "gn_tpl")],
    [Markup.button.callback(`⏰ Daily ${c.daily ? "ON → turn OFF" : "OFF → turn ON"}`, "gn_daily")],
    [Markup.button.callback("🕘 Post time", "gn_time"), Markup.button.callback("🌍 Timezone", "gn_tz")],
    [Markup.button.callback("🎯 Min gain %", "gn_min"), Markup.button.callback("💧 Min liquidity", "gn_liq")],
    [
      Markup.button.callback(`${mark(c.showDate)} Date line`, "gn_date"),
      Markup.button.callback(`${mark(c.showMcap)} MC in caption`, "gn_mcap"),
    ],
    [Markup.button.callback(`${mark(c.pin)} Pin the post`, "gn_pin"), Markup.button.callback("🎨 Background", "gn_bg")],
    [Markup.button.callback("♻️ Reset settings", "gn_reset")],
    [Markup.button.callback("⬅ Back", "gn")],
  ]);
}

function tplPickKb() {
  const c = cfgStore.get();
  const rows = gb.TEMPLATE_IDS.map((id) => [
    Markup.button.callback(`${c.template === id ? "✅ " : ""}${gb.labelOf(id)}`, `gn_dt:${id}`),
    Markup.button.callback(`${c.pool.includes(id) ? "🎲 in" : "· out"}`, `gn_pool:${id}`),
  ]);
  rows.unshift([Markup.button.callback(`${c.template === "random" ? "✅ " : ""}🎲 Random each time`, "gn_dt:random")]);
  rows.push([Markup.button.callback("⬅ Back", "gn_set")]);
  return Markup.inlineKeyboard(rows);
}

function bgText() {
  return [
    "🎨 <b>Background artwork</b>",
    "",
    hasBg()
      ? "A custom background is set — every layout draws its cards and text over it (with a scrim so the text stays readable)."
      : "No custom background: the layouts use the built-in Dexvra gradient, aurora and dot grid.",
    "",
    `Send an image (<b>${gb.REF_W}×${gb.REF_H}</b> or any 16:9) to use it as the background. Send it as a <b>File/document</b> to avoid Telegram's photo compression.`,
  ].join("\n");
}

const bgKb = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("⬆️ Upload background", "gn_bg_up")],
    ...(hasBg() ? [[Markup.button.callback("🗑 Remove background", "gn_bg_rm")]] : []),
    [Markup.button.callback("⬅ Back", "gn_set")],
  ]);

// ── preview ─────────────────────────────────────────────────────────────────
function previewKb(template) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📤 Post to channel", "gn_post")],
    [Markup.button.callback("✏️ Swap a token", "gn_swap"), Markup.button.callback("🔄 Refresh data", `gn_t:${template}`)],
    [Markup.button.callback("🖼 Another layout", "gn"), Markup.button.callback("❌ Cancel", "gn_cancel")],
  ]);
}

function posKb(n) {
  const rows = [];
  for (let i = 1; i <= n; i += 5) {
    rows.push(
      Array.from({ length: Math.min(5, n - i + 1) }, (_, k) => Markup.button.callback(String(i + k), `gn_pos:${i + k}`)),
    );
  }
  rows.push([Markup.button.callback("⬅ Back", "gn_back")]);
  return Markup.inlineKeyboard(rows);
}

/** Session coins are stored WITHOUT their logo bytes (the buffers would sit in
 *  memory for the life of the session); gainers caches downloads per URL, so
 *  re-attaching them before a render is effectively free. */
const stripLogos = (coins) => coins.map(({ logo, img, ...rest }) => rest);

/**
 * Render a preview and send it with the edit keyboard.
 * `fresh` fetches live gainers; otherwise the session's (possibly edited) list is
 * re-rendered, which is what makes a slot swap visible without losing the others.
 */
async function sendPreview(ctx, template, { fresh = true, note = "" } = {}) {
  const cfg = cfgStore.get();
  const id = gb.pickTemplate(template, { pool: cfg.pool });
  let coins;
  let source = "session";
  let notes = [];
  if (fresh) {
    const res = await gainers.topGainers({ limit: gb.countOf(id), minGainPct: cfg.minGainPct, minLiqUsd: cfg.minLiqUsd });
    coins = res.coins;
    source = res.source;
    notes = res.notes;
  } else {
    coins = (ctx.session.gn && ctx.session.gn.coins ? ctx.session.gn.coins : []).slice(0, gb.countOf(id));
    await gainers.loadLogos(coins);
  }
  if (!coins.length) {
    await ctx.reply(
      `📉 <b>Nothing to post.</b>\n\n${escapeHtml(notes.join(" ") || "No live gainers right now.")}\n\n<i>Nothing was posted — a gainers banner is only worth publishing when the numbers are real.</i>`,
      { parse_mode: "HTML", ...homeKb() },
    );
    return null;
  }

  const image = await gb.render({
    template: id,
    coins,
    dateText: cfg.showDate ? gainers.dateText(cfg.tz) : "",
    bgPath: bgForRender(),
  });
  if (!image) {
    await ctx.reply("⚠️ The banner didn't render (see the bot logs). Nothing was posted.", { parse_mode: "HTML", ...homeKb() });
    return null;
  }

  const caption = gainers.captionPayload(coins, { tz: cfg.tz, showMcap: cfg.showMcap });
  // Trimmed by channels/post's own fitter, so the preview is capped exactly the
  // way the real post will be (word boundary, no split surrogate, entities past
  // the cut dropped) instead of by a naive slice that could leave a dangling
  // entity and make Telegram refuse the message.
  const shown = require("../channels/post")._fitCaption(caption);
  // Two messages on purpose: the CAPTION is what the channel will show (premium
  // emoji ride as entities), and the controls card below it is admin-only chrome.
  // Merging them would make the admin approve a caption they never saw clean.
  await ctx.replyWithPhoto(
    { source: image },
    { caption: shown.text, ...(shown.entities && shown.entities.length ? { caption_entities: shown.entities } : {}) },
  );
  const short = coins.length < gb.countOf(id) ? `\n⚠️ Only <b>${coins.length}</b> live gainer(s) passed the filters — the layout adapted to fit.` : "";
  await ctx.reply(
    `👀 <b>Preview — ${escapeHtml(gb.labelOf(id))}</b>\n` +
      `📡 Data: <b>${escapeHtml(source)}</b> · ${escapeHtml(coins.map((c) => `$${c.symbol}`).join(", "))}` +
      short +
      (notes.length ? `\n<i>${escapeHtml(notes.join(" "))}</i>` : "") +
      (note ? `\n${note}` : "") +
      `\n\nPosting sends it to <code>${escapeHtml(cfgStore.targetChannel(cfg))}</code>.`,
    { parse_mode: "HTML", disable_web_page_preview: true, ...previewKb(id) },
  );
  ctx.session.gn = { template: id, coins: stripLogos(coins) };
  return id;
}

/** Wait for the main bot to publish a queued job (it polls every ~3s). */
async function waitForJob(id, { tries = 14, gapMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const j = store.get(id);
    if (j && ["done", "failed", "expired"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return store.get(id);
}

// ── registration ────────────────────────────────────────────────────────────
/**
 * @param {import("telegraf").Telegraf} bot
 * @param {{guard:Function, edit:Function, HTML:object, fetchTelegramFileBuffer:Function}} deps
 *   adminBot's own helpers — reused rather than duplicated. MUST be registered
 *   BEFORE adminBot's generic text/photo handlers, which do not call next().
 */
function register(bot, deps) {
  const { guard, edit, HTML, fetchTelegramFileBuffer } = deps;
  const cb = (fn) => async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    try {
      await fn(ctx);
    } catch (e) {
      log.warn(`[adminbot] gainers ${ctx.callbackQuery && ctx.callbackQuery.data}: ${e.message}`);
      await ctx.reply(`⚠️ ${escapeHtml(e.message)}`, HTML).catch(() => {});
    }
  };
  const await_ = (ctx, mode, extra = {}) => {
    ctx.session.awaitingGn = { mode, ...extra };
  };

  bot.command("gainers", async (ctx) => {
    if (!guard(ctx)) return;
    await ctx.reply(homeText(), { ...HTML, ...homeKb() });
  });

  bot.action("gn", cb((ctx) => edit(ctx, homeText(), homeKb())));
  bot.action("gn_set", cb((ctx) => edit(ctx, setText(), setKb())));
  bot.action("gn_tpl", cb((ctx) => edit(ctx, "🖼 <b>Default layout</b>\n\nThe left button picks the layout used by the daily post; the right one adds/removes it from the 🎲 random rotation.", tplPickKb())));
  bot.action("gn_bg", cb((ctx) => edit(ctx, bgText(), bgKb())));

  // ── preview / publish ──
  bot.action(/^gn_t:(.+)$/, cb(async (ctx) => {
    const arg = ctx.match[1];
    await ctx.reply(`⏳ Fetching live gainers…`, HTML).catch(() => {});
    await sendPreview(ctx, arg === "random" ? "random" : arg, { fresh: true });
  }));

  bot.action("gn_cancel", cb(async (ctx) => {
    ctx.session.gn = null;
    ctx.session.awaitingGn = null;
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply("Cancelled — nothing was posted.", { ...HTML, ...homeKb() });
  }));

  bot.action("gn_post", cb(async (ctx) => {
    const sess = ctx.session.gn;
    if (!sess || !sess.coins || !sess.coins.length) {
      return ctx.reply("That preview has expired — open 📊 Banner Top Gainers again.", { ...HTML, ...homeKb() });
    }
    const cfg = cfgStore.get();
    const coins = sess.coins;
    await gainers.loadLogos(coins);
    const image = await gb.render({
      template: sess.template,
      coins,
      dateText: cfg.showDate ? gainers.dateText(cfg.tz) : "",
      bgPath: bgForRender(),
    });
    if (!image) return ctx.reply("⚠️ The banner didn't render — nothing was posted.", HTML);
    const channel = cfgStore.targetChannel(cfg);
    const caption = gainers.captionPayload(coins, { tz: cfg.tz, showMcap: cfg.showMcap });
    const job = await store.request({
      image,
      caption,
      channel,
      template: sess.template,
      symbols: coins.map((c) => c.symbol),
      // The same board as plain text so the main bot can tweet it — an
      // admin-posted banner reached the channel and nothing else, while the
      // identical DAILY banner was tweeted. Built here because this is where the
      // coin objects are; the X client only exists in the main process.
      xList: gainers.listText(coins, { showMcap: cfg.showMcap }),
      xDate: cfg.showDate ? gainers.dateText(cfg.tz) : "",
      by: `@${ctx.from.username || ctx.from.id}`,
      pin: cfg.pin,
    });
    log.info(`[adminbot] gainers ${sess.template} queued for ${channel} by @${ctx.from.username || ctx.from.id}`);
    const status = await ctx.reply(`📤 Queued for <code>${escapeHtml(channel)}</code> — the main bot publishes it within a few seconds…`, HTML);
    const done = await waitForJob(job.id);
    const text = !done
      ? "⚠️ Lost track of that job — check the channel and the bot logs."
      : done.status === "done" && done.result
        ? `✅ <b>Posted.</b>\n${escapeHtml(done.result.url)}`
        : done.status === "expired"
          ? "⚠️ The main bot never picked it up (is <code>dexvra-bot</code> running?). Nothing was posted."
          : `❌ Publishing failed: ${escapeHtml(done.error || "unknown error")}`;
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, text, { parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
    if (done && done.status === "done") ctx.session.gn = null;
  }));

  // ── slot swap ──
  bot.action("gn_swap", cb(async (ctx) => {
    const sess = ctx.session.gn;
    if (!sess || !sess.coins || !sess.coins.length) {
      return ctx.reply("That preview has expired — open 📊 Banner Top Gainers again.", { ...HTML, ...homeKb() });
    }
    await ctx.reply(
      `✏️ <b>Swap a token</b>\n\nWhich position should be replaced? (1–${sess.coins.length})\n\n` +
        sess.coins.map((c, i) => `${i + 1}. $${escapeHtml(c.symbol)} ${gainers.pctLabel(c.pct)}`).join("\n"),
      { ...HTML, ...posKb(sess.coins.length) },
    );
  }));

  bot.action("gn_back", cb((ctx) => ctx.editMessageText("Use the buttons on the preview above.", HTML).catch(() => {})));

  bot.action(/^gn_pos:(\d+)$/, cb(async (ctx) => {
    const sess = ctx.session.gn;
    if (!sess) return ctx.reply("That preview has expired — open 📊 Banner Top Gainers again.", { ...HTML, ...homeKb() });
    const pos = Number(ctx.match[1]);
    await_(ctx, "swap", { pos });
    await ctx.reply(
      `Send the replacement for <b>#${pos}</b> — a contract address, a dexvra.io token link, or a DexScreener link.\n\n` +
        `<i>Its live 24h change is required: a slot with no real number can't go on a gainers banner.</i>`,
      HTML,
    );
  }));

  // ── settings inputs ──
  bot.action("gn_ch", cb(async (ctx) => {
    await_(ctx, "channel");
    await ctx.reply(
      "Send the target channel — <code>@dexvratrending</code>, a numeric <code>-100…</code> id, or <code>default</code> to use the trending channel.\n\n<i>The main bot must be an admin there.</i>",
      HTML,
    );
  }));
  bot.action("gn_time", cb(async (ctx) => {
    await_(ctx, "time");
    await ctx.reply("Send the daily post time as <b>HH:MM</b> (24h), e.g. <code>09:00</code>.", HTML);
  }));
  bot.action("gn_tz", cb(async (ctx) => {
    await_(ctx, "tz");
    await ctx.reply("Send an IANA timezone, e.g. <code>Asia/Jakarta</code>, <code>UTC</code>, <code>America/New_York</code>.", HTML);
  }));
  bot.action("gn_min", cb(async (ctx) => {
    await_(ctx, "min");
    await ctx.reply("Send the minimum 24h gain in percent, e.g. <code>5</code>. Tokens below it are left off the banner.", HTML);
  }));
  bot.action("gn_liq", cb(async (ctx) => {
    await_(ctx, "liq");
    await ctx.reply("Send the minimum liquidity in USD, e.g. <code>25000</code> (or <code>0</code> to turn the filter off).", HTML);
  }));
  bot.action("gn_bg_up", cb(async (ctx) => {
    await_(ctx, "bg");
    await ctx.reply(`Send the background image now (${gb.REF_W}×${gb.REF_H} ideally; send as a File to keep it sharp).`, HTML);
  }));

  bot.action("gn_bg_rm", cb(async (ctx) => {
    await fs.unlink(bgPath()).catch(() => {});
    mediaMirror.deleteMirror(BG_NAME).catch(() => {});
    log.info(`[adminbot] gainers background removed by @${ctx.from.username || ctx.from.id}`);
    await edit(ctx, bgText(), bgKb());
  }));

  // ── toggles ──
  const toggle = (key) =>
    cb(async (ctx) => {
      const cur = cfgStore.get();
      await cfgStore.set({ [key]: !cur[key] });
      await edit(ctx, setText(), setKb());
    });
  bot.action("gn_daily", cb(async (ctx) => {
    const cur = cfgStore.get();
    const next = await cfgStore.set({ daily: !cur.daily });
    log.info(`[adminbot] gainers daily post ${next.daily ? "ENABLED" : "disabled"} by @${ctx.from.username || ctx.from.id}`);
    await edit(ctx, setText(), setKb());
    if (next.daily) {
      await ctx.reply(
        `⏰ Daily post <b>ON</b> — every day at <b>${next.dailyTime}</b> (${escapeHtml(next.tz)}) to <code>${escapeHtml(cfgStore.targetChannel(next))}</code>.\n\n<i>It posts nothing on a day with no live gainers.</i>`,
        HTML,
      );
    }
  }));
  bot.action("gn_date", toggle("showDate"));
  bot.action("gn_mcap", toggle("showMcap"));
  bot.action("gn_pin", toggle("pin"));

  bot.action(/^gn_dt:(.+)$/, cb(async (ctx) => {
    await cfgStore.set({ template: ctx.match[1] });
    await edit(ctx, "🖼 <b>Default layout</b>\n\nThe left button picks the layout used by the daily post; the right one adds/removes it from the 🎲 random rotation.", tplPickKb());
  }));
  bot.action(/^gn_pool:(.+)$/, cb(async (ctx) => {
    await cfgStore.togglePool(ctx.match[1]);
    await edit(ctx, "🖼 <b>Default layout</b>\n\nThe left button picks the layout used by the daily post; the right one adds/removes it from the 🎲 random rotation.", tplPickKb());
  }));

  bot.action("gn_reset", cb(async (ctx) => {
    await cfgStore.reset();
    log.info(`[adminbot] gainers settings reset by @${ctx.from.username || ctx.from.id}`);
    await edit(ctx, setText(), setKb());
  }));

  // ── data health ──
  bot.action("gn_data", cb(async (ctx) => {
    const status = await ctx.reply("📡 Checking the live sources…", HTML);
    const cfg = cfgStore.get();
    const res = await gainers.topGainers({ limit: gainers.MAX_SLOTS, minGainPct: cfg.minGainPct, minLiqUsd: cfg.minLiqUsd, logos: false });
    const body = res.coins.length
      ? res.coins
          .map((c, i) => `${i + 1}. <b>$${escapeHtml(c.symbol)}</b> ${gainers.pctLabel(c.pct)} · ${escapeHtml(gainers.chainLabel(c.chain))}${c.mcap ? ` · ${fmtCap(c.mcap)}` : ""}`)
          .join("\n")
      : "<i>none</i>";
    await ctx.telegram
      .editMessageText(
        ctx.chat.id,
        status.message_id,
        undefined,
        `📡 <b>Live data</b>\n\n` +
          `Source: <b>${escapeHtml(res.source)}</b> · live-priced candidates: <b>${res.pool}</b>\n` +
          `Passing the filters (≥ +${cfg.minGainPct}%${cfg.minLiqUsd ? `, liq ≥ ${fmtCap(cfg.minLiqUsd)}` : ""}): <b>${res.coins.length}</b>\n\n` +
          body +
          (res.notes.length ? `\n\n⚠️ ${escapeHtml(res.notes.join(" "))}` : ""),
        { parse_mode: "HTML", disable_web_page_preview: true, ...homeKb() },
      )
      .catch(() => {});
  }));

  // ── awaited TEXT input ──
  // Runs BEFORE adminBot's own text handler and passes everything it isn't
  // waiting for straight through — otherwise this would swallow template edits.
  bot.on("text", async (ctx, next) => {
    const a = ctx.session && ctx.session.awaitingGn;
    if (!a || !guard(ctx)) return next();
    const raw = String(ctx.message.text || "").trim();
    // A command is never an ANSWER — pass it to the command handlers and leave the
    // wait armed, so "/home to look something up, then send the value" works.
    // /cancel is what clears it (adminBot's handler resets awaitingGn too).
    if (raw.startsWith("/")) return next();
    ctx.session.awaitingGn = null;
    try {
      if (a.mode === "channel") {
        const v = /^default$/i.test(raw) ? "" : raw;
        if (v && !/^(@[A-Za-z0-9_]{4,}|-100\d{5,})$/.test(v)) {
          throw new Error(`"${escapeHtml(v)}" doesn't look like a channel — send @username, a -100… id, or "default".`);
        }
        const next2 = await cfgStore.set({ channel: v });
        log.info(`[adminbot] gainers channel → ${cfgStore.targetChannel(next2)} by @${ctx.from.username || ctx.from.id}`);
        await ctx.reply(`✅ Channel → <code>${escapeHtml(cfgStore.targetChannel(next2))}</code>`, { ...HTML, ...setKb() });
      } else if (a.mode === "time") {
        const c = await cfgStore.set({ dailyTime: raw });
        await ctx.reply(`✅ Daily post time → <b>${c.dailyTime}</b> (${escapeHtml(c.tz)})${c.daily ? "" : "\n<i>Daily posting is still OFF — turn it on in settings.</i>"}`, { ...HTML, ...setKb() });
      } else if (a.mode === "tz") {
        const c = await cfgStore.set({ tz: raw });
        await ctx.reply(`✅ Timezone → <b>${escapeHtml(c.tz)}</b> · it is <b>${cfgStore.nowHHMM(c)}</b> there now.`, { ...HTML, ...setKb() });
      } else if (a.mode === "min") {
        const c = await cfgStore.set({ minGainPct: Number(raw.replace(/[%+\s]/g, "")) });
        await ctx.reply(`✅ Minimum gain → <b>+${c.minGainPct}%</b>`, { ...HTML, ...setKb() });
      } else if (a.mode === "liq") {
        const c = await cfgStore.set({ minLiqUsd: Number(raw.replace(/[$,\s]/g, "")) });
        await ctx.reply(`✅ Minimum liquidity → <b>${c.minLiqUsd ? fmtCap(c.minLiqUsd) : "off"}</b>`, { ...HTML, ...setKb() });
      } else if (a.mode === "swap") {
        const sess = ctx.session.gn;
        if (!sess) throw new Error("that preview has expired — open 📊 Banner Top Gainers again");
        const status = await ctx.reply(`⏳ Resolving that token…`, HTML);
        let tok;
        try {
          tok = await gainers.resolveToken(raw);
        } catch (e) {
          // Keep waiting so they can just send another link.
          ctx.session.awaitingGn = a;
          await ctx.telegram
            .editMessageText(ctx.chat.id, status.message_id, undefined, `❌ ${escapeHtml(e.message)}\n\nSend another link, or /gainers to start over.`, { parse_mode: "HTML" })
            .catch(() => {});
          return;
        }
        const i = Math.max(1, Math.min(sess.coins.length, a.pos)) - 1;
        const was = sess.coins[i];
        sess.coins[i] = { ...tok };
        ctx.session.gn = { ...sess, coins: stripLogos(sess.coins) };
        await ctx.telegram
          .editMessageText(ctx.chat.id, status.message_id, undefined, `✅ #${a.pos}: $${escapeHtml(was.symbol)} → <b>$${escapeHtml(tok.symbol)}</b> ${gainers.pctLabel(tok.pct)} — re-rendering…`, { parse_mode: "HTML" })
          .catch(() => {});
        await sendPreview(ctx, sess.template, {
          fresh: false,
          note: `<i>Slot #${a.pos} was replaced by hand — the list is no longer purely the live ranking.</i>`,
        });
      } else {
        return next();
      }
    } catch (e) {
      await ctx.reply(`⚠️ ${e.message}`, { ...HTML, ...setKb() }).catch(() => {});
    }
  });

  // ── awaited PHOTO/document input (the background artwork) ──
  bot.on(["photo", "document"], async (ctx, next) => {
    const a = ctx.session && ctx.session.awaitingGn;
    if (!a || a.mode !== "bg" || !guard(ctx)) return next();
    ctx.session.awaitingGn = null;
    const { getMediaFileId } = require("../helpers/message");
    const fileId = getMediaFileId(ctx);
    if (!fileId) return ctx.reply("Couldn't read that image — send it as a photo or a file.", HTML).catch(() => {});
    try {
      const buf = await fetchTelegramFileBuffer(ctx.telegram, fileId, { timeoutMs: 30000 });
      // Re-encode through canvas so whatever arrives (webp/heic/mislabelled bytes)
      // is stored as a PNG the renderer is guaranteed to be able to decode.
      const cv = require("../helpers/canvasKit").canvasLib();
      let out = buf;
      let note = "";
      if (cv) {
        const img = await cv.loadImage(buf);
        const canvas = cv.createCanvas(gb.REF_W, gb.REF_H);
        const c2 = canvas.getContext("2d");
        const s = Math.max(gb.REF_W / img.width, gb.REF_H / img.height);
        c2.drawImage(img, (gb.REF_W - img.width * s) / 2, (gb.REF_H - img.height * s) / 2, img.width * s, img.height * s);
        out = canvas.toBuffer("image/png");
        if (img.width < gb.REF_W) note = `\n\n⚠️ Sent at ${img.width}×${img.height} — upscaled to ${gb.REF_W}×${gb.REF_H}. Send it as a <b>File</b> for a sharp result.`;
      }
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${bgPath()}.${process.pid}.tmp`;
      await fs.writeFile(tmp, out);
      await fs.rename(tmp, bgPath()); // atomic: the renderer may read this at any moment
      mediaMirror.mirrorFile(BG_NAME).catch(() => {});
      log.info(`[adminbot] gainers background saved (${out.length}B) by @${ctx.from.username || ctx.from.id}`);
      await ctx.reply(`✅ <b>Background saved.</b> Every layout now draws over it.${note}`, { ...HTML, ...bgKb() });
    } catch (e) {
      await ctx.reply(`⚠️ Couldn't save that background: ${escapeHtml(e.message)}`, HTML).catch(() => {});
    }
  });
}

module.exports = {
  register,
  // exposed for tests / the smoke check
  _panels: { homeText, homeKb, setText, setKb, tplPickKb, bgText, previewKb, posKb },
  BG_NAME,
  bgPath,
  hasBg,
};
