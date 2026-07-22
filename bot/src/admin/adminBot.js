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
const { toSendBuffer } = require("../helpers/encodeImage");
const tpl = require("../templates");
const log = require("../helpers/logger");

// Template groups are DYNAMIC — every group that appears in templates.js META
// gets its own menu button, so new families (Mass DM, Group Buy Bot, …) show up
// automatically without touching this file. A stable slug id keys the callback.
const GROUP_ICON = {
  "Bot Messages": "📝",
  "Channel Posts": "📢",
  "Mass DM": "📣",
  "Group Buy Bot": "🤖",
};
const slugOf = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "") || "grp";
const groupNames = () => Object.keys(tpl.groups());
const nameFromSlug = (slug) => groupNames().find((n) => slugOf(n) === slug) || null;
const groupIdOf = (key) => slugOf(tpl.meta(key).group);
const HTML = { parse_mode: "HTML", disable_web_page_preview: true };

// A group's template list is paginated. A large family (Bot Messages ships 37
// templates) as one flat keyboard is 38 single-button rows — Telegram rejects a
// keyboard that tall on editMessageText, so tapping the group silently did
// nothing (the edit AND its reply fallback both carried the same oversize
// keyboard). Pages of GROUP_PAGE keep every keyboard small and navigable.
const GROUP_PAGE = 10;
const pageCount = (n) => Math.max(1, Math.ceil(n / GROUP_PAGE));
const clampPage = (p, pages) => Math.max(0, Math.min(Number(p) || 0, pages - 1));

function guard(ctx) {
  if (ctx.chat && ctx.chat.type !== "private") return false;
  if (!isAdminUser(ctx)) return false;
  return true;
}

// ── Keyboards ────────────────────────────────────────────────────────────────
function mainKb() {
  const groupRows = groupNames().map((name) => [
    Markup.button.callback(`${GROUP_ICON[name] || "📄"} ${name}`, `grp:${slugOf(name)}`),
  ]);
  return Markup.inlineKeyboard([
    ...groupRows,
    [Markup.button.callback("🔍 Preview all templates", "audit")],
    [Markup.button.callback("♻️ Reset ALL templates to default", "resetall")],
    [Markup.button.callback("🖼 Banner Image", "banner")],
    [Markup.button.callback("🎨 Channel Banner Artwork", "bt")],
    [Markup.button.callback("📣 Broadcast", "bc")],
  ]);
}

// Audit EVERY template at once: clean rendered text, grouped, ✏️=custom / •
// =default. `arg` = a group slug for fuller previews of just that group, or ""
// for a short snippet of all. Messages chunked under Telegram's 4096 limit.
// Shared by the /preview command and the "🔍 Preview all templates" button.
// Realistic sample values so the audit renders every template the way a real
// user/channel sees it — not the {placeholder} skeleton.
const SAMPLE_VARS = {
  native: "SOL", chain: "Solana", symbol: "$BULLCAT", name: "The Bull Cat",
  address: "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump",
  price: "$0.001266", mcap: "$1.3M", liq: "$183.5K",
  siteUrl: "https://dexvra.io/token/solana/G9j8", coinUrl: "https://dexvra.io/token/solana/G9j8",
  logo: "✅ set", overview: "A community-driven memecoin on Solana.",
  website: "https://bullcat.io", twitter: "https://x.com/bullcat", telegram: "https://t.me/bullcat",
  label: "Diamond Listing — $BULLCAT on Solana", amount: "1", order: "k3n8_a1b2",
  hours: "48", size: "728×90", slot: "Wide Banner", duration: "3 Days", usd: "670",
  endsAt: "Jul 22, 14:00 UTC", discount: "20", field: "name",
  postLinks: "🚨 Listing post: https://t.me/dexvralisting/6\n📢 Announcement: https://t.me/dexvraio/9",
  sol: "1 SOL", bnb: "0.15 BNB", eth: "0.05 ETH", ref: "MDX-4821", reached: "8,214",
  emoji: "🟢🟢🟢", count: "3", buysWord: "buys", tokenAmt: "1.2M", bot: "@dexvrabot",
};

