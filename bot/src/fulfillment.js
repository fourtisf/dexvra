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
const { tierAnnounces, tierLabel } = require("./config/packages");
const { fmtPrice, formatNumber } = require("./helpers/format");
const { isValidTicker, sanitizeTicker } = require("./helpers/ticker");
const { payloadArgs } = require("./helpers/message");
const premium = require("./premium");
const { chainOf } = require("./config/chains");
const assets = require("./assets");
const bannerRender = require("./bannerRender");
const bannerTemplate = require("./bannerTemplate");
const tokenEmoji = require("./tokenEmoji");
const tpl = require("./templates");
const log = require("./helpers/logger");

// Kinds whose animated clip is an EMPTY token template — the bot composites the token's
// logo + $ticker + name + price/MC onto it (same data as the still artwork). Ad/pump/
// rank-up clips are generic/advertiser media and are sent as-is.
const BANNER_FILL_KINDS = new Set(["listing", "trending"]);

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
    overview: row.overview || null,
    price: live && live.priceUsd,
    mcap: live && live.mcap,
    liq: live && live.liq,
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
async function postMedia(kind, bannerCoin, logoBuffer, logoFileId, logoUrl, badge, opts = {}) {
  // Self-fetch the logo from its URL when no buffer was passed, so background
  // callers (rank-up, pump) get the token logo composited into the artwork too.
  if (!logoBuffer && logoUrl) logoBuffer = await fetchLogoUrl(logoUrl).catch(() => null);
  // Admin-bot toggle (persisted) with POST_BANNERS env as the default.
  if (bannerTemplate.postingEnabled()) {
    // Admin-uploaded GIF/video wins over the composited still.
    const media = bannerTemplate.mediaOverride(kind);
    if (media) {
      // For token banners (listing/trending) the clip is an EMPTY animated template —
      // composite the token's logo + $ticker + name + price/MC onto it, so it matches
      // the still artwork. Any failure falls back to the raw clip. Ad/pump/rank clips
      // (advertiser creative / generic hype) are sent as-is.
      if (BANNER_FILL_KINDS.has(kind)) {
        const filled = await bannerTemplate
          .composeOntoClip(kind, media, logoBuffer, {
            symbol: bannerCoin.symbol,
            name: bannerCoin.name,
            chain: bannerCoin.chain,
            price: bannerCoin.price,
            mcap: bannerCoin.mcap,
            badge,
          })
          .catch(() => null);
        if (filled) {
          log.info(`[fulfil] ${kind} media: admin clip + token overlay ✔`);
          return filled;
        }
        log.warn(`[fulfil] ${kind} media: overlay composite failed — sending clip as-is`);
      }
      // A raw .gif would arrive as a file card over MTProto — convert it so it
      // plays inline, the same as the clips composeOntoClip already produces.
      log.info(`[fulfil] ${kind} media: admin ${media.type} clip ✔`);
      return await bannerTemplate.toInlineClip(media);
    }
    // Rank-up has its OWN dynamic banner (rank medallion + big % gain). It can't
    // be a static composited artwork (the rank/% change every alert), so skip
    // compose() and render it procedurally. Admin GIF/video override still wins.
    if (kind === "rankup") {
      const buf = await bannerRender
        .renderRankUpBanner(bannerCoin, logoBuffer, { rank: opts.rank, change: opts.change })
        .catch(() => null);
      if (buf) {
        log.info(`[fulfil] rankup media: dynamic banner ✔ (#${opts.rank})`);
        return { source: buf };
      }
      log.warn(`[fulfil] rankup media: RAW TOKEN LOGO fallback — renderRankUpBanner returned null (check @napi-rs/canvas)`);
      return photoSource(logoFileId, logoUrl);
    }
    const composed = await bannerTemplate.compose(kind, logoBuffer, {
      symbol: bannerCoin.symbol,
      name: bannerCoin.name,
      chain: bannerCoin.chain,
      price: bannerCoin.price,
      mcap: bannerCoin.mcap,
      badge,
    });
    if (composed) {
      log.info(`[fulfil] ${kind} media: template artwork ✔`);
      return { source: composed };
    }
    const buf =
      kind === "trending"
        ? await bannerRender.renderTrendingBanner(bannerCoin, logoBuffer)
        : await bannerRender.renderListingBanner(bannerCoin, logoBuffer);
    if (buf) {
      log.info(`[fulfil] ${kind} media: dynamic banner (template compose returned null — see [bannerTpl] warnings)`);
      return { source: buf };
    }
    const staticP = kind === "trending" ? assets.trending() : assets.listing();
    if (staticP) {
      log.info(`[fulfil] ${kind} media: static asset (canvas unavailable — run 'npm ci' in bot/)`);
      return { source: staticP };
    }
    log.warn(`[fulfil] ${kind} media: RAW TOKEN LOGO fallback — banner pipeline fully unavailable (check @napi-rs/canvas install + assets/banner-artwork-*.png)`);
  }
  return photoSource(logoFileId, logoUrl);
}

