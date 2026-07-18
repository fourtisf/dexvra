// Central fulfilment — runs AFTER payment clears (from confirmPayHandler, and
// re-runnable by restart recovery). Everything here is best-effort past the
// store write: funds are already captured, so a failed post/tweet/DM must never
// throw the whole order back. The one hard step is the store write (create
// listing / book trending / book banner); if THAT throws, the order stays
// 'paid' for recovery.
const api = require("./api/dexvra");
const post = require("./channels/post");
const fmt = require("./channels/format");
const postids = require("./channels/postids");
const market = require("./marketdata");
const x = require("./twitter");
const menu = require("./handlers/menu");
const { SITE_URL, CHANNELS } = require("./config/constants");
const { tierAnnounces } = require("./config/packages");
const { escapeHtml } = require("./helpers/format");
const tpl = require("./templates");
const log = require("./helpers/logger");

/** Public t.me link to a specific post in a @username channel. */
function tmeLink(channel, msgId) {
  return `https://t.me/${String(channel).replace(/^@/, "")}/${msgId}`;
}

async function downloadFile(telegram, fileId) {
  try {
    const link = await telegram.getFileLink(fileId);
    const res = await fetch(link.href || String(link), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    log.debug(`[fulfil] file download: ${e.message}`);
    return null;
  }
}

async function dm(ctx, text, keyboard) {
  const extra = { parse_mode: "HTML", disable_web_page_preview: true, ...(keyboard || {}) };
  try {
    if (typeof ctx.reply === "function") return await ctx.reply(text, extra);
    return await ctx.telegram.sendMessage(ctx.from.id, text, extra);
  } catch (e) {
    log.debug(`[fulfil] DM buyer: ${e.message}`);
    return null;
  }
}

/** Public photo source for a channel post: the Telegram file_id (best) else a
 *  publicly reachable logo URL (never the internal localhost media URL). */
function photoSource(logoFileId, logoUrl) {
  if (logoFileId) return logoFileId;
  if (!logoUrl) return null;
  if (logoUrl.startsWith("http")) return logoUrl;
  return `${SITE_URL}${logoUrl}`; // /api/media/... → public dexvra.io URL
}

function coinFrom(row, live) {
  return {
    name: row.name,
    symbol: row.sym || row.symbol,
    chain: row.chain,
    address: row.address,
    tier: row.tier,
    price: live && live.priceUsd,
    mcap: live && live.mcap,
    links: { website: row.website, twitter: row.twitter, telegram: row.telegram },
    siteUrl: `${SITE_URL}/token/${row.chain}/${row.address}`,
  };
}

// ── Listing (Xpress + Listing & Trending) ────────────────────────────────────
async function fulfillListing(ctx, order) {
  const p = order.payload; // { listingInput, logoFileId?, trendHours }
  const input = { ...p.listingInput };

  // 1. Logo (best-effort): upload the Telegram photo to dexvra media.
  let logoBuffer = null;
  if (p.logoFileId) {
    logoBuffer = await downloadFile(ctx.telegram, p.logoFileId);
    if (logoBuffer) {
      try {
        const url = await api.uploadImage(logoBuffer, "logo.png", "image/png");
        if (url) input.logoUrl = url; // relative /api/media/... (renders on the site)
      } catch (e) {
        log.warn(`[fulfil] logo upload failed — listing without logo: ${e.message}`);
      }
    }
  }

  // 2. Bundled Trending feature (all listing purchases feature for tier hours).
  const hours = p.trendHours || 0;
  if (hours > 0) {
    const now = Date.now();
    input.trendingRank = 1;
    input.trendStart = now;
    input.trendExp = now + hours * 3_600_000;
  }

  // 3. Create the approved listing (hard step).
  const listing = await api.createListing(input);
  log.info(`[fulfil] listing ${listing && listing.id} live: ${input.chain}/${input.address}`);

  // 4. Channel posts (best-effort).
  const live = await market.fetchMarket(input.chain, input.address).catch(() => null);
  const coin = coinFrom(input, live);
  const photo = photoSource(p.logoFileId, input.logoUrl);
  const links = [];
  try {
    const listingMsg = await post.sendPhoto(CHANNELS.listing, photo, fmt.listingPost(coin));
    if (listingMsg) links.push({ label: "🚨 Listing post", url: tmeLink(CHANNELS.listing, listingMsg.message_id) });

    const annMsg = tierAnnounces(input.tier)
      ? await post.sendPhoto(CHANNELS.announce, photo, fmt.listingPost(coin))
      : null;
    if (annMsg) links.push({ label: "📢 Announcement", url: tmeLink(CHANNELS.announce, annMsg.message_id) });

    if (hours > 0) {
      const trendingMsg = await post.sendPhoto(CHANNELS.trending, photo, fmt.trendingPost(coin));
      if (trendingMsg) links.push({ label: "🔥 Trending", url: tmeLink(CHANNELS.trending, trendingMsg.message_id) });
    }
    await postids.set(input.chain, input.address, {
      listingMsgId: listingMsg && listingMsg.message_id,
      annMsgId: annMsg && annMsg.message_id,
    });
  } catch (e) {
    log.warn(`[fulfil] listing channel posts: ${e.message}`);
  }

  // 5. Tweet + 6. Buyer DM.
  x.postListing(coin, logoBuffer, "image/png").catch(() => {});
  await dm(ctx, successListing(coin, links), menu.postPurchase(coin.siteUrl));
}

// ── Trending (standalone slot on an already-listed token) ────────────────────
async function fulfillTrending(ctx, order) {
  const p = order.payload; // { chain, address, hours }
  const listing = await api.bookTrending(p.chain, p.address, p.hours); // hard step
  log.info(`[fulfil] trending booked ${p.chain}/${p.address} ${p.hours}h`);

  const live = await market.fetchMarket(p.chain, p.address).catch(() => null);
  const coin = coinFrom(listing || { chain: p.chain, address: p.address, sym: p.symbol, name: p.name }, live);
  const photo = photoSource(null, listing && listing.logoUrl);
  const links = [];
  try {
    const tMsg = await post.sendPhoto(CHANNELS.trending, photo, fmt.trendingPost(coin));
    if (tMsg) links.push({ label: "🔥 Trending", url: tmeLink(CHANNELS.trending, tMsg.message_id) });
    if (p.hours >= 24) {
      const aMsg = await post.sendPhoto(CHANNELS.announce, photo, fmt.trendingPost(coin));
      if (aMsg) links.push({ label: "📢 Announcement", url: tmeLink(CHANNELS.announce, aMsg.message_id) });
    }
  } catch (e) {
    log.warn(`[fulfil] trending posts: ${e.message}`);
  }
  x.postTrending(coin).catch(() => {});
  await dm(ctx, successTrending(coin, p.hours, links), menu.postPurchase(coin.siteUrl));
}

// ── Banner ad ────────────────────────────────────────────────────────────────
async function fulfillBanner(ctx, order) {
  const p = order.payload; // { rec, imageFileId, hours }
  const now = Date.now();
  const rec = { ...p.rec, startsAt: now, endsAt: now + (p.hours || 24) * 3_600_000 };

  // Upload the creative — a banner with no image has nothing to show, so this is
  // a hard step (failure leaves the order 'paid' for recovery, not silently lost).
  let buffer = null;
  if (p.imageFileId) buffer = await downloadFile(ctx.telegram, p.imageFileId);
  if (buffer && !rec.imageUrl) {
    try {
      const url = await api.uploadImage(buffer, "banner.png", "image/png");
      if (url) rec.imageUrl = url;
    } catch (e) {
      log.warn(`[fulfil] banner creative upload: ${e.message}`);
    }
  }
  if (!rec.imageUrl) throw new Error("banner creative missing (upload failed)");
  const booking = await api.bookBanner(rec); // hard step
  log.info(`[fulfil] banner booked ${rec.slot} until ${new Date(rec.endsAt).toISOString()}`);

  const links = [];
  try {
    const aMsg = await post.sendPhoto(CHANNELS.announce, p.imageFileId || photoSource(null, rec.imageUrl), fmt.bannerPost(rec));
    if (aMsg) links.push({ label: "📢 Announcement", url: tmeLink(CHANNELS.announce, aMsg.message_id) });
  } catch (e) {
    log.warn(`[fulfil] banner post: ${e.message}`);
  }
  x.postBanner(rec).catch(() => {});
  await dm(ctx, successBanner(rec, links), menu.postPurchase(SITE_URL));
  return booking;
}

// ── Buyer success copy ───────────────────────────────────────────────────────
function linkLines(links) {
  return (links || []).map((l) => `${l.label}: <a href="${l.url}">open ↗</a>`).join("\n");
}
function successListing(coin, links) {
  return tpl.t("success_listing", {
    symbol: fmt.sym(coin.symbol),
    name: escapeHtml(coin.name),
    siteUrl: coin.siteUrl,
    postLinks: linkLines(links),
  });
}
function successTrending(coin, hours, links) {
  return tpl.t("success_trending", {
    symbol: fmt.sym(coin.symbol),
    hours,
    siteUrl: coin.siteUrl,
    postLinks: linkLines(links),
  });
}
function successBanner(rec, links) {
  return tpl.t("success_banner", {
    slot: escapeHtml(rec.slot),
    endsAt: new Date(rec.endsAt).toUTCString(),
    postLinks: linkLines(links),
  });
}

async function fulfillOrder(ctx, order) {
  switch (order.kind) {
    case "xpress_listing":
    case "tiered_listing":
      return fulfillListing(ctx, order);
    case "trending":
      return fulfillTrending(ctx, order);
    case "banner":
      return fulfillBanner(ctx, order);
    default:
      throw new Error(`unknown order kind: ${order.kind}`);
  }
}

module.exports = { fulfillOrder, fulfillListing, fulfillTrending, fulfillBanner };