async function sendTemplateAudit(ctx, arg = "") {
  // Channel posts are built by format.js (not simple var-substitution), so
  // render them from a sample coin to show the true post.
  const fmt = require("../channels/format");
  const sampleCoin = {
    name: "The Bull Cat", symbol: "$BULLCAT", chain: "solana", tier: "DIAMOND",
    address: "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump",
    price: 0.001266, mcap: 1300000, liq: 183475,
    links: { website: "https://bullcat.io", twitter: "https://x.com/bullcat", telegram: "https://t.me/bullcat" },
    siteUrl: "https://dexvra.io/token/solana/G9j8", overview: "A community-driven memecoin on Solana.",
    xUrl: "https://x.com/i/status/1",
  };
  const CHANNEL = {
    post_listing_xpress: () => fmt.listingPost({ ...sampleCoin, tier: "XPRESS" }),
    post_listing_tiered: () => fmt.listingPost(sampleCoin),
    post_trending: () => fmt.trendingPost(sampleCoin),
    post_pump: () => fmt.pumpPost(sampleCoin, 137.6, 310000, 1300000),
    post_rankup: () => fmt.rankupPost(sampleCoin, 2, 82),
    post_banner: () => fmt.bannerPost({ title: "The Bull Cat", slot: "Wide Banner", linkUrl: "https://bullcat.io" }),
  };
  const cleanOf = (k) => {
    try {
      const r = CHANNEL[k] ? CHANNEL[k]() : tpl.render(k, SAMPLE_VARS);
      return String((r && r.text) || "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, " · ").trim();
    } catch {
      return "(render error)";
    }
  };
  const groups = tpl.groups();
  const names = arg ? groupNames().filter((n) => slugOf(n) === arg) : groupNames();
  if (!names.length) {
    return ctx
      .reply(`No group '${escapeHtml(arg)}'. Try: ${groupNames().map((n) => `<code>/preview ${slugOf(n)}</code>`).join(", ")}`, HTML)
      .catch(() => {});
  }
  const cap = arg ? 480 : 130;
  for (const name of names) {
    let msg = `📋 <b>${escapeHtml(name)}</b> — ${groups[name].length} templates\n\n`;
    for (const k of groups[name]) {
      const text = cleanOf(k);
      const snip = text.length > cap ? `${text.slice(0, cap)}…` : text;
      const row = `${tpl.isCustom(k) ? "✏️" : "•"} <b>${escapeHtml(tpl.meta(k).label)}</b>\n<i>${escapeHtml(snip)}</i>\n\n`;
      if (msg.length + row.length > 3900) {
        await ctx.reply(msg, HTML).catch(() => {});
        msg = "";
      }
      msg += row;
    }
    if (msg.trim()) await ctx.reply(msg, HTML).catch(() => {});
  }
  if (!arg) {
    await ctx
      .reply(
        `Tip: <code>/preview botmessages</code> (or any group) shows fuller text. ✏️ = edited · • = default. Tap a category on /start to edit any of them.`,
        HTML,
      )
      .catch(() => {});
  }
}
function groupKb(slug, page = 0) {
  const name = nameFromSlug(slug);
  const g = (name && tpl.groups()[name]) || [];
  const pages = pageCount(g.length);
  const p = clampPage(page, pages);
  const slice = g.slice(p * GROUP_PAGE, p * GROUP_PAGE + GROUP_PAGE);
  const rows = slice.map((k) => [
    Markup.button.callback(`${tpl.isCustom(k) ? "✏️ " : ""}${tpl.meta(k).label}`, `v:${k}`),
  ]);
  if (pages > 1) {
    rows.push([
      Markup.button.callback(p > 0 ? "◀ Prev" : "·", p > 0 ? `grp:${slug}:${p - 1}` : "noop"),
      Markup.button.callback(`Page ${p + 1}/${pages}`, "noop"),
      Markup.button.callback(p < pages - 1 ? "Next ▶" : "·", p < pages - 1 ? `grp:${slug}:${p + 1}` : "noop"),
    ]);
  }
  rows.push([Markup.button.callback("⬅ Back", "home")]);
  return Markup.inlineKeyboard(rows);
}
function groupText(name, p, pages) {
  const head = pages > 1 ? ` <i>(page ${p + 1}/${pages})</i>` : "";
  return `<b>${escapeHtml(name)}</b>${head}\n\nPick a template:`;
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
const BT_KINDS = { listing: "📄 Listing", trending: "🔥 Trending", banner: "📢 Banner Ads", pump: "📈 Pump alert" };
// Media (GIF/video) is allowed for every kind incl. pump; artwork compositing
// only for the three still-image kinds.
const BT_ARTWORK_KINDS = new Set(["listing", "trending", "banner"]);

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
    [Markup.button.callback(BT_KINDS.banner, "btk:banner"), Markup.button.callback(BT_KINDS.pump, "btk:pump")],
    [Markup.button.callback("⬅ Back", "home")],
  ]);
}
function btKindText(kind) {
  const clip = bannerTpl.mediaOverride(kind);
  const clipLine = clip ? `🎞 GIF/Video: <b>${clip.type} set — overrides the still</b>\n` : `🎞 GIF/Video: <b>— none</b>\n`;
  if (!BT_ARTWORK_KINDS.has(kind)) {
    // pump: media-only (the alert card is text; a clip plays above it)
    return (
      `🎨 <b>${BT_KINDS[kind]}</b>\n\n` +
      clipLine +
      `\nUpload a GIF or short MP4 to play above every ${BT_KINDS[kind].replace(/^\S+\s/, "")} post. Token details stay in the caption text.`
    );
  }
  const s = bannerTpl.getSettings(kind);
  const src = bannerTpl.hasUploaded(kind) ? "✅ custom uploaded" : bannerTpl.hasTemplate(kind) ? "💎 bundled default" : "— none (auto-banner used)";
  const slot =
    s.slotShape === "rect"
      ? `slot <b>${s.slotW}×${s.slotH}px</b> at (${s.logoX}, ${s.logoY})`
      : `logo <b>${s.logoSize}px</b> at (${s.logoX}, ${s.logoY})`;
  return (
    `🎨 <b>${BT_KINDS[kind]} artwork</b>\n\n` +
    `Artwork: ${src}\n` +
    clipLine +
    `Media slot: ${slot}\n` +
    `Text overlay: <b>${s.showText ? "on" : "off"}</b> (${s.tickerFontSize}px at ${s.tickerX}, ${s.tickerY})\n\n` +
    `Settings are separate per service. A GIF/video, when set, is used instead of the still artwork.`
  );
}
function btKindKb(kind) {
  const clipRow = [Markup.button.callback("🎞 Upload GIF/Video", `bt_med:${kind}`)];
  if (bannerTpl.mediaOverride(kind)) clipRow.push(Markup.button.callback("🗑 Remove clip", `bt_medrm:${kind}`));
  if (!BT_ARTWORK_KINDS.has(kind)) {
    return Markup.inlineKeyboard([clipRow, [Markup.button.callback("⬅ Artwork menu", "bt")]]);
  }
  const s = bannerTpl.getSettings(kind);
  const manualRow =
    s.slotShape === "rect"
      ? [Markup.button.callback("📐 Manual slot (W H X,Y)", `bt_slot:${kind}`), Markup.button.callback("🔤 Text overlay", `bt_text:${kind}`)]
      : [Markup.button.callback("📍 Manual (SIZE X,Y)", `bt_pos:${kind}`), Markup.button.callback("🔤 Text overlay", `bt_text:${kind}`)];
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬆ Upload artwork", `bt_up:${kind}`)],
    clipRow,
    [Markup.button.callback("🖱 Logo editor — move • size • live preview", `bt_ed:${kind}`)],
    manualRow,
    [Markup.button.callback("👁 Preview", `bt_prev:${kind}`), Markup.button.callback("🗑 Remove custom", `bt_rm:${kind}`)],
    [Markup.button.callback("⬅ Artwork menu", "bt")],
  ]);
}