// ── Listing (Xpress + Listing & Trending) ────────────────────────────────────
async function fulfillListing(ctx, order) {
  const p = order.payload; // { listingInput, logoFileId?, trendHours }
  const input = { ...p.listingInput };

  // 0. Last line of defence on the ticker. The buyer has PAID by the time we
  // get here, so a ticker the site would refuse must be REPAIRED, not raised:
  // createListing answering "400: Invalid ticker" leaves the order 'paid' with
  // nothing delivered (incident 2026-07-23). handlers/listing.js is what
  // normally stops this reaching here — a line in the log means one slipped
  // past input validation, so it is worth reading.
  if (!isValidTicker(input.sym)) {
    const fixed = sanitizeTicker(input.sym) || sanitizeTicker(input.name);
    log.warn(`[fulfil] ticker "${input.sym}" would be rejected by the site → using "${fixed || "(none)"}"`);
    if (fixed) input.sym = fixed;
  }

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
  // Animated logo custom-emoji (per-token pack, shown inline in channel posts
  // via GramJS). Best-effort — ensureTokenEmoji never throws.
  await tokenEmoji.ensureTokenEmoji(
    { chain: input.chain, address: input.address, symbol: input.sym },
    logoBuffer,
  );
  const live = await market.fetchMarket(input.chain, input.address).catch(() => null);
  const coin = coinFrom(input, live);
  const bannerCoin = bannerCoinOf(input, live);
  const tierBadge = input.tier === "XPRESS" ? "Xpress Listing" : input.tier ? `${tierLabel(input.tier)} Tier` : null;
  const listMedia = await postMedia("listing", bannerCoin, logoBuffer, p.logoFileId, input.logoUrl, tierBadge);

  // 5 → moved BEFORE the channel posts: tweet first, so the channel post can
  // carry the fourtis-style "Announce On X" link (the line auto-drops when X
  // is off or the tweet failed). The race keeps a hung X API from stalling
  // fulfillment; the tweet id is persisted whenever it eventually lands so a
  // later pump alert can still QUOTE the listing tweet.
  const tweetP = x.postListing(coin, logoBuffer, "image/png").catch(() => null);
  tweetP
    .then((id) => (id ? postids.set(input.chain, input.address, { listingTweetId: id }) : null))
    .catch(() => {});
  const tweetId = await Promise.race([tweetP, new Promise((r) => setTimeout(r, 20000, null))]);
  if (tweetId) coin.xUrl = `https://x.com/i/status/${tweetId}`;

  const links = [];
  try {
    // Every listing PINS itself in the channel it lands in (operator rule,
    // 2026-07-25) — the newest listing is what a visitor should see first.
    // Pinning is silent (disable_notification), and the trending channel is
    // deliberately NOT pinned here: its pin belongs to the Trending board.
    const listingMsg = await post.sendMedia(CHANNELS.listing, listMedia, fmt.listingPost(coin), { pin: true });
    if (listingMsg) links.push({ kind: "listing", label: "🔔 Dexvra Listing", url: tmeLink(CHANNELS.listing, listingMsg.message_id) });
    // The tweet sits right under its channel post, as a raw url like the rest —
    // it is one of the things they bought, not a footnote.
    if (coin.xUrl) links.push({ kind: "x", label: "🔔 Dexvra Listing (X)", url: coin.xUrl });

    const annMsg = tierAnnounces(input.tier)
      ? await post.sendMedia(CHANNELS.announce, listMedia, fmt.listingPost(coin), { pin: true })
      : null;
    if (annMsg) links.push({ kind: "announce", label: "🔔 Dexvra Announcement", url: tmeLink(CHANNELS.announce, annMsg.message_id) });

    if (hours > 0) {
      const trendMedia = await postMedia("trending", bannerCoin, logoBuffer, p.logoFileId, input.logoUrl, `Trending ${hours}H`);
      const trendingMsg = await post.sendMedia(CHANNELS.trending, trendMedia, fmt.trendingPost(coin));
      if (trendingMsg) links.push({ kind: "trending", label: "🔔 Dexvra Trending", url: tmeLink(CHANNELS.trending, trendingMsg.message_id) });
    }
    await postids.set(input.chain, input.address, {
      listingMsgId: listingMsg && listingMsg.message_id,
      annMsgId: annMsg && annMsg.message_id,
    });
  } catch (e) {
    log.warn(`[fulfil] listing channel posts: ${e.message}`);
  }

  // 6. Buyer DM (the tweet was posted before the channel posts above).
  await dm(ctx, successListing(coin, links, { hours }), menu.postPurchase(coin.siteUrl));
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
  // Reuses the pack made at listing time; builds one now if it never existed.
  await tokenEmoji.ensureTokenEmoji(
    { chain: p.chain, address: p.address, symbol: row.sym || row.symbol },
    logoBuffer,
  );
  const trendMedia = await postMedia("trending", bannerCoin, logoBuffer, null, row.logoUrl, `Trending ${p.hours}H`);

  // Tweet first (timeboxed) so the channel post can link it — same pattern as
  // the listing flow; the "Announce On X" line drops when there's no tweet.
  const tweetId = await Promise.race([
    x.postTrending(coin).catch(() => null),
    new Promise((r) => setTimeout(r, 20000, null)),
  ]);
  if (tweetId) coin.xUrl = `https://x.com/i/status/${tweetId}`;

  const links = [];
  try {
    const tMsg = await post.sendMedia(CHANNELS.trending, trendMedia, fmt.trendingPost(coin));
    if (tMsg) links.push({ kind: "trending", label: "🔔 Dexvra Trending", url: tmeLink(CHANNELS.trending, tMsg.message_id) });
    if (p.hours >= 24) {
      const aMsg = await post.sendMedia(CHANNELS.announce, trendMedia, fmt.trendingPost(coin));
      if (aMsg) links.push({ kind: "announce", label: "🔔 Dexvra Announcement", url: tmeLink(CHANNELS.announce, aMsg.message_id) });
    }
  } catch (e) {
    log.warn(`[fulfil] trending posts: ${e.message}`);
  }
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
  // The site may have scheduled the run later than requested (row full) — from
  // here on the BOOKING's window is the truth, never the requested one.
  const run = booking && booking.startsAt ? booking : rec;
  log.info(
    `[fulfil] banner booked ${rec.slot} ${new Date(run.startsAt).toISOString()} → ${new Date(run.endsAt).toISOString()}` +
      (booking && booking.queued ? " (QUEUED — slots were full)" : ""),
  );

  const links = [];
  let bTweetId = null;
  let bXUrl = "";
  try {
    // Frame the creative in the Banner Ads artwork when one is set (admin
    // upload or bundled); otherwise post the raw creative as before.
    let adMedia = p.imageFileId || photoSource(null, rec.imageUrl);
    if (bannerTemplate.postingEnabled()) {
      const creative = buffer || (await fetchLogoUrl(rec.imageUrl));
      const framed = await bannerTemplate.compose("banner", creative, {});
      if (framed) adMedia = { source: framed };
    }
    // Tweet FIRST (timeboxed), so the channel post can carry the "Announce On X"
    // link — same ordering as a listing. The line drops itself when X is off or
    // the tweet failed.
    bTweetId = await Promise.race([
      x.postBanner(rec).catch(() => null),
      new Promise((r) => setTimeout(r, 20000, null)),
    ]);
    bXUrl = bTweetId ? `https://x.com/i/status/${bTweetId}` : "";
    const aMsg = await post.sendMedia(CHANNELS.announce, adMedia, fmt.bannerPost(rec, bXUrl));
    if (aMsg) links.push({ label: "📢 Announcement", url: tmeLink(CHANNELS.announce, aMsg.message_id) });
  } catch (e) {
    log.warn(`[fulfil] banner post: ${e.message}`);
  }
  await dm(ctx, successBanner(run, links, bXUrl, booking && booking.queued), menu.postPurchase(SITE_URL));
  return booking;
}

