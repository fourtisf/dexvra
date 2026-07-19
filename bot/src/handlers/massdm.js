// Paid Mass DM flow (public): compose one message → pay a flat price → an admin
// reviews it → the main-bot sender DMs the whole /start audience once. The order
// only PERSISTS a pending_review job on payment (funds are already swept before
// onSuccess, so fulfilment must never throw — a failed enqueue tells the buyer
// to contact support, it never aborts). Admins get a FREE test-send that skips
// review and targets only themselves + the composer.
const { answer, toast, sendCard, getMediaFileId, payloadArgs } = require("../helpers/message");
const { nativeOf, payNativeOf } = require("../config/chains");
const { MASS_DM_PRICE, MASS_DM_ENABLED, isAdminUser, ADMIN_IDS } = require("../config/constants");
const { startPayment } = require("./pay");
const menu = require("./menu");
const { Markup } = menu;
const tpl = require("../templates");
const premium = require("../premium");
const store = require("../massdm/store");

// Pay currencies offered (one per native coin). Mirrors the flat-price map.
const PAY_CHAINS = ["solana", "bsc", "ethereum"];

function freshSession(ctx, patch) {
  const prev = ctx.session && ctx.session.latest_bot_message;
  ctx.session = { latest_bot_message: prev, ...patch };
}

function priceFor(chain) {
  return MASS_DM_PRICE[payNativeOf(chain)] ?? null;
}

async function entryMassDm(ctx) {
  await answer(ctx);
  if (ctx.chat && ctx.chat.type !== "private") return;
  if (!MASS_DM_ENABLED) return toast(ctx, tpl.render("massdm_disabled"));
  freshSession(ctx, { type: "massdm", awaitingField: "massdm_compose" });
  const intro = tpl.render("massdm_intro", {
    sol: fmtPrice(MASS_DM_PRICE.SOL, "SOL"),
    bnb: fmtPrice(MASS_DM_PRICE.BNB, "BNB"),
    eth: fmtPrice(MASS_DM_PRICE.ETH, "ETH"),
  });
  await sendCard(ctx, intro, menu.withHome([]));
}

const fmtPrice = (n, sym) => (n == null ? "—" : `${n} ${sym}`);

// Preview + pay/test controls once a message is composed.
function reviewKb(ctx) {
  const rows = PAY_CHAINS.filter((c) => priceFor(c) != null).map((c) => [
    Markup.button.callback(`💳 Pay ${priceFor(c)} ${nativeOf(c)} (${nativeOf(c)})`, `md_pay_${c}`),
  ]);
  if (isAdminUser(ctx)) {
    rows.push([Markup.button.callback("🧪 Test send (admins only • FREE)", "md_test")]);
  }
  rows.push([Markup.button.callback("✏️ Recompose", "ad_massdm"), Markup.button.callback("🏠 Home", "home")]);
  return Markup.inlineKeyboard(rows);
}

async function capture(ctx, { text, entities, mediaFileId }) {
  const s = ctx.session;
  s.massForm = { text: text || "", entities: entities || [], mediaFileId: mediaFileId || null };
  s.awaitingField = null;
  // Echo the composed message back (with its own entities) then the controls.
  const previewExtra = (s.massForm.entities || []).length
    ? { entities: s.massForm.entities, disable_web_page_preview: true }
    : { disable_web_page_preview: true };
  try {
    if (s.massForm.mediaFileId) {
      await ctx.replyWithPhoto(s.massForm.mediaFileId, s.massForm.text ? { caption: s.massForm.text, caption_entities: s.massForm.entities } : {});
    } else if (s.massForm.text) {
      await ctx.reply(s.massForm.text, previewExtra);
    }
  } catch {
    /* preview is best-effort */
  }
  await sendCard(ctx, tpl.render("massdm_preview"), reviewKb(ctx));
}

async function handleText(ctx) {
  const s = ctx.session;
  if (s.type !== "massdm" || s.awaitingField !== "massdm_compose") return;
  const text = (ctx.message.text || "").trim();
  if (!text) return;
  return capture(ctx, { text, entities: ctx.message.entities || [] });
}

async function handlePhoto(ctx) {
  const s = ctx.session;
  if (s.type !== "massdm" || s.awaitingField !== "massdm_compose") return;
  const id = getMediaFileId(ctx);
  if (!id) return toast(ctx, "Couldn't read that image — send a photo, or text.");
  return capture(ctx, { text: ctx.message.caption || "", entities: ctx.message.caption_entities || [], mediaFileId: id });
}

async function payPick(ctx) {
  await answer(ctx);
  const s = ctx.session;
  if (!s.massForm) return toast(ctx, tpl.render("session_expired"));
  const chain = ctx.match[1];
  const price = priceFor(chain);
  if (price == null) return toast(ctx, tpl.render("pricing_unavailable"));
  await startPayment(ctx, {
    kind: "mass_dm",
    chain,
    native: nativeOf(chain),
    humanAmount: price,
    label: `Mass DM broadcast — to all Dexvra users`,
    payload: {
      text: s.massForm.text,
      entities: s.massForm.entities,
      mediaFileId: s.massForm.mediaFileId,
    },
  });
}

// FREE admin test — no payment, straight to in_progress, targeted to resolved
// admin ids + the composer, delivery report to the composer.
async function testSend(ctx) {
  await answer(ctx);
  if (!isAdminUser(ctx)) return toast(ctx, "Admins only.");
  const s = ctx.session;
  if (!s.massForm) return toast(ctx, tpl.render("session_expired"));
  const composer = String(ctx.from.id);
  const targets = Array.from(new Set([...ADMIN_IDS.map(String), composer])).filter(Boolean);
  let mediaPath = null;
  if (s.massForm.mediaFileId) {
    mediaPath = await downloadMedia(ctx, s.massForm.mediaFileId).catch(() => null);
  }
  await store.createJob({
    text: s.massForm.text,
    entities: s.massForm.entities,
    mediaPath,
    createdBy: ctx.from.id,
    createdByUsername: ctx.from.username || null,
    targets,
    test: true,
    reportChatId: ctx.from.id,
    ref: refFor(),
  });
  freshSession(ctx, {});
  await sendCard(ctx, tpl.render("massdm_test_queued"), menu.postPurchase());
}

function refFor() {
  return `MD-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

// Download a Telegram photo file to a temp path for the sender to re-upload
// once (the main bot can't reuse a file_id captured by a different bot token,
// but here it's the SAME bot — still, persisting a path survives a restart).
async function downloadMedia(ctx, fileId) {
  const os = require("node:os");
  const path = require("node:path");
  const { promises: fs } = require("node:fs");
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(link.href || String(link), { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const dir = path.join(os.tmpdir(), "dexvra-massdm");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

module.exports = { entryMassDm, handleText, handlePhoto, payPick, testSend, refFor, downloadMedia, PAY_CHAINS };