// ── Interactive layout editor — one PHOTO message that edits itself in place ─
// A full listing-example preview (logo + $TICKER + name + chain·price·MC
// chips + tier badge) with an ELEMENT SELECTOR: pick logo/ticker/chips/badge,
// then the arrows move THAT element and ➕/➖ resize it. Every tap saves the
// setting, re-composes, draws a dashed guide on the selected element and
// editMessageMedia's the same message — a mini design tool inside Telegram.
const BT_NUDGE = 40; // px per arrow tap for the logo slot (2560×1280 artwork)
const BT_TEXT_NUDGE = 20; // finer step for text elements

// element → which settings keys it drives
const BT_ELEMS = {
  logo: { label: "🪙 Logo", xKey: "logoX", yKey: "logoY" },
  ticker: { label: "🔤 Ticker+Name", xKey: "tickerX", yKey: "tickerY", sizeKey: "tickerFontSize", step: 8 },
  meta: { label: "📊 Chips", xKey: "metaX", yKey: "metaY", sizeKey: "metaFontSize", step: 4 },
  badge: { label: "🏷 Badge", xKey: "badgeX", yKey: "badgeY", sizeKey: "badgeFontSize", step: 4 },
};
const BT_ELEM_KEYS = Object.keys(BT_ELEMS);

function btNum(v, d) {
  return v === "center" ? d : Number(v) || 0;
}

function btGuideOverlay(buf, kind, elem) {
  const cv = require("@napi-rs/canvas");
  return cv.loadImage(buf).then((img) => {
    const c = cv.createCanvas(img.width, img.height);
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const s = bannerTpl.getSettings(kind);
    const rect = s.slotShape === "rect";

    // guide box for the SELECTED element
    let gx, gy, gw, gh, circle = false;
    if (elem === "logo") {
      gw = rect ? Number(s.slotW) : Number(s.logoSize);
      gh = rect ? Number(s.slotH) : Number(s.logoSize);
      gx = s.logoX === "center" ? (img.width - gw) / 2 : btNum(s.logoX);
      gy = s.logoY === "center" ? (img.height - gh) / 2 : btNum(s.logoY);
      circle = !rect;
    } else if (elem === "ticker") {
      const fs = Number(s.tickerFontSize) || 96;
      gw = fs * 5.2;
      gh = fs + (Number(s.nameFontSize) || 48) + (Number(s.nameOffsetY) || 96) - fs * 0.4;
      gx = s.tickerX === "center" ? (img.width - gw) / 2 : btNum(s.tickerX);
      gy = btNum(s.tickerY) - fs * 0.85;
    } else if (elem === "meta") {
      const fs = Number(s.metaFontSize) || 34;
      gw = fs * 20;
      gh = fs * 2;
      gx = s.metaX === "center" ? (img.width - gw) / 2 : btNum(s.metaX);
      gy = btNum(s.metaY) - fs * 1.3;
    } else {
      const fs = Number(s.badgeFontSize) || 30;
      gw = fs * 12;
      gh = fs * 2.2;
      gx = btNum(s.badgeX) - gw / 2; // badgeX is CENTER x
      gy = btNum(s.badgeY) - gh / 2;
    }

    const stroke = (color, width) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.setLineDash([22, 16]);
      g.beginPath();
      if (circle) g.arc(gx + gw / 2, gy + gh / 2, gw / 2, 0, Math.PI * 2);
      else g.rect(gx, gy, gw, gh);
      g.stroke();
    };
    stroke("rgba(0,0,0,.65)", 12);
    stroke("#FFD84D", 5);
    // crosshair at guide center
    g.setLineDash([]);
    g.strokeStyle = "#FFD84D";
    g.lineWidth = 3;
    const cx = gx + gw / 2;
    const cy = gy + gh / 2;
    g.beginPath();
    g.moveTo(cx - 26, cy);
    g.lineTo(cx + 26, cy);
    g.moveTo(cx, cy - 26);
    g.lineTo(cx, cy + 26);
    g.stroke();
    return toSendBuffer(c);
  });
}

