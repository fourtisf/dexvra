// Paid Mass DM flow (public): CA FIRST → compose → pay → admin review → send.
// Like fourtis: the buyer drops their token's contract address first, which
// locks the payment currency to that token's chain (Solana→SOL, ETH/Base→ETH,
// everything else→BNB). Then they compose one message and pay. The order only
// PERSISTS a pending_review job on payment (funds are swept before onSuccess,
// so fulfilment must never throw). Admins get a FREE test-send.
const { answer, toast, sendCard, getMediaFileId } = require("../helpers/message");
const { nativeOf, chainOf } = require("../config/chains");
const { MASS_DM_PRICE, MASS_DM_ENABLED, isAdminUser, ADMIN_IDS } = require("../config/constants");
const { startPayment } = require("./pay");
const groupSetup = require("../group/setup");
const menu = require("./menu");
const { Markup } = menu;
const tpl = require("../templates");
const premium = require("../premium");
const store = require("../massdm/store");

function freshSession(ctx, patch) {
  const prev = ctx.session && ctx.session.latest_bot_message;
  ctx.session = { latest_bot_message: prev, ...patch };
}

const fmtPrice = (n, sym) => (n == null ? "—" : `${n} ${sym}`);

// The three Mass DM pay currencies, mapped from the token's chain. The buyer
// pays in the currency of the chain their token lives on.
function currencyOf(chain) {
  if (chain === "solana") return "SOL";
  if (chain === "ethereum" || chain === "base") return "ETH";
  return "BNB"; // bsc, tron, ton, robinhood, plasma, sui, …
}
const PAY_CHAIN = { SOL: "solana", BNB: "bsc", ETH: "ethereum" };
function payFor(tokenChain) {
  const currency = currencyOf(tokenChain);
  return { currency, payChain: PAY_CHAIN[currency], native: currency, price: MASS_DM_PRICE[currency] };
}

// Loose CA shape check (matches the chains we support) before we scan it.
const CA_RE = /^(0x[a-fA-F0-9]{40}(::[A-Za-z0-9_]+)*|0x[a-fA-F0-9]{1,64}(::[A-Za-z0-9_]+){1,2}|T[1-9A-HJ-NP-Za-km-z]{33}|(EQ|UQ|0:)[A-Za-z0-9_-]{40,66}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const looksLikeCA = (s) => CA_RE.test(String(s || "").trim());

async function entryMassDm(ctx) {
  await answer(ctx);
  if (ctx.chat && ctx.chat.type !== "private") return;
  if (!MASS_DM_ENABLED) return toast(ctx, tpl.render("massdm_disabled"));
  freshSession(ctx, { type: "massdm", awaitingField: "massdm_ca" });
  const intro = tpl.render("massdm_intro", {
    sol: fmtPrice(MASS_DM_PRICE.SOL, "SOL"),
    bnb: fmtPrice(MASS_DM_PRICE.BNB, "BNB"),
    eth: fmtPrice(MASS_DM_PRICE.ETH, "ETH"),
  });
  await sendCard(ctx, intro, menu.withHome([]));
}

// Step 1 — capture the token CA, resolve its chain, lock the pay currency.
async function captureCa(ctx, input) {
  const s = ctx.session;
  const ca = String(input || "").trim().split(/\s+/)[0];
  if (!looksLikeCA(ca)) return sendCard(ctx, tpl.render("massdm_ca_invalid"), menu.withHome([]));
  await ctx.reply("🔍 Detecting your token's chain…").catch(() => {});
  const res = await groupSetup.resolveToken(ca).catch(() => null);
  const chain = res ? res.chain : groupSetup.candidateChains(ca)[0]; // fall back to the shape guess
  const pay = payFor(chain);
  s.massForm = { ca, chain, pay };
  s.awaitingField = "massdm_compose";
  await sendCard(
    ctx,
    tpl.render("massdm_compose_prompt", {
      chain: chainOf(chain) ? chainOf(chain).label : chain,
      amount: `${pay.price} ${pay.native}`,
    }),
    menu.withHome([]),
  );
}

// Step 2 — capture the broadcast message, show the preview + pay/test controls.
async function capture(ctx, { text, entities, mediaFileId }) {
  const s = ctx.session;
  s.massForm = { ...s.massForm, text: text || "", entities: entities || [], mediaFileId: mediaFileId || null };
  s.awaitingField = null;
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
    /* preview best-effort */
  }
  await sendCard(ctx, tpl.render("massdm_preview", { amount: `${s.massForm.pay.price} ${s.massForm.pay.native}` }), reviewKb(ctx));
}

function reviewKb(ctx) {
  const pay = ctx.session.massForm.pay;
  const rows = [[Markup.button.callback(`💳 Pay ${pay.price} ${pay.native}`, "md_pay")]];
  if (isAdminUser(ctx)) rows.push([Markup.button.callback("🧪 Test send (admins only • FREE)", "md_test")]);
  rows.push([Markup.button.callback("✏️ Recompose", "ad_massdm"), Markup.button.callback("🏠 Home", "home")]);
  return Markup.inlineKeyboard(rows);
}

async function handleText(ctx) {
  const s = ctx.session;
  if (s.type !== "massdm") return;
  const text = (ctx.message.text || "").trim();
  if (!text) return;
  if (s.awaitingField === "massdm_ca") return captureCa(ctx, text);
  if (s.awaitingField === "massdm_compose") return capture(ctx, { text, entities: ctx.message.entities || [] });
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
  if (!s.massForm || !s.massForm.pay || s.massForm.text == null) return toast(ctx, tpl.render("session_expired"));
  const pay = s.massForm.pay;
  if (pay.price == null) return toast(ctx, tpl.render("pricing_unavailable"));
  await startPayment(ctx, {
    kind: "mass_dm",
    chain: pay.payChain,
    native: pay.native,
    humanAmount: pay.price,
    label: `Mass DM broadcast — to all Dexvra users`,
    payload: {
      text: s.massForm.text,
      entities: s.massForm.entities,
      mediaFileId: s.massForm.mediaFileId,
      tokenCa: s.massForm.ca,
      tokenChain: s.massForm.chain,
    },
  });
}

async function testSend(ctx) {
  await answer(ctx);
  if (!isAdminUser(ctx)) return toast(ctx, "Admins only.");
  const s = ctx.session;
  if (!s.massForm || s.massForm.text == null) return toast(ctx, tpl.render("session_expired"));
  const composer = String(ctx.from.id);
  const targets = Array.from(new Set([...ADMIN_IDS.map(String), composer])).filter(Boolean);
  let mediaPath = null;
  if (s.massForm.mediaFileId) mediaPath = await downloadMedia(ctx, s.massForm.mediaFileId).catch(() => null);
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

module.exports = { entryMassDm, handleText, handlePhoto, payPick, testSend, refFor, downloadMedia, currencyOf, looksLikeCA };
