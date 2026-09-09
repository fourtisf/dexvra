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
const { SITE_URL, DEXVRA_API_BASE, CHANNELS, X_POST_TIMEOUT_MS,
  EMOJI_BUDGET_MS,
  CLIP_BUDGET_MS,
  MARKET_BUDGET_MS, X_TRENDING_ENABLED } = require("./config/constants");
const { tierAnnounces, tierLabel } = require("./config/packages");
const { fmtPrice, formatNumber } = require("./helpers/format");
const { isValidTicker, sanitizeTicker } = require("./helpers/ticker");
const { payloadArgs } = require("./helpers/message");
const premium = require("./premium");
const { chainOf } = require("./config/chains");
const assets = require("./assets");
const bannerRender = require("./bannerRender");
const bannerTemplate = require("./bannerTemplate");
const { bounded } = require("./helpers/bounded");
const tokenEmoji = require("./tokenEmoji");
const tpl = require("./templates");
const postFigures = require("./postFigures");
const log = require("./helpers/logger");

// Kinds whose animated clip is an EMPTY token template — the bot composites the token's
// logo + $ticker + name + price/MC onto it (same data as the still artwork). Ad/pump/
// rank-up clips are generic/advertiser media and are sent as-is.
const BANNER_FILL_KINDS = new Set(["listing", "trending"]);

/**
 * How a channel post reads the market — DEXSCREENER FIRST.
 *
 * ⚠️ "Market cap: TBA · Price: TBA" WENT OUT TO 12,528 SUBSCRIBERS over a token
 * the site was pricing at $0.001004 on a $950.2K cap in the same minute. Nothing
 * was down: `fetchMarket` is GT-FIRST, `fetchGT` waits on
 * `gtSlot(PRIO_BACKGROUND)` — the shared GeckoTerminal queue, which has NO
 * DEADLINE OF ITS OWN and sits behind every timer job on the box at 5 releases a
 * minute — and the MARKET_BUDGET_MS bound below then fired with DexScreener
 * NEVER ASKED. The listing form paid for this exact shape one module over
 * ("bot tidak merespon untuk paket listing setelah di minta drop ca"); a paid
 * announcement is the same defect on the surface a customer screenshots.
 *
 * The post renders exactly three market figures — price, market cap and
 * liquidity (`coinVars` in channels/format.js) — and DexScreener publishes all
 * three for free, off a per-IP budget nothing else here competes for. So this
 * is the CHEAP read: `need` names the fields, DexScreener answers only when it
 * has all of them, and anything short of that falls through to GeckoTerminal
 * exactly as before with its answer REUSED rather than re-asked.
 *
 * It is an ORDER, never a second reader — same two sources, same merge, one
 * different sequence. A third private idea of "is GeckoTerminal up" is what
 * this repo keeps paying for.
 */
const POST_MARKET = { cheap: true, need: ["priceUsd", "mcap", "liq"] };

/**
 * The post's market read, bounded — AND THE REASON IT COULD NOT ANSWER.
 *
 * Two call sites read this (a listing and a trending slot) and both had their
 * own copy, which is how the listing half of a rule ends up fixed and the
 * trending half does not. It exists mainly for the `why`: `fetchMarket`
 * collapses "the sources refused us" and "this token has no pool" into one
 * `null`, and the bound above it collapses "the queue was long" into the same
 * one again — so without capturing it here, the watch below could only ever
 * report that a figure was missing and never which of the three silences it
 * was. That distinction is the whole diagnosis.
 */
async function readPostMarket(chain, address, label) {
  let why = null;
  const live = await bounded(
    market.fetchMarket(chain, address, POST_MARKET).catch((e) => {
      why = `the market read threw (${e.message})`;
      return null;
    }),
    MARKET_BUDGET_MS,
    () => {
      why = `the market read passed ${MARKET_BUDGET_MS}ms — the shared GeckoTerminal queue`;
      log.warn(`[fulfil] market read passed ${MARKET_BUDGET_MS}ms (GT queue) — ${label} without live price/mcap`);
      return null;
    },
  );
  return { live, why };
}

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
  // ⚠️ TELEGRAM FETCHES THIS URL ITSELF, so it gets the same gateway failover
  // and the same allowlist the site gives a browser — and the PUBLIC origin,
  // not DEXVRA_API_BASE, because localhost:3005 is not a place Telegram can
  // reach. Handing it a bare ipfs.io url is the defect above on the one path
  // where the fallback is no picture at all.
  if (logoUrl.startsWith("http")) return proxiedLogo(SITE_URL, logoUrl);
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