// ── Buyer success copy (premium markup — rendered to entities by tpl.render) ─
// Post links are shown as RAW visible URLs (https://t.me/dexvralisting/6), not
// hidden behind "open ↗" markup — operator preference from live testing.
function linkLines(links) {
  return (links || []).map((l) => `${l.label}: ${l.url}`).join("\n");
}
// The editable {announceX} placeholder — a clean "Announce on X" link when a
// tweet exists, empty otherwise (collapseGaps drops the blank line).
function announceXLine(xUrl) {
  return xUrl ? `🔔 Dexvra (X): ${xUrl}` : "";
}
/** The buyer's receipt. Xpress and Listing & Trending are different products —
 *  one is a listing, the other adds a ranked tier and a timed Trending run — so
 *  they get separate, separately-editable templates. */
/** The posted-message urls keyed by destination, so each can be its own editable
 *  line in the template. Empty string = that post didn't happen, and
 *  dropEmptyLines removes the line together with its label.
 *
 *  Keyed on an explicit `kind`, never on the label text: "Dexvra Listing" is a
 *  prefix of "Dexvra Listing (X)", so substring matching hands the listing line
 *  the tweet's url — and the label is exactly the thing an operator is free to
 *  reword. */
function linkVars(links) {
  const url = (kind) => {
    const hit = (links || []).find((l) => l.kind === kind);
    return hit ? hit.url : "";
  };
  return { listingUrl: url("listing"), xUrl: url("x"), announceUrl: url("announce"), trendingUrl: url("trending") };
}