function btEditorCaption(kind, elem) {
  const s = bannerTpl.getSettings(kind);
  const e = BT_ELEMS[elem];
  const rect = s.slotShape === "rect";
  let detail;
  if (elem === "logo") {
    detail = rect
      ? `Slot <b>${s.slotW}×${s.slotH}px</b> di (${s.logoX}, ${s.logoY})`
      : `<b>${s.logoSize}px</b> di (${s.logoX}, ${s.logoY})`;
  } else {
    detail = `<b>${s[e.sizeKey]}px</b> di (${s[e.xKey]}, ${s[e.yKey]})`;
  }
  return (
    `🖱 <b>${BT_KINDS[kind]} — layout editor</b>\n` +
    `Active element: <b>${e.label}</b> — ${detail}\n` +
    `Yellow outline = selected element. Pick an element below, arrows move it, ➕/➖ resize.` +
    (elem === "ticker" ? " The token name moves together with the ticker." : "")
  );
}

function btEditorKb(kind, elem) {
  const s = bannerTpl.getSettings(kind);
  const rect = s.slotShape === "rect";
  const cb = Markup.button.callback;
  const showText = s.showText !== false;
  // element selector — active one marked; banner-ads (rect, no text) only has logo
  const selectable = rect || !showText ? ["logo"] : BT_ELEM_KEYS;
  const rows = [];
  if (selectable.length > 1) {
    rows.push(
      selectable.map((k) =>
        cb(k === elem ? `• ${BT_ELEMS[k].label} •` : BT_ELEMS[k].label, `bt_esel:${kind}:${k}`),
      ),
    );
  }
  const step = elem === "logo" ? BT_NUDGE : BT_TEXT_NUDGE;
  rows.push([
    cb("◀", `bt_emv:${kind}:${elem}:${-step}:0`),
    cb("🔼", `bt_emv:${kind}:${elem}:0:${-step}`),
    cb("🔽", `bt_emv:${kind}:${elem}:0:${step}`),
    cb("▶", `bt_emv:${kind}:${elem}:${step}:0`),
  ]);
  if (elem === "logo" && rect) {
    rows.push([
      cb("↔️ W−", `bt_ewh:${kind}:${-BT_NUDGE}:0`),
      cb(`${s.slotW}×${s.slotH}`, `bt_slot:${kind}`),
      cb("↔️ W+", `bt_ewh:${kind}:${BT_NUDGE}:0`),
    ]);
    rows.push([cb("↕️ H−", `bt_ewh:${kind}:0:${-BT_NUDGE}`), cb("↕️ H+", `bt_ewh:${kind}:0:${BT_NUDGE}`)]);
  } else {
    const szStep = elem === "logo" ? BT_NUDGE : BT_ELEMS[elem].step;
    const cur = elem === "logo" ? `${s.logoSize}px` : `${s[BT_ELEMS[elem].sizeKey]}px`;
    rows.push([
      cb("➖ Kecil", `bt_esz:${kind}:${elem}:${-szStep}`),
      cb(cur, `bt_pos:${kind}`),
      cb("➕ Besar", `bt_esz:${kind}:${elem}:${szStep}`),
    ]);
  }
  rows.push([cb("↩️ Reset layout", `bt_erst:${kind}`), cb("✅ Selesai", `bt_done:${kind}`)]);
  return Markup.inlineKeyboard(rows);
}

async function btEditorImage(kind, elem) {
  const buf = await bannerTpl.compose(kind, sampleMedia(kind), {
    symbol: "SAMPLE", name: "Sample Token", chain: "SOLANA", price: "$0.0042", mcap: "$1.2M", badge: "Diamond Tier",
  });
  if (!buf) return null;
  return btGuideOverlay(buf, kind, elem).catch(() => buf);
}

async function btEditorOpen(ctx, kind, elem = "logo") {
  if (!bannerTpl.hasTemplate(kind)) {
    return ctx.reply(`❌ No ${kind} artwork available yet. Tap ⬆ Upload first.`).catch(() => {});
  }
  const img = await btEditorImage(kind, elem);
  if (!img) return ctx.reply("⚠️ Editor render failed — check pm2 logs.").catch(() => {});
  await ctx
    .replyWithPhoto({ source: img }, { caption: btEditorCaption(kind, elem), parse_mode: "HTML", ...btEditorKb(kind, elem) })
    .catch(() => {});
}