/**
 * A token logo as bytes, THROUGH THE SITE'S OWN IMAGE PROXY.
 *
 * ⚠️ THE BANNER DREW THE DEXVRA DIAMOND OVER A TOKEN WHOSE ARTWORK WE HAD.
 * This used to `fetch(logoUrl)` raw, and a Pons launch pins its picture on
 * IPFS: `ponsChain.httpsLogo` rewrites `ipfs://<cid>` to ONE hardcoded gateway
 * (`PONS_IPFS_GATEWAY`, ipfs.io), so a gateway that has not pinned that CID
 * answers 404, this returned null, and the fallback artwork shipped to 12,523
 * subscribers — silently, because the `catch` said nothing at all.
 *
 * That is this repo's oldest rule ("never one hardcoded host") and its most
 * expensive one ("a guard is only honest while it measures the stack the
 * caller actually uses") in the same three lines. `/api/logo` is the ONE owner
 * of "can this url be rendered": it extracts the CID and FAILS OVER across
 * `IPFS_GATEWAYS` (a CID is the hash of the bytes, so a 404 is a fact about the
 * gateway and not about the artwork), it re-checks every redirect hop, it
 * refuses a 200 carrying HTML, and it carries the hotlink allowlist. Going
 * around it meant the site could draw a logo the channel could not — and
 * fixing the gateway list for the website, which this repo has already done,
 * bought the banners nothing.
 *
 * It is asked over `DEXVRA_API_BASE` (localhost) because WE are the one
 * fetching: same box, no public round trip. `photoSource` needs the public
 * origin instead, because Telegram fetches that one.
 */
function proxiedLogo(base, logoUrl) {
  return `${base}/api/logo?u=${encodeURIComponent(logoUrl)}`;
}

async function fetchLogoUrl(logoUrl) {
  if (!logoUrl) return null;
  // An upload is our own file on our own disk — nothing to fail over to, and
  // no third-party host to vouch for.
  if (!logoUrl.startsWith("http")) return (await readImage(`${SITE_URL}${logoUrl}`)).bytes;

  const viaProxy = await readImage(proxiedLogo(DEXVRA_API_BASE, logoUrl));
  if (viaProxy.bytes) return viaProxy.bytes;
  // ⚠️ A REFUSAL BY THE PROXY IS AN ANSWER AND IS NOT RETRIED DIRECTLY: it
  // means neither the site nor this banner may render that url, and drawing it
  // here would put a picture in the channel that the token's own page cannot
  // show. Only the proxy being UNREACHABLE falls through — a web app mid-deploy
  // must not cost every listing its artwork, and a direct read is exactly what
  // this function did before.
  //
  // `reached` travels back with the bytes rather than living in a module-level
  // flag: several logos are fetched concurrently here (a listing and its
  // trending slot), and a shared "was the proxy up" variable would be read by
  // whichever call happened to look after somebody else's write.
  const direct = viaProxy.reached ? { bytes: null } : await readImage(logoUrl);
  if (!direct.bytes) {
    // Never silent again. "The project gave us no logo" and "we could not fetch
    // the one they gave us" are different facts, and the banner renders them
    // identically — as the Dexvra mark.
    log.warn(`[fulfil] logo unusable, banner falls back to the Dexvra mark: ${logoUrl}`);
  }
  return direct.bytes;
}

/** `{bytes, reached}` — `reached` is whether the HOST answered at all, which is
 *  a different fact from whether it gave us an image. */
