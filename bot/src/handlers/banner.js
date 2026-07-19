// Banner Ads flow: pick a banner type → duration → upload the creative → link →
// (optional) title → choose a pay currency (USD price converted to native) → pay.
const { answer, toast, sendCard, getMediaFileId } = require("../helpers/message");
const { nativeOf } = require("../config/chains");
const { BANNERS, bannerByKey } = require("../config/packages");
const { escapeHtml } = require("../helpers/format");
const { usdToNative } = require("../nativeprice");
const { startPayment } = require("./pay");
const menu = require("./menu");
const { Markup } = menu;

const URL_RE = /^https?:\/\/\S+$/i;
// Pay currencies offered for USD-priced banners (one per native coin).
const PAY_CHAINS = ["solana", "bsc", "ethereum", "tron", "ton"];

function freshSession(ctx, patch) {
  const prev = ctx.session && ctx.session.latest_bot_message;
  ctx.session = { latest_bot_message: prev, ...patch };
}

async function entryBanner(ctx) {
  await answer(ctx);
  if (ctx.chat && ctx.chat.type !== "private") return;
  freshSession(ctx, { type: "banner", bannerForm: {} });
  const rows = BANNERS.map((b) => [Markup.button.callback(`${b.name} (${b.size})`, `bt_${b.key}`)]);
  const tpl = require("../templates");
  await sendCard(ctx, tpl.render("intro_banner"), menu.withHome(rows));
}

async function typePick(ctx) {
  await answer(ctx);
  const key = ctx.match[1];
  const pack = bannerByKey(key);
  if (!pack) return toast(ctx, "Unknown banner type.");
  ctx.session.bannerForm = { key, name: pack.name, size: pack.size, slot: pack.name };
  const rows = pack.rows.map((r, i) => [
    Markup.button.callback(`${r.duration} · $${r.usd}${r.discount ? ` (-${r.discount}%)` : ""}`, `bd_${i}`),
  ]);
  const tpl = require("../templates");
  await sendCard(ctx, tpl.render("banner_duration_prompt", { name: pack.name, size: pack.size }), menu.withHome(rows));
}

async function durationPick(ctx) {
  await answer(ctx);
  const bf = ctx.session.bannerForm;
  if (!bf || !bf.key) return toast(ctx, require("../templates").render("session_expired"));
  const pack = bannerByKey(bf.key);
  const row = pack.rows[Number(ctx.match[1])];
  if (!row) return toast(ctx, "Invalid duration.");
  bf.hours = row.hours;
  bf.usd = row.usd;
  bf.duration = row.duration;
  ctx.session.awaitingField = "banner_image";
  await sendCard(ctx, require("../templates").render("banner_image_prompt", { size: bf.size }), menu.withHome([]));
}

async function handlePhoto(ctx) {
  const s = ctx.session;
  if (!s.bannerForm || s.awaitingField !== "banner_image") return;
  const id = getMediaFileId(ctx);
  if (!id) return toast(ctx, "I couldn't read that image — send it as a photo.");
  s.bannerForm.imageFileId = id;
  s.awaitingField = "banner_link";
  await sendCard(ctx, require("../templates").render("banner_link_prompt"), menu.withHome([]));
}

async function handleText(ctx) {
  const s = ctx.session;
  const bf = s.bannerForm;
  if (!bf) return;
  const input = (ctx.message.text || "").trim();

  if (s.awaitingField === "banner_link") {
    if (!URL_RE.test(input)) return toast(ctx, require("../templates").render("invalid_url"));
    bf.linkUrl = input;
    s.awaitingField = "banner_title";
    return sendCard(ctx, require("../templates").render("banner_title_prompt"), menu.withHome([]));
  }
  if (s.awaitingField === "banner_title") {
    bf.title = input === "/skip" ? null : input.slice(0, 60);
    s.awaitingField = null;
    return showPayMethods(ctx);
  }
}

async function showPayMethods(ctx) {
  const bf = ctx.session.bannerForm;
  bf.pay = {};
  const rows = [];
  for (const chain of PAY_CHAINS) {
    const q = await usdToNative(chain, bf.usd).catch(() => null);
    if (!q) continue;
    bf.pay[chain] = q;
    rows.push([Markup.button.callback(`${q.human} ${q.native}`, `bpay_${chain}`)]);
  }
  if (!rows.length) {
    return sendCard(ctx, require("../templates").render("price_feed_down"), menu.withHome([]));
  }
  await sendCard(
    ctx,
    require("../templates").render("banner_pay_prompt", { slot: bf.slot, duration: bf.duration, usd: bf.usd }),
    menu.withHome(rows),
  );
}

async function payPick(ctx) {
  await answer(ctx);
  const bf = ctx.session && ctx.session.bannerForm;
  if (!bf || !bf.pay) return toast(ctx, require("../templates").render("session_expired"));
  const chain = ctx.match[1];
  const q = bf.pay[chain];
  if (!q) return toast(ctx, "That currency isn't available — pick another.");
  await startPayment(ctx, {
    kind: "banner",
    chain,
    native: nativeOf(chain),
    humanAmount: q.human,
    label: `Banner · ${bf.slot} · ${bf.duration}`,
    payload: {
      rec: { slot: bf.slot, size: bf.size, linkUrl: bf.linkUrl, title: bf.title || undefined },
      imageFileId: bf.imageFileId,
      hours: bf.hours,
    },
  });
}

// yesNo kept for compatibility with the registry (banner links are optional via
// /skip in the text step, so this is a no-op unless wired to a future step).
async function yesNo(ctx) {
  await answer(ctx);
}

module.exports = { entryBanner, typePick, durationPick, payPick, yesNo, handleText, handlePhoto };