async function btEditorRefresh(ctx, kind, elem = "logo") {
  const img = await btEditorImage(kind, elem);
  if (!img) return;
  await ctx
    .editMessageMedia(
      { type: "photo", media: { source: img }, caption: btEditorCaption(kind, elem), parse_mode: "HTML" },
      { reply_markup: btEditorKb(kind, elem).reply_markup },
    )
    .catch(() => btEditorOpen(ctx, kind, elem)); // message too old / edit failed → fresh editor
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
    return toSendBuffer(c);
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
// Plain-language meaning for every {placeholder}, so admins aren't staring at
// cryptic tags. AUTO ones are filled AND formatted automatically (usually leave
// them as-is); the rest are simple live values you place wherever you want them.
const PH_HELP = {
  // auto-filled links & blocks (leave them where they are)
  logoEmoji: "the token’s logo emoji",
  chainEmoji: "the network’s emoji (from the Chain emoji template)",
  twitter: "the token’s X link",
  website: "the token’s Website link",
  telegram: "the token’s Telegram link",
  site: "the dexvra.io link",
  listing: "the Listings channel link",
  trending: "the Trending channel link",
  announce: "the Announcements channel link",
  xUrl: "link to the X announcement post (auto after tweeting)",
  tradeUrl: "deep link that opens this token in the Dexvra Trade Bot",
  change: "24h change sentence",
  tierEmoji: "tier emoji (from the paid tier)",
  // legacy blocks (older saved templates only)
  head: "the header line (e.g. “New Listing on Dexvra”)",
  tierLine: "tier badge line (e.g. “💎 Diamond tier”)",
  overview: "the project description paragraph",
  socials: "the project’s social links block (X · Website · Telegram)",
  footer: "the Dexvra channel links block",
  // simple live values
  name: "token name",
  symbol: "ticker (e.g. $CUBEMAN)",
  tag: "ticker without the $",
  mention: "the token’s X @handle",
  chain: "blockchain (e.g. Solana)",
  address: "contract address",
  price: "token price",
  mcap: "market cap",
  liq: "liquidity",
  coinUrl: "full Dexvra token-page link",
  coinUrlLabel: "the Dexvra link shown as text",
  url: "link",
  rank: "trending rank number",
  percent: "pump % since listing",
  multiple: "pump multiple (e.g. 2×)",
  firstMc: "market cap at listing",
  lastMc: "current market cap",
  native: "native coin (SOL / BNB / ETH)",
  hours: "number of hours",
  discount: "renewal discount %",
  reached: "number of users reached",
  ref: "reference id",
  slot: "banner slot name",
  linkUrl: "advertiser link",
  title: "advertiser / project title",
  tier: "tier name (Diamond, Gold…)",
};
const AUTO_PH = new Set([
  "head", "tierLine", "logoEmoji", "overview", "socials", "footer",
  "chainEmoji", "twitter", "website", "telegram", "site", "listing", "trending", "announce",
  "xUrl", "tradeUrl", "change", "tierEmoji",
]);

// A friendly legend: split the template's placeholders into "your values" vs
// "auto — leave as-is" with a plain description for each.
function phLegend(phList) {
  if (!phList || !phList.length) return "";
  const val = [];
  const auto = [];
  for (const p of phList) {
    const line = `• <code>{${p}}</code> — ${PH_HELP[p] || "live value"}`;
    (AUTO_PH.has(p) ? auto : val).push(line);
  }
  let out = "";
  if (val.length) out += `\n✍️ <b>Your values</b> (put where you want them):\n${val.join("\n")}\n`;
  if (auto.length) out += `\n🤖 <b>Auto — usually leave as-is</b>:\n${auto.join("\n")}\n`;
  return out;
}

// The controls card (label + placeholders + hint). The current text itself is
// NOT embedded here — it's sent as its own PLAIN message just above (see
// sendTemplateView), like fourtisadminbot, so operators see it as normal text
// with no code-box / blockquote / copy button.
function viewText(key) {
  const m = tpl.meta(key);
  const val = tpl.getRawValue(key);
  let premiumNote = "";
  if (val && typeof val === "object" && val.entities && val.entities.length) {
    const nPrem = val.entities.filter((e) => e.type === "custom_emoji").length;
    premiumNote = nPrem
      ? `💎 Saved with ${nPrem} premium emoji.\n`
      : `ℹ️ Saved with ${val.entities.length} formatting entities.\n`;
  }
  return (
    `<b>${escapeHtml(m.label)}</b> — ${tpl.isCustom(key) ? "✏️ custom" : "📋 default"}\n` +
    `${premiumNote}` +
    `\n☝️ The message above is what’s live now. Tap <b>✏️ Edit</b> to change the wording — ` +
    `type it like a normal message (emoji & line breaks are kept).` +
    (m.ph.length
      ? ` The <code>{tags}</code> below get swapped for live data — keep the ones you want, delete the rest.\n${phLegend(m.ph)}`
      : ``)
  );
}

// Send the current template as a PLAIN standalone message (premium emoji ride
// via entities; markup/default strings render to clean text), then the controls
// card — the fourtisadminbot layout.
async function sendTemplateView(ctx, key) {
  const cur = currentCopyable(key);
  if (cur.text && cur.text.trim()) {
    await ctx
      .reply(cur.text, cur.extra)
      .catch(() => ctx.reply(cur.text, { disable_web_page_preview: true }).catch(() => {}));
  }
  await ctx.reply(viewText(key), { ...HTML, ...viewKb(key) }).catch(() => {});
}

// The current template value in COPYABLE form, so an admin can copy → tweak →
// send back instead of retyping a long message from scratch. Entity-saved
// templates keep their text (premium emoji ride as fallback chars — a regular
// bot can't re-emit real premium emoji, and the admin re-inserts their own
// anyway); markup/default strings are rendered to clean text (no raw
// [💎](emoji/ID) / **bold** noise).
function currentCopyable(key) {
  const val = tpl.getRawValue(key);
  if (val && typeof val === "object" && val.text != null) {
    const extra = val.entities && val.entities.length
      ? { entities: val.entities, disable_web_page_preview: true }
      : { disable_web_page_preview: true };
    return { text: val.text, extra };
  }
  let clean;
  try {
    clean = require("../premium").parse(String(val || "")).text;
  } catch {
    clean = String(val || "");
  }
  return { text: clean, extra: { disable_web_page_preview: true } };
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

// The admin bot can't DM a buyer with its own token (the buyer /start-ed the
// MAIN bot). A minimal main-bot Telegram client lets us notify buyers on
// reject. Telegraf's telegram client needs no polling — send-only is fine.
let mainBotApi = null;
try {
  const { BOT_TOKEN } = require("../config/constants");
  if (BOT_TOKEN) mainBotApi = new Telegraf(BOT_TOKEN).telegram;
} catch {
  /* main-bot DMs are best-effort */
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

  // /preview [group-slug] — audit EVERY template at once (clean rendered text,
  // grouped, ✏️=custom / •=default). No arg → short snippet of all; a group slug
  // → longer previews for just that group. Messages are chunked under 4096.
  bot.command("preview", async (ctx) => {
    if (!guard(ctx)) return;
    await sendTemplateAudit(ctx, (ctx.message.text.split(/\s+/)[1] || "").toLowerCase());
  });
  bot.action("audit", async (ctx) => {
    ctx.answerCbQuery("Auditing all templates…").catch(() => {});
    if (!guard(ctx)) return;
    await sendTemplateAudit(ctx, "");
  });

  // Reset ALL templates to their code defaults — destructive, so gate behind a
  // confirm. Counts how many custom overrides exist before wiping.
  bot.action("resetall", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    // overrideCount() counts EVERY saved override, incl. orphaned keys from
    // older template generations — keys() would miss those and wrongly report
    // "nothing to reset" on a data file that still has stale entries.
    const n = tpl.overrideCount();
    if (!n) {
      return edit(ctx, "♻️ <b>Nothing to reset</b>\n\nEvery template is already on its default.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "home")]]));
    }
    await edit(
      ctx,
      `♻️ <b>Reset ALL templates to default?</b>\n\nThis reverts <b>${n}</b> custom template${n === 1 ? "" : "s"} you've edited back to the built-in defaults. This cannot be undone.`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`✅ Yes, reset all ${n}`, "resetall_yes")],
        [Markup.button.callback("⬅ Cancel", "home")],
      ]),
    );
  });
  bot.action("resetall_yes", async (ctx) => {
    ctx.answerCbQuery("Resetting…").catch(() => {});
    if (!guard(ctx)) return;
    const n = await tpl.resetAllTemplates();
    log.info(`[adminbot] ALL templates reset to default (${n} custom cleared) by @${ctx.from.username || ctx.from.id}`);
    await edit(
      ctx,
      `✅ <b>Done — ${n} template${n === 1 ? "" : "s"} reset to default.</b>\n\nAll bot messages and channel posts are back to the built-in copy. Goes live within ~30s.`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅ Back to menu", "home")]]),
    );
  });

  bot.action("home", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session = {};
    await edit(ctx, homeText(), mainKb());
  });

  bot.action("noop", (ctx) => ctx.answerCbQuery().catch(() => {}));

  bot.action(/^grp:([a-z0-9]+)(?::(\d+))?$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const slug = ctx.match[1];
    const name = nameFromSlug(slug);
    if (!name) return edit(ctx, homeText(), mainKb());
    const g = tpl.groups()[name] || [];
    const pages = pageCount(g.length);
    const p = clampPage(ctx.match[2], pages);
    await edit(ctx, groupText(name, p, pages), groupKb(slug, p));
  });

  bot.action(/^v:(.+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!tpl.keys().includes(key)) return;
    await sendTemplateView(ctx, key);
  });

  bot.action(/^e:(.+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!tpl.keys().includes(key)) return;
    ctx.session.awaitingTemplate = key;
    const m = tpl.meta(key);
    await ctx.reply(
      `✏️ Send the new text for <b>${escapeHtml(m.label)}</b>.\n\n` +
        `Type it like a normal message — line breaks, spaces and emoji are kept exactly. ` +
        `💎 For <b>premium emoji</b>, insert them straight from your keyboard as you type.\n\n` +
        `Tip: copy the current text shown above, tweak the wording, and send it back — keep the <code>{tags}</code> where you want the live values.` +
        (m.ph.length ? `\n${phLegend(m.ph)}` : ``) +
        `\nSend /cancel to abort.`,
      HTML,
    );
  });

  bot.action(/^r:(.+)$/, async (ctx) => {
    ctx.answerCbQuery("Reset to default").catch(() => {});
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!tpl.keys().includes(key)) return;
    await tpl.resetTemplate(key);
    await sendTemplateView(ctx, key);
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
  const KM = "(listing|trending|banner|pump)"; // media-capable kinds (incl. pump)
  bot.action("bt", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, btHomeText(), btHomeKb());
  });
  bot.action(new RegExp(`^btk:${KM}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await edit(ctx, btKindText(ctx.match[1]), btKindKb(ctx.match[1]));
  });
  // Upload a GIF/video clip for a kind (incl. pump). Accepts animation/video/
  // document; the file's extension picks animation vs video at send time.
  bot.action(new RegExp(`^bt_med:${KM}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBt = { mode: "media_upload", kind: ctx.match[1] };
    await ctx.reply(
      `🎞 Send the <b>${BT_KINDS[ctx.match[1]]} GIF or video</b> — a GIF/animation or a short MP4 (send as a <b>file/document</b> for best quality, ≤ ~20 MB). It plays above every ${BT_KINDS[ctx.match[1]]} post. /cancel to abort.`,
      HTML,
    );
  });
  bot.action(new RegExp(`^bt_medrm:${KM}$`), async (ctx) => {
    ctx.answerCbQuery("Clip removed").catch(() => {});
    if (!guard(ctx)) return;
    await bannerTpl.removeMedia(ctx.match[1]);
    await edit(ctx, btKindText(ctx.match[1]), btKindKb(ctx.match[1]));
  });
  bot.action(new RegExp(`^bt_up:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    ctx.session.awaitingBt = { mode: "upload", kind: ctx.match[1] };
    await ctx.reply(
      `⬆ Send the <b>${BT_KINDS[ctx.match[1]]} artwork</b> — ideally <b>2560×1280 PNG sent as a FILE/document</b> (Telegram compresses photos to ~1280px; a photo still works, it just gets upscaled). Send /cancel to abort.`,
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

  // Interactive layout editor: element selector + nudge + resize, all editing
  // one photo message in place. Element rides in the callback data (stateless).
  const E = "(logo|ticker|meta|badge)";
  bot.action(new RegExp(`^bt_ed:${K}$`), async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    await btEditorOpen(ctx, ctx.match[1], "logo");
  });
  bot.action(new RegExp(`^bt_esel:${K}:${E}$`), async (ctx) => {
    if (!guard(ctx)) return;
    const [, kind, elem] = ctx.match;
    ctx.answerCbQuery(BT_ELEMS[elem].label).catch(() => {});
    await btEditorRefresh(ctx, kind, elem);
  });
  bot.action(new RegExp(`^bt_emv:${K}:${E}:(-?\\d+):(-?\\d+)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const [, kind, elem, dxs, dys] = ctx.match;
    const s = bannerTpl.getSettings(kind);
    const e = BT_ELEMS[elem];
    const x = Math.max(-800, Math.min(3200, btNum(s[e.xKey], 1070) + Number(dxs)));
    const y = Math.max(-800, Math.min(3200, btNum(s[e.yKey], 430) + Number(dys)));
    await bannerTpl.updateSettings(kind, { [e.xKey]: x, [e.yKey]: y });
    ctx.answerCbQuery(`📍 ${x}, ${y}`).catch(() => {});
    await btEditorRefresh(ctx, kind, elem);
  });
  bot.action(new RegExp(`^bt_esz:${K}:${E}:(-?\\d+)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const [, kind, elem, ds] = ctx.match;
    const s = bannerTpl.getSettings(kind);
    if (elem === "logo") {
      const size = Math.max(60, Math.min(1600, Number(s.logoSize) + Number(ds)));
      // grow/shrink around the slot CENTER so the ring stays put while resizing
      const dx = (Number(s.logoSize) - size) / 2;
      await bannerTpl.updateSettings(kind, {
        logoSize: size,
        logoX: Math.round(btNum(s.logoX, 1070) + dx),
        logoY: Math.round(btNum(s.logoY, 430) + dx),
      });
      ctx.answerCbQuery(`Logo ${size}px`).catch(() => {});
    } else {
      const e = BT_ELEMS[elem];
      const size = Math.max(12, Math.min(200, Number(s[e.sizeKey]) + Number(ds)));
      const patch = { [e.sizeKey]: size };
      // name stays visually paired with the ticker at half its size
      if (elem === "ticker") patch.nameFontSize = Math.max(12, Math.round(size / 2));
      await bannerTpl.updateSettings(kind, patch);
      ctx.answerCbQuery(`${e.label} ${size}px`).catch(() => {});
    }
    await btEditorRefresh(ctx, kind, elem);
  });
  bot.action(new RegExp(`^bt_ewh:${K}:(-?\\d+):(-?\\d+)$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    const s = bannerTpl.getSettings(kind);
    const w = Math.max(200, Math.min(2560, Number(s.slotW) + Number(ctx.match[2])));
    const h = Math.max(120, Math.min(1280, Number(s.slotH) + Number(ctx.match[3])));
    await bannerTpl.updateSettings(kind, { slotW: w, slotH: h });
    ctx.answerCbQuery(`📐 ${w}×${h}`).catch(() => {});
    await btEditorRefresh(ctx, kind, "logo");
  });
  bot.action(new RegExp(`^bt_erst:${K}$`), async (ctx) => {
    if (!guard(ctx)) return;
    const kind = ctx.match[1];
    await bannerTpl.resetSettings(kind);
    log.info(`[adminbot] ${kind} banner layout reset to defaults by @${ctx.from.username || ctx.from.id}`);
    ctx.answerCbQuery("↩️ Layout kembali ke default").catch(() => {});
    await btEditorRefresh(ctx, kind, "logo");
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

  // ── Paid Mass DM review ─────────────────────────────────────────────────
  // Lists pending paid broadcasts and previews each with Approve/Reject. The
  // main-bot sender only runs jobs in `in_progress`, so approve = flip status.
  const massStore = require("../massdm/store");
  async function previewMassJob(ctx, job) {
    const buyer = job.createdByUsername ? `@${job.createdByUsername}` : `id ${job.createdBy}`;
    const cap = `🕵️ <b>Mass DM review</b> — ref <code>${escapeHtml(job.ref || job.id)}</code>\nFrom: ${escapeHtml(buyer)} · audience ${job.total}`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("✅ Approve & send", `massrev_ok_${job.id}`), Markup.button.callback("🚫 Reject", `massrev_no_${job.id}`)],
    ]);
    try {
      if (job.mediaPath && fss.existsSync(job.mediaPath)) {
        await ctx.replyWithPhoto({ source: job.mediaPath }, { caption: job.text || cap, ...(job.entities && job.entities.length ? { caption_entities: job.entities } : {}) });
      } else if (job.entities && job.entities.length) {
        await ctx.reply(job.text, { entities: job.entities, disable_web_page_preview: true });
      } else if (job.text) {
        await ctx.reply(job.text, HTML);
      }
    } catch {
      /* preview best-effort */
    }
    await ctx.reply(cap, { ...HTML, ...kb });
  }
  bot.command("reviewmassdm", async (ctx) => {
    if (!guard(ctx)) return;
    const pending = massStore.jobsByStatus("pending_review");
    if (!pending.length) return ctx.reply("No paid Mass DM broadcasts awaiting review. ✅", HTML);
    await ctx.reply(`📣 <b>${pending.length}</b> broadcast(s) awaiting review:`, HTML);
    for (const job of pending.slice(0, 10)) await previewMassJob(ctx, job);
  });
  bot.action(/^massrev_ok_(.+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const job = massStore.loadJob(ctx.match[1]);
    if (!job) return ctx.reply("That job no longer exists.", HTML);
    if (job.status !== "pending_review") return ctx.reply(`Already ${job.status}.`, HTML);
    job.status = "in_progress"; // the main-bot sender picks it up within ~poll interval
    await massStore.saveJob(job);
    log.info(`[adminbot] mass DM ${job.id} APPROVED by @${ctx.from.username || ctx.from.id}`);
    await ctx.reply(`✅ Approved <code>${escapeHtml(job.ref || job.id)}</code> — sending now.`, HTML);
  });
  bot.action(/^massrev_no_(.+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!guard(ctx)) return;
    const job = massStore.loadJob(ctx.match[1]);
    if (!job) return ctx.reply("That job no longer exists.", HTML);
    if (job.status !== "pending_review") return ctx.reply(`Already ${job.status}.`, HTML);
    job.status = "rejected";
    job.rejectedAt = Date.now();
    await massStore.saveJob(job);
    log.info(`[adminbot] mass DM ${job.id} REJECTED by @${ctx.from.username || ctx.from.id}`);
    // DM the buyer via the MAIN bot (this admin bot can't reach them).
    if (mainBotApi && job.createdBy) {
      mainBotApi
        .sendMessage(job.createdBy, `Your Mass DM broadcast (ref ${job.ref || job.id}) wasn't approved. Contact support for a review or refund.`)
        .catch(() => {});
    }
    await ctx.reply(`🚫 Rejected <code>${escapeHtml(job.ref || job.id)}</code>.`, HTML);
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
    await sendTemplateView(ctx, key);
  });

  // Photo = banner upload (when awaiting)
  bot.on(["photo", "document", "animation", "video"], async (ctx) => {
    if (!guard(ctx)) return;
    // GIF/video clip upload (per kind, incl. pump) — wins over the still artwork
    if (ctx.session.awaitingBt && ctx.session.awaitingBt.mode === "media_upload") {
      const { kind } = ctx.session.awaitingBt;
      const m = ctx.message;
      let fileId, ext;
      if (m.animation) { fileId = m.animation.file_id; ext = "gif"; } // looping clip → sendAnimation
      else if (m.video) { fileId = m.video.file_id; ext = "mp4"; }
      else if (m.document) {
        fileId = m.document.file_id;
        const fn = String(m.document.file_name || "").toLowerCase();
        ext = fn.endsWith(".gif") ? "gif" : fn.endsWith(".webm") ? "webm" : fn.endsWith(".mov") ? "mov" : "mp4";
      }
      if (!fileId) return ctx.reply("Send a GIF or a video (or an mp4/gif file).").catch(() => {});
      ctx.session.awaitingBt = null;
      try {
        const link = await ctx.telegram.getFileLink(fileId);
        const res = await fetch(link.href || String(link), { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`download ${res.status}`);
        const { type } = await bannerTpl.saveMedia(kind, Buffer.from(await res.arrayBuffer()), ext);
        log.info(`[adminbot] ${kind} ${type} clip uploaded by @${ctx.from.username || ctx.from.id}`);
        await ctx.reply(`✅ <b>${BT_KINDS[kind]} ${type} saved.</b> It now plays above every ${BT_KINDS[kind]} post (it overrides the still artwork).`, { ...HTML, ...btKindKb(kind) });
      } catch (e) {
        await ctx.reply(`⚠️ Couldn't save the clip: ${e.message}`).catch(() => {});
      }
      return;
    }
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
        const artBuf = Buffer.from(await res.arrayBuffer());
        await bannerTpl.saveTemplate(kind, artBuf);
        let sizeNote = "";
        try {
          const im = await require("@napi-rs/canvas").loadImage(artBuf);
          if (im.width < 2000) {
            sizeNote = `\n\n⚠️ Sent at ${im.width}×${im.height}px (Telegram compresses photos). It'll still be used — auto-upscaled to 2560×1280 — but for best quality re-send it as a <b>File/document</b>.`;
          }
        } catch { /* dimension probe is best-effort */ }
        log.info(`[adminbot] ${kind} banner artwork uploaded by @${ctx.from.username || ctx.from.id}`);
        await ctx.reply(
          `✅ <b>${BT_KINDS[kind]} artwork saved.</b> Open 🖱 Logo editor to place the logo/text, then 👁 Preview.${sizeNote}`,
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
  // Restore/seed templates + banner config from the Mongo durable mirror before
  // serving the editor (fail-open without MONGO_URI).
  try {
    await require("../helpers/persist").hydrate();
    await require("../db/jobMirror").restoreAll(); // so /reviewbroadcasts sees pending jobs after a VPS reset
  } catch (e) {
    log.warn(`[adminbot] persist hydrate failed (continuing on local files): ${e && e.message}`);
  }
  const bot = build();
  await bot.telegram.setMyCommands([
    { command: "start", description: "Open the template editor" },
    { command: "preview", description: "Audit all templates at once" },
    { command: "home", description: "Back to the menu" },
    { command: "cancel", description: "Cancel the current edit" },
  ]).catch(() => {});
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
  log.info("[adminbot] launching (long-polling)…");
  await bot.launch({ allowedUpdates: ["message", "callback_query"] });
}

module.exports = { startAdminBot, build };
// Exposed for tests: the group-menu keyboard builder + its paging constant.
module.exports._menu = { groupKb, mainKb, groupNames, slugOf, nameFromSlug, GROUP_PAGE };
