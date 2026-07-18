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
const log = require("./helpers/logger");

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
  try {
    const listingMsg = await post.sendPhoto(CHANNELS.listing, photo, fmt.listingPost(coin));
    const annMsg = tierAnnounces(input.tier)
      ? await post.sendPhoto(CHANNELS.announce, photo, fmt.listingPost(coin))
      : null;
    if (hours > 0) await post.sendPhoto(CHANNELS.trending, photo, fmt.trendingPost(coin));
    await postids.set(input.chain, input.address, {
      listingMsgId: listingMsg && listingMsg.message_id,
      annMsgId: annMsg && annMsg.message_id,
    });
  } catch (e) {
    log.warn(`[fulfil] listing channel posts: ${e.message}`);
  }

  // 5. Tweet + 6. Buyer DM.
  x.postListing(coin, logoBuffer, "image/png").catch(() => {});
  await dm(ctx, successListing(coin), menu.postPurchase(coin.siteUrl));
}

// ── Trending (standalone slot on an already-listed token) ────────────────────
async function fulfillTrending(ctx, order) {
  const p = order.payload; // { chain, address, hours }
  const listing = await api.bookTrending(p.chain, p.address, p.hours); // hard step
  log.info(`[fulfil] trending booked ${p.chain}/${p.address} ${p.hours}h`);

  const live = await market.fetchMarket(p.chain, p.address).catch(() => null);
  const coin = coinFrom(listing || { chain: p.chain, address: p.address, sym: p.symbol, name: p.name }, live);
  const photo = photoSource(null, listing && listing.logoUrl);
  try {
    await post.sendPhoto(CHANNELS.trending, photo, fmt.trendingPost(coin));
    if (p.hours >= 24) await post.sendPhoto(CHANNELS.announce, photo, fmt.trendingPost(coin));
  } catch (e) {
    log.warn(`[fulfil] trending posts: ${e.message}`);
  }
  x.postTrending(coin).catch(() => {});
  await dm(ctx, successTrending(coin, p.hours), menu.postPurchase(coin.siteUrl));
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

  try {
    await post.sendPhoto(CHANNELS.announce, p.imageFileId || photoSource(null, rec.imageUrl), fmt.bannerPost(rec));
  } catch (e) {
    log.warn(`[fulfil] banner post: ${e.message}`);
  }
  x.postBanner(rec).catch(() => {});
  await dm(ctx, successBanner(rec), menu.postPurchase(SITE_URL));
  return booking;
}

// ── Buyer success copy ───────────────────────────────────────────────────────
function successListing(coin) {
  return (
    `✅ <b>Your token is LIVE on Dexvra!</b>\n\n` +
    `<b>${fmt.sym(coin.symbol)}</b> — ${coin.name}\n` +
    `🌐 <a href="${coin.siteUrl}">View your listing</a>\n` +
    `🚨 Posted to the Listing channel${tierAnnounces(coin.tier) ? " + Announcements" : ""} and Trending.\n\n` +
    `Thanks for listing with Dexvra! 🚀`
  );
}
function successTrending(coin, hours) {
  return (
    `✅ <b>Trending slot activated!</b>\n\n` +
    `<b>${fmt.sym(coin.symbol)}</b> is now featured on Dexvra Trending for <b>${hours}h</b>.\n` +
    `🔥 <a href="${coin.siteUrl}">View on Dexvra</a>`
  );
}
function successBanner(rec) {
  return (
    `✅ <b>Banner ad booked!</b>\n\n` +
    `Your <b>${rec.slot}</b> is now running on Dexvra until ` +
    `${new Date(rec.endsAt).toUTCString()}.\n📢 Posted to the announcement channel.`
  );
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