async function readImage(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return { bytes: null, reached: true };
    return { bytes: Buffer.from(await r.arrayBuffer()), reached: true };
  } catch {
    return { bytes: null, reached: false };
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
        // ⚠️ BOUNDED. ffmpeg over the admin's GIF has no timeout of its own,
        // and this sits between a buyer's payment and their receipt. Past the
        // budget the ladder below continues exactly as it does for any other
        // failure — the clip as-is, then the still, then the dynamic banner.
        const filled = await bounded(
          bannerTemplate
          .composeOntoClip(kind, media, logoBuffer, {
            symbol: bannerCoin.symbol,
            name: bannerCoin.name,
            chain: bannerCoin.chain,
            price: bannerCoin.price,
            mcap: bannerCoin.mcap,
            badge,
          })
          .catch(() => null),
          CLIP_BUDGET_MS,
          () => {
            log.warn(`[fulfil] ${kind} media: overlay composite passed ${CLIP_BUDGET_MS}ms — sending the clip as-is`);
            return null;
          },
        );
        if (filled) {
          log.info(`[fulfil] ${kind} media: admin clip + token overlay ✔`);
          return filled;
        }
        log.warn(`[fulfil] ${kind} media: overlay composite failed — sending clip as-is`);
      }
      // A raw .gif would arrive as a file card over MTProto — convert it so it
      // plays inline, the same as the clips composeOntoClip already produces.
      log.info(`[fulfil] ${kind} media: admin ${media.type} clip ✔`);
      return await bounded(bannerTemplate.toInlineClip(media), CLIP_BUDGET_MS, () => {
        log.warn(`[fulfil] ${kind} media: clip→animation passed ${CLIP_BUDGET_MS}ms — sending the file as-is`);
        return media;
      });
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
  // Where the time goes, phase by phase. "The listing is slow" was
  // unanswerable before this: a tiered listing runs an animated emoji build, a
  // market read, two ffmpeg clip composites and four media uploads, all serial,
  // and nothing said which of them was the minute. A phase that never ran is
  // omitted rather than printed as 0ms — a zero meaning "did not happen" reads
  // as a finding. Printed for EVERY listing, not past a threshold: a listing is
  // a paid event a few times an hour, not a hot loop.
  const _t0 = Date.now();
  const _t = { at: _t0, marks: [] };
  const step = (name) => {
    const now = Date.now();
    const ms = now - _t.at;
    _t.at = now;
    if (ms >= 1) _t.marks.push(`${name}=${ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms"}`);
  };
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
  step("logo");
  const listing = await api.createListing(input);
  log.info(`[fulfil] listing ${listing && listing.id} live: ${input.chain}/${input.address}`);

  // Remember it as listed, permanently. The auto-lister folds the site's rows
  // into its ledger on each scan, but a token bought and then deleted BEFORE
  // the next scan would slip through that window — and handing a contract
  // somebody just paid for back out as a free auto-listing is the worst version
  // of this bug. Best-effort: a ledger write must never fail a paid order.
  try {
    await require("./services/autoLister").rememberListed([{ chain: input.chain, address: input.address }]);
  } catch (e) {
    log.warn(`[fulfil] ledger note for ${input.chain}/${input.address}: ${e.message}`);
  }

  // 4. Channel posts (best-effort) — dynamic per-token banners.
  if (!logoBuffer && input.logoUrl) logoBuffer = await fetchLogoUrl(input.logoUrl);
  // Animated logo custom-emoji (per-token pack, shown inline in channel posts
  // via GramJS). Best-effort — ensureTokenEmoji never throws.
  step("create");
  // ⚠️ BOUNDED. 48 canvas frames, an ffmpeg bitrate ladder and several Telegram
  // sticker calls at up to 60s EACH — in front of the buyer's receipt, for an
  // animated logo. Its own header calls it best-effort; past the budget the
  // card renders the plain unicode fallback, which is what it does anyway on
  // any box without a pack.
  await bounded(
    tokenEmoji.ensureTokenEmoji({ chain: input.chain, address: input.address, symbol: input.sym }, logoBuffer),
    EMOJI_BUDGET_MS,
    () => log.warn(`[fulfil] token emoji passed ${EMOJI_BUDGET_MS}ms — posting with the plain fallback`),
  );
  step("emoji");
  // ⚠️ BOUNDED — this is the step that made listings "always" slow. fetchMarket
  // queues on gtSlot(PRIO_BACKGROUND) behind every timer job on the box, with no
  // deadline of its own. Past the budget the card renders from what the buyer
  // typed, which is the same value the .catch below has always produced.
  const { live, why: marketWhy } = await readPostMarket(input.chain, input.address, "listing");
  // ⚠️ REPORTED HERE, NOT AT EACH SURFACE. This one read is what the channel
  // card, the banner and the tweet all render from, so one order that
  // published a hole is one alert — the "one fault, one alert" rule. It is
  // after the read and before the posts because nothing downstream can add a
  // figure this does not have.
  postFigures.reportFigures({
    kind: "listing", chain: input.chain, address: input.address, sym: input.sym,
    name: input.name, tier: input.tier, live, why: marketWhy,
    siteUrl: `${SITE_URL}/token/${input.chain}/${input.address}`,
    // The other half of the same promise, read off the BUFFER the banner is
    // about to be handed rather than re-derived from the url — a second fetch
    // would be asking a different question from the one the artwork asked.
    art: { wanted: !!(p.logoFileId || input.logoUrl), got: !!logoBuffer, url: input.logoUrl },
  });
  const coin = coinFrom(input, live);
  const bannerCoin = bannerCoinOf(input, live);
  const tierBadge = input.tier === "XPRESS" ? "Xpress Listing" : input.tier ? `${tierLabel(input.tier)} Tier` : null;
  step("market");
  const listMedia = await postMedia("listing", bannerCoin, logoBuffer, p.logoFileId, input.logoUrl, tierBadge);

  // 5 → moved BEFORE the channel posts: tweet first, so the channel post can
  // carry the fourtis-style "Announce On X" link (the line auto-drops when X
  // is off or the tweet failed). The race keeps a hung X API from stalling
  // fulfillment; the tweet id is persisted whenever it eventually lands so a
  // later pump alert can still QUOTE the listing tweet.
  // The tweet carries the SAME artwork as the channel post (listMedia — the
  // admin's GIF/MP4 clip or the composited banner), with the raw logo only as a
  // fallback for the one shape X cannot use, a bare Telegram file_id.
  step("media");
  const tweetP = x.postListing(coin, listMedia, logoBuffer).catch(() => null);
  tweetP
    .then((id) => (id ? postids.set(input.chain, input.address, { listingTweetId: id }) : null))
    .catch(() => {});
  const tweetId = await Promise.race([tweetP, new Promise((r) => setTimeout(r, X_POST_TIMEOUT_MS, null))]);
  if (tweetId) coin.xUrl = `https://x.com/i/status/${tweetId}`;
  step("x");

  const links = [];
  try {
    // Every listing PINS itself in the channel it lands in (operator rule,
    // 2026-07-25) — the newest listing is what a visitor should see first.
    // Pinning is silent (disable_notification), and the trending channel is
    // deliberately NOT pinned here: its pin belongs to the Trending board.
    const listingMsg = await post.sendMedia(CHANNELS.listing, listMedia, fmt.listingPost(coin), { pin: true });
    if (listingMsg) links.push({ kind: "listing", label: "🔔 Dexvra Listing", url: tmeLink(CHANNELS.listing, listingMsg.message_id) });
    // …and into the community group. Best-effort: never let the mirror fail a
    // listing the buyer already paid for.
    await post.mirrorToGroup(CHANNELS.listing, listingMsg);
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

  step("posts");

  // 6. Buyer DM (the tweet was posted before the channel posts above).
  await dm(ctx, successListing(coin, links, { hours }), menu.postPurchase(coin.siteUrl));
  step("dm");
  log.info(
    `[fulfil] listing $${input.sym} (${input.tier || "?"}) took ${((Date.now() - _t0) / 1000).toFixed(1)}s — ${_t.marks.join(" ")}`,
  );
  // Returned, not just logged: the caller decides whether this was slow enough
  // to tell the operator, and "the order took 148s" sends nobody anywhere —
  // "media=48s emoji=31s" does.
  return { phases: _t.marks, ms: Date.now() - _t0 };
}