function successListing(coin, links, { hours = 0 } = {}) {
  const tiered = coin.tier && String(coin.tier).toUpperCase() !== "XPRESS";
  return tpl.render(
    tiered ? "success_listing_tiered" : "success_listing",
    {
      symbol: premium.sanitizeVar(fmt.sym(coin.symbol)),
      name: premium.sanitizeVar(coin.name),
      tier: coin.tier ? premium.sanitizeVar(tierLabel(coin.tier)) : "",
      tierEmoji: coin.tier ? fmt.tierBadge(String(coin.tier).toUpperCase()) : "",
      hours,
      siteUrl: coin.siteUrl,
      ...linkVars(links),
      postLinks: linkLines(links), // legacy shape, for templates saved before the split
      announceX: "", // the tweet has its own line now — never print it twice
      ...fmt.channelLinks(), // {site}/{listing}/{trending}/{announce} stay available
    },
    // A destination with no post drops its whole line, label included.
    { dropEmpty: true },
  );
}
function successTrending(coin, hours, links) {
  return tpl.render(
    "success_trending",
    {
      symbol: premium.sanitizeVar(fmt.sym(coin.symbol)),
      hours,
      siteUrl: coin.siteUrl,
      ...linkVars(links),
      xUrl: coin.xUrl || "",
      postLinks: linkLines(links),
      announceX: "",
      ...fmt.channelLinks(),
    },
    { dropEmpty: true },
  );
}
// Buyer-facing timestamp: "30 Jul 2026, 12:00 UTC". Always UTC — the buyer and
// the server are rarely in the same timezone, so a local time would be wrong for
// one of them. Built field by field rather than from toUTCString(), which labels
// the same instant "GMT"; Dexvra says UTC everywhere and one vocabulary is worth
// the six lines. Seconds are dropped — noise on an ad run measured in days.
const UTC_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function utcStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${UTC_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
// {startsAt}/{endsAt} describe the run the site actually scheduled. {queueNote}
// is the honest line for a sale made while every slot was taken — the order went
// through, the banner just starts later. Empty (and collapsed away) otherwise.
//
// The note repeats the start time INSIDE itself rather than pointing at the line
// above: this is the one message a queued buyer has to understand, they may skim
// it, and "booked on the homepage" must never be read as "already on screen".
// The announcement post is NOT held back for a queued run (operator's call), so
// the note also says so — a buyer who sees their @dexvraio post go out the same
// minute would otherwise expect the banner to be live too.
function successBanner(run, links, xUrl, queued) {
  const when = utcStamp;
  return tpl.render("success_banner", {
    slot: premium.sanitizeVar(run.slot),
    startsAt: when(run.startsAt),
    endsAt: when(run.endsAt),
    queueNote: queued
      ? "⏳ **Not live yet — every banner slot is taken right now.** Your run is reserved: it goes live " +
        `automatically on **${when(run.startsAt)}** and runs the full time you paid for — nothing else to do. ` +
        "Your announcement post is going out now."
      : "",
    postLinks: linkLines(links),
    announceX: announceXLine(xUrl),
    ...fmt.channelLinks(),
  });
}

// ── Paid Mass DM ──────────────────────────────────────────────────────────
// Funds are already swept before fulfilment, so this must NEVER throw: it only
// PERSISTS a pending_review job and notifies the review chat. A failed enqueue
// tells the buyer to contact support — it never bubbles up to abort the order.
async function fulfillMassDm(ctx, order) {
  const massStore = require("./massdm/store");
  const { MASS_DM_REVIEW_CHAT_ID } = require("./config/constants");
  const p = order.payload; // { text, entities, mediaFileId }
  const ref = require("./handlers/massdm").refFor();
  try {
    let mediaPath = null;
    if (p.mediaFileId) {
      const buf = await downloadFile(ctx.telegram, p.mediaFileId);
      if (buf) {
        const os = require("node:os");
        const path = require("node:path");
        const fs = require("node:fs");
        const dir = path.join(os.tmpdir(), "dexvra-massdm");
        fs.mkdirSync(dir, { recursive: true });
        mediaPath = path.join(dir, `${order.id}.jpg`);
        fs.writeFileSync(mediaPath, buf);
      }
    }
    const job = await massStore.createJob({
      text: p.text || "",
      entities: p.entities || [],
      mediaPath,
      createdBy: order.buyerId,
      createdByUsername: order.buyerUsername || null,
      targets: massStore.audience(),
      test: false, // paid job → pending_review
      reportChatId: MASS_DM_REVIEW_CHAT_ID || null,
      ref,
    });
    log.info(`[fulfil] mass DM job ${job.id} queued for review (ref ${ref}, ${job.total} audience)`);
    // Notify the review chat so an admin can approve.
    if (MASS_DM_REVIEW_CHAT_ID) {
      await ctx.telegram
        .sendMessage(MASS_DM_REVIEW_CHAT_ID, `🕵️ New paid Mass DM awaiting review — ref <code>${ref}</code>. Use /reviewmassdm in @dexvraadminbot.`, { parse_mode: "HTML" })
        .catch(() => {});
    }
    await dm(ctx, tpl.render("massdm_received", { ref }), menu.postPurchase());
  } catch (e) {
    log.error(`[fulfil] mass DM enqueue FAILED (paid, ref ${ref}): ${e.message}`);
    await dm(ctx, tpl.render("massdm_enqueue_failed", { ref }), menu.postPurchase()).catch(() => {});
  }
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
    case "mass_dm":
      return fulfillMassDm(ctx, order);
    default:
      throw new Error(`unknown order kind: ${order.kind}`);
  }
}

module.exports = {
  fulfillOrder,
  fulfillListing,
  fulfillTrending,
  fulfillBanner,
  fulfillMassDm,
  postMedia,
  _successBanner: successBanner, // buyer copy — tested directly (see banner.test.js)
};
