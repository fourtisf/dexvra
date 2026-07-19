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
const { SITE_URL, CHANNELS, POST_BANNERS } = require("./config/constants");
const { tierAnnounces } = require("./config/packages");
const { fmtPrice, formatNumber } = require("./helpers/format");
const { payloadArgs } = require("./helpers/message");
const premium = require("./premium");
const { chainOf } = require("./config/chains");
const assets = require("./assets");
const bannerRender = require("./bannerRender");
const bannerTemplate = require("./bannerTemplate");
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

async function dm(ctx, payload, keyboard) {
  const { text, extra: base } = payloadArgs(payload, false);
  const extra = { ...base, ...(keyboard || {}) };
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

/** Fetch a token logo into a Buffer for the banner renderer (URL case). */
async function fetchLogoUrl(logoUrl) {
  if (!logoUrl) return null;
  const url = logoUrl.startsWith("http") ? logoUrl : `${SITE_URL}${logoUrl}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

/** Values the dynamic banner renderer needs. */
function bannerCoinOf(row, live) {
  return {
    symbol: row.sym || row.symbol,
    name: row.name,
    chain: String(chainOf(row.chain) ? chainOf(row.chain).label : row.chain).toUpperCase(),
    price: live && live.priceUsd ? fmtPrice(live.priceUsd) : "TBA",
    mcap: live && live.mcap ? "$" + formatNumber(live.mcap) : null,
    links: { website: row.website, twitter: row.twitter, telegram: row.telegram },
  };
}

/** Post media, best first: admin-uploaded template ARTWORK (fourtis-style,
 *  logo composited into the design) → dynamic per-token banner → static
 *  banner → token logo. */
async function postMedia(kind, bannerCoin, logoBuffer, logoFileId, logoUrl) {
  if (POST_BANNERS) {
    const composed = await bannerTemplate.compose(kind, logoBuffer, {
      symbol: bannerCoin.symbol,
      name: bannerCoin.name,
    });
    if (composed) return { source: composed };
    const buf =
      kind === "trending"
        ? await bannerRender.renderTrendingBanner(bannerCoin, logoBuffer)
        : await bannerRender.renderListingBanner(bannerCoin, logoBuffer);
    if (buf) return { source: buf };
    const staticP = kind === "trending" ? assets.trending() : assets.listing();
    if (staticP) return { source: staticP };
  }
  return photoSource(logoFileId, logoUrl);
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

  // 4. Channel posts (best-effort) — dynamic per-token banners.
  if (!logoBuffer && input.logoUrl) logoBuffer = await fetchLogoUrl(input.logoUrl);
  const live = await market.fetchMarket(input.chain, input.address).catch(() => null);
  const coin = coinFrom(input, live);
  const bannerCoin = bannerCoinOf(input, live);
  const listMedia = await postMedia("listing", bannerCoin, logoBuffer, p.logoFileId, input.logoUrl);
  const links = [];
  try {
    const listingMsg = await post.sendPhoto(CHANNELS.listing, listMedia, fmt.listingPost(coin));
    if (listingMsg) links.push({ label: "🚨 Listing post", url: tmeLink(CHANNELS.listing, listingMsg.message_id) });

    const annMsg = tierAnnounces(input.tier)
      ? await post.sendPhoto(CHANNELS.announce, listMedia, fmt.listingPost(coin))
      : null;
    if (annMsg) links.push({ label: "📢 Announcement", url: tmeLink(CHANNELS.announce, annMsg.message_id) });

    if (hours > 0) {
      const trendMedia = await postMedia("trending", bannerCoin, logoBuffer, p.logoFileId, input.logoUrl);
      const trendingMsg = await post.sendPhoto(CHANNELS.trending, trendMedia, fmt.trendingPost(coin));
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
  const row = listing || { chain: p.chain, address: p.address, sym: p.symbol, name: p.name };
  const coin = coinFrom(row, live);
  const bannerCoin = bannerCoinOf(row, live);
  const logoBuffer = await fetchLogoUrl(row.logoUrl);
  const trendMedia = await postMedia("trending", bannerCoin, logoBuffer, null, row.logoUrl);
  const links = [];
  try {
    const tMsg = await post.sendPhoto(CHANNELS.trending, trendMedia, fmt.trendingPost(coin));
    if (tMsg) links.push({ label: "🔥 Trending", url: tmeLink(CHANNELS.trending, tMsg.message_id) });
    if (p.hours >= 24) {
      const aMsg = await post.sendPhoto(CHANNELS.announce, trendMedia, fmt.trendingPost(coin));
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

// ── Buyer success copy (premium markup — rendered to entities by tpl.render) ─
function linkLines(links) {
  return (links || []).map((l) => `${l.label}: [open ↗](${l.url})`).join("\n");
}
function successListing(coin, links) {
  return tpl.render("success_listing", {
    symbol: premium.sanitizeVar(fmt.sym(coin.symbol)),
    name: premium.sanitizeVar(coin.name),
    siteUrl: coin.siteUrl,
    postLinks: linkLines(links),
  });
}
function successTrending(coin, hours, links) {
  return tpl.render("success_trending", {
    symbol: premium.sanitizeVar(fmt.sym(coin.symbol)),
    hours,
    siteUrl: coin.siteUrl,
    postLinks: linkLines(links),
  });
}
function successBanner(rec, links) {
  return tpl.render("success_banner", {
    slot: premium.sanitizeVar(rec.slot),
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