// ── Trending (standalone slot on an already-listed token) ────────────────────
async function fulfillTrending(ctx, order) {
  const p = order.payload; // { chain, address, hours }
  const listing = await api.bookTrending(p.chain, p.address, p.hours); // hard step
  log.info(`[fulfil] trending booked ${p.chain}/${p.address} ${p.hours}h`);

  // Same bound, same reason — a booked trending slot waits on a buyer too.
  const { live, why: marketWhy } = await readPostMarket(p.chain, p.address, "trending");
  const row = listing || { chain: p.chain, address: p.address, sym: p.symbol, name: p.name };
  // The same watch on the same promise. A rule applied to one of two siblings
  // is a rule half-made, and a trending slot is a purchase too.
  // ⚠️ FETCHED BEFORE THE WATCH, not after it. This used to sit below, and the
  // watch cannot report artwork it has not seen yet — a rule applied to one of
  // two siblings is a rule half-made, which is what this whole watch is about.
  const logoBuffer = await fetchLogoUrl(row.logoUrl);
  postFigures.reportFigures({
    kind: "trending", chain: p.chain, address: p.address, sym: row.sym || row.symbol,
    name: row.name, tier: null, live, why: marketWhy,
    siteUrl: `${SITE_URL}/token/${p.chain}/${p.address}`,
    art: { wanted: !!row.logoUrl, got: !!logoBuffer, url: row.logoUrl },
  });
  const coin = coinFrom(row, live);
  const bannerCoin = bannerCoinOf(row, live);
  // Reuses the pack made at listing time; builds one now if it never existed.
  await tokenEmoji.ensureTokenEmoji(
    { chain: p.chain, address: p.address, symbol: row.sym || row.symbol },
    logoBuffer,
  );
  const trendMedia = await postMedia("trending", bannerCoin, logoBuffer, null, row.logoUrl, `Trending ${p.hours}H`);

  // Trending is NOT announced on the X listing account by default: @listingdexvra
  // is the listing feed, and Trending Token is its own product with its own
  // channel (@dexvratrending). X_TRENDING_ENABLED=1 turns it back on. When it is
  // off there is simply no tweet, and the channel card's "Announce On X" line
  // drops itself — no empty label, no code path skipped.
  const tweetId = X_TRENDING_ENABLED
    ? await Promise.race([
        x.postTrending(coin, trendMedia, logoBuffer).catch(() => null),
        new Promise((r) => setTimeout(r, X_POST_TIMEOUT_MS, null)),
      ])
    : null;
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
      // An uploaded CLIP wins over the still artwork, exactly as it does for
      // listing/trending — but the ad clip has to carry the buyer's creative in
      // its frame, on every frame. Playing it bare made the animated template
      // pure decoration: the advertiser paid for a banner that never appeared.
      // The sold size decides the shape of the box in the post, so a Standard
      // (2.5:1) and a Wide (5:1) each land edge to edge instead of sharing one
      // compromise rectangle that fits neither.
      const shape = { slotSize: rec.size };
      const clip = bannerTemplate.mediaOverride("banner");
      const framedClip = clip
        ? await bannerTemplate.composeOntoClip("banner", clip, creative, shape).catch(() => null)
        : null;
      if (framedClip) {
        log.info("[fulfil] banner media: admin clip + advertiser creative ✔");
        adMedia = framedClip;
      } else {
        if (clip) log.warn("[fulfil] banner media: clip composite failed — falling back to the still frame");
        const framed = await bannerTemplate.compose("banner", creative, shape);
        if (framed) adMedia = { source: framed };
      }
    }
    // Tweet FIRST (timeboxed), so the channel post can carry the "Announce On X"
    // link — same ordering as a listing. The line drops itself when X is off or
    // the tweet failed.
    // The advertiser's creative rides along as the tweet's image — a banner ad
    // announced as a bare line of text is the one post type that is ALL image.
    bTweetId = await Promise.race([
      x.postBanner(rec, adMedia, buffer || (await fetchLogoUrl(rec.imageUrl))).catch(() => null),
      new Promise((r) => setTimeout(r, X_POST_TIMEOUT_MS, null)),
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
  // The artwork path. Exported because "the banner drew the Dexvra mark over a
  // token whose logo we had" is invisible to a source scan: both the broken and
  // the fixed version call fetch() with a url, and only DRIVING them says which
  // url. See bannerLogo.test.js.
  _fetchLogoUrl: fetchLogoUrl,
  _photoSource: photoSource,
  // The post's own market read, exported so `post:check` DRIVES it rather than
  // asking the indexers its own way. A check with a second copy of the question
  // is how `fonts:check` printed nine green ticks over a banner publishing
  // boxes — it measured a font stack that renderer did not draw with.
  _readPostMarket: readPostMarket,
};
