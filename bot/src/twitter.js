// X / Twitter posting (twitter-api-v2). Fully built but DISABLED unless the
// listing account's 4 OAuth 1.0a keys are present (X_ENABLED) — see
// config/constants.js for which four and where each comes from in the console.
//
// Two accounts are supported: "listing" (@dexvralisting — every listing,
// trending, rank-up, pump and gainers post) and an OPTIONAL "official" second
// account for banner ads. With X_O_* blank — the normal one-account setup —
// "official" FALLS BACK to the listing account, so a banner ad still gets
// tweeted instead of silently going nowhere.
//
// Media is uploaded when a buffer is provided; otherwise (and on any v1 upload
// 403 — free tier) it falls back to a text-only tweet. Every entry point returns
// the tweet id or null and NEVER throws: a dead X API must not fail a paid order.
const { X, X_ENABLED, X_HANDLE, X_LISTING_HANDLE, SITE_URL, xMissingKeys } = require("./config/constants");
const { fmtPrice, formatNumber } = require("./helpers/format");
const { chainOf } = require("./config/chains");
const tpl = require("./templates");
const log = require("./helpers/logger");

let TwitterApi = null;
function lib() {
  if (!TwitterApi) TwitterApi = require("twitter-api-v2").TwitterApi;
  return TwitterApi;
}

const complete = (cfg) => Boolean(cfg && cfg.appKey && cfg.appSecret && cfg.accessToken && cfg.accessSecret);

/** Credentials for an account, falling back to the listing account when the
 *  optional second one isn't configured. Returns null when neither is set. */
function credsFor(account) {
  if (account === "official" && complete(X.official)) return { cfg: X.official, used: "official" };
  return complete(X.listing) ? { cfg: X.listing, used: "listing" } : null;
}

function clientFor(account) {
  const c = credsFor(account);
  if (!c) return null;
  return {
    used: c.used,
    api: new (lib())({
      appKey: c.cfg.appKey,
      appSecret: c.cfg.appSecret,
      accessToken: c.cfg.accessToken,
      accessSecret: c.cfg.accessSecret,
    }),
  };
}

const symTag = (s) => String(s || "").replace(/^\$+/, "").toUpperCase();
const coinUrl = (coin) => coin.siteUrl || `${SITE_URL}/token/${coin.chain}/${coin.address}`;

const safeJson = (v) => {
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
};

/**
 * Classify a failure. The distinction that matters most is NETWORK vs AUTH: a
 * firewall, a corporate proxy or a sandbox egress allowlist answers with the
 * same 403 status X uses for a read-only token, and telling an operator their
 * keys were rejected when the request never left the building sends them off
 * regenerating credentials that were fine all along.
 *
 * @returns {{kind: string, message: string}} kind ∈ network | newapp-crypto |
 *   permission | auth | ratelimit | duplicate | unknown
 */
function classify(e) {
  const code = e && (e.code || (e.data && e.data.status));
  // e.data is an OBJECT for a real X error and a plain STRING for anything that
  // answered on X's behalf — a proxy, a gateway, a captive portal. Reading only
  // .detail/.title threw away the one line that said what actually happened
  // ("Host not in allowlist: api.x.com"), which is exactly the case this
  // function exists to catch. Flatten whatever shape arrived.
  const body =
    e && e.data ? (typeof e.data === "string" ? e.data : e.data.detail || e.data.title || safeJson(e.data)) : "";
  const detail = typeof body === "string" ? body : "";
  const raw = `${(e && e.message) || ""} ${detail} ${(e && e.error) || ""}`;
  // Never reached X. Proxy/allowlist rejections and DNS/TCP failures both land
  // here — the giveaway is that the body talks about the HOST, not about auth.
  if (
    /not in allowlist|egress|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|proxy|tunneling|self.signed|unable to verify/i.test(raw)
  ) {
    return { kind: "network", message: `cannot reach api.x.com — ${(e && e.message) || detail}` };
  }
  // X refuses CONTRACT ADDRESSES from a newly authenticated app for its first
  // 7 days — an anti-spam rule aimed at throwaway shill accounts, and it lands
  // as a 403 exactly like a read-only token. Calling it a permissions problem
  // sends the operator off regenerating a token that was never at fault, so it
  // gets its own kind: nothing to fix, the listing card just posts without its
  // CA line until the app ages out (see stripCryptoAddresses).
  if (/crypto address(es)? (are|is) prohibited|prohibited for the first \d+ days/i.test(raw)) {
    return {
      kind: "newapp-crypto",
      message:
        `${detail || e.message} — this is X's new-app rule, NOT a key problem. ` +
        "The tweet is retried without the contract address; the full card returns by itself once the app is 7 days past authentication.",
    };
  }
  if (code === 403) {
    return {
      kind: "permission",
      message: `${e.message}${detail ? ` — ${detail}` : ""} (403 — the Access Token is READ-ONLY: set the app to "Read and write", then REGENERATE the access token)`,
    };
  }
  if (code === 401) return { kind: "auth", message: `${e.message} (401 — the 4 keys don't match one app, or they were regenerated in the console)` };
  if (code === 429) return { kind: "ratelimit", message: `${e.message} (429 — X post cap reached for this window/tier)` };
  if (/duplicate/i.test(raw)) return { kind: "duplicate", message: `${e.message} (X rejects a repeat of a recent tweet)` };
  return { kind: "unknown", message: `${e.message}${detail ? ` — ${detail}` : ""}` };
}
const explain = (e) => classify(e).message;

// Bare on-chain addresses, by chain shape. Deliberately anchored to whole words
// so a 44-char base58 run inside a URL path is NOT matched — the token page link
// carries the address too, and X shortens every URL to t.co before scanning, so
// the link survives while the bare "CA:" line is what has to go.
const ADDRESS_RE = new RegExp(
  [
    "0x[a-fA-F0-9]{40}", // EVM
    "T[1-9A-HJ-NP-Za-km-z]{33}", // Tron
    "(?:EQ|UQ)[A-Za-z0-9_-]{46}", // TON
    "[1-9A-HJ-NP-Za-km-z]{32,44}", // Solana / base58 (last: broadest)
  ].join("|"),
  "g",
);

/**
 * Remove every LINE that carries a bare contract address, then close the gap.
 *
 * Used only as a fallback when X rejects a tweet under its new-app crypto rule.
 * Whole lines rather than the address alone, because the line is a label ("CA:")
 * whose value has gone — leaving "CA:" hanging reads worse than not saying it.
 * URLs are protected first so the token-page link (which embeds the same
 * address) is never mistaken for a bare address and dropped with its line.
 */
function stripCryptoAddresses(text) {
  const kept = String(text)
    .split("\n")
    .filter((line) => {
      const withoutUrls = line.replace(/https?:\/\/\S+/g, " ");
      ADDRESS_RE.lastIndex = 0;
      return !ADDRESS_RE.test(withoutUrls);
    })
    .join("\n");
  return kept.replace(/\n{3,}/g, "\n\n").trim();
}

async function send(account, text, mediaBuffer, mimeType, quoteTweetId, _retriedWithoutCa) {
  if (!X_ENABLED) {
    const missing = xMissingKeys("listing");
    log.debug(`[x] disabled — skipping tweet${missing.length ? ` (missing: ${missing.join(", ")})` : " (X_ENABLED=0)"}`);
    return null;
  }
  const client = clientFor(account);
  if (!client) {
    log.debug(`[x] no keys for account ${account}`);
    return null;
  }
  try {
    let mediaIds;
    if (mediaBuffer) {
      try {
        const id = await client.api.v1.uploadMedia(mediaBuffer, { mimeType: mimeType || "image/png" });
        mediaIds = [id];
      } catch (e) {
        log.debug(`[x] media upload failed (${e.message}) — text-only`);
      }
    }
    const opts = {};
    if (mediaIds) opts.media = { media_ids: mediaIds };
    if (quoteTweetId) opts.quote_tweet_id = String(quoteTweetId); // quote the listing tweet
    const res = await client.api.v2.tweet(text, Object.keys(opts).length ? opts : undefined);
    const id = res && res.data && res.data.id;
    log.info(
      `[x] tweeted (${account}${client.used !== account ? ` via ${client.used}` : ""}) id=${id}` +
        `${quoteTweetId ? ` (quote of ${quoteTweetId})` : ""}`,
    );
    return id || null;
  } catch (e) {
    const c = classify(e);
    // A brand-new X app may not post contract addresses for 7 days. Rather than
    // lose the announcement — the listing is live, the buyer paid for reach —
    // send it again with the CA line removed. One retry only, and only when
    // dropping the address actually changed the text.
    if (c.kind === "newapp-crypto" && !_retriedWithoutCa) {
      const withoutCa = stripCryptoAddresses(text);
      if (withoutCa && withoutCa !== text) {
        log.warn(`[x] ${c.message}`);
        log.info("[x] retrying without the contract address…");
        return send(account, withoutCa, mediaBuffer, mimeType, quoteTweetId, true);
      }
    }
    log.warn(`[x] tweet failed (${account}): ${c.message}`);
    return null;
  }
}

const chainLabel = (c) => (chainOf(c) ? chainOf(c).label : String(c || ""));
const mcOf = (m) => (m && m > 0 ? "$" + formatNumber(m) : "TBA");

// Tier badge for the tweet — the SAME admin setting the channel post uses,
// flattened to its plain character because X has no custom emoji. A second
// hardcoded map lived here and silently ignored the operator's choice.
const xTierEmoji = (tier) => require("./channels/format").tierBadgeChar(tier) || "💎";
// @mention the project's X account, parsed from the twitter link they submitted.
function xMention(links) {
  const t = links && links.twitter;
  if (!t) return "";
  const m = String(t).match(/(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})/i);
  return m ? ` @${m[1]}` : "";
}

// Editable via @dexvraadminbot → "X Posts". Xpress and Listing & Trending get
// distinct copy (the latter carries the tier line); both keep only the leading
// ⚡ and the tier emoji — no per-line emoji.
function listingText(coin) {
  const tag = symTag(coin.symbol);
  const tier = String(coin.tier || "").toUpperCase();
  const vars = {
    name: coin.name,
    tag,
    mention: xMention(coin.links),
    url: coinUrl(coin),
    address: coin.address,
    price: coin.price ? fmtPrice(coin.price) : "TBA",
    mcap: mcOf(coin.mcap),
    chain: chainLabel(coin.chain),
    handle: `@${X_LISTING_HANDLE}`,
  };
  if (tier && tier !== "XPRESS") {
    return tpl.t("x_listing_tiered", { ...vars, tier, tierEmoji: xTierEmoji(tier) });
  }
  return tpl.t("x_listing", vars);
}

function trendingText(coin) {
  const tag = symTag(coin.symbol);
  return tpl.t("x_trending", {
    symbol: `$${tag}`,
    name: coin.name,
    chain: chainLabel(coin.chain),
    url: coinUrl(coin),
    tag,
    mention: xMention(coin.links),
    handle: `@${X_LISTING_HANDLE}`,
  });
}

function pumpText(coin, percent, firstMc, lastMc) {
  return tpl.t("x_pump", {
    tag: symTag(coin.symbol),
    name: coin.name,
    mention: xMention(coin.links),
    percent: Math.round(percent),
    firstMc: mcOf(firstMc),
    lastMc: mcOf(lastMc),
    url: coinUrl(coin),
    handle: `@${X_LISTING_HANDLE}`,
  });
}

function rankUpText(coin, rank, change) {
  return tpl.t("x_rankup", {
    tag: symTag(coin.symbol),
    name: coin.name,
    mention: xMention(coin.links),
    rank,
    gain: Number.isFinite(Number(change)) ? `+${Math.round(Number(change))}%` : "",
    chain: chainLabel(coin.chain),
    url: coinUrl(coin),
    handle: `@${X_LISTING_HANDLE}`,
  });
}

async function verify(account = "listing") {
  const client = clientFor(account);
  if (!client) {
    const missing = xMissingKeys(account);
    return { ok: false, handle: null, kind: "nokeys", message: `missing: ${missing.join(", ") || "(none)"}` };
  }
  try {
    const me = await client.api.v2.me();
    const handle = (me && me.data && me.data.username) || null;
    return { ok: Boolean(handle), handle, kind: handle ? "ok" : "unknown", message: handle ? `@${handle}` : "X returned no user" };
  } catch (e) {
    const c = classify(e);
    log.debug(`[x] verify (${account}): ${c.message}`);
    return { ok: false, handle: null, kind: c.kind, message: c.message };
  }
}

function bannerText(booking) {
  return tpl.t("x_banner", {
    title: booking.title || "A project",
    slot: booking.slot || "",
    url: booking.linkUrl || SITE_URL,
    site: SITE_URL,
    handle: `@${X_HANDLE}`,
    mention: xMention({ twitter: booking.twitter }),
  });
}

// The daily Top-Gainers board. {list} arrives pre-built by gainers.js as plain
// text (X has no markdown and no custom emoji), so the caller owns its shape.
function gainersText(list, dateText) {
  return tpl.t("x_gainers", {
    list: String(list || "").trim(),
    date: dateText || "",
    site: SITE_URL,
    handle: `@${X_LISTING_HANDLE}`,
  });
}

module.exports = {
  enabled: () => X_ENABLED,
  /** Which of the listing account's keys are still blank — used by the boot
   *  diagnostic and `npm run x:check`. */
  missingKeys: xMissingKeys,
  /** Verify the credentials actually authenticate, and return the handle they
   *  post as. Null when X is off or the call didn't succeed — use verify() when
   *  you need to know WHY. */
  whoami: async (account = "listing") => (await verify(account)).handle,
  /**
   * Credential check with a classified outcome, so a caller can tell "your keys
   * are wrong" apart from "this box can't reach X".
   * @returns {Promise<{ok: boolean, handle: string|null, kind: string, message: string}>}
   *   kind ∈ ok | nokeys | network | permission | auth | ratelimit | unknown
   */
  verify,
  postListing: (coin, media, mime) => send("listing", listingText(coin), media, mime),
  postTrending: (coin, media, mime) => send("listing", trendingText(coin), media, mime),
  // Quote the token's original listing tweet when we have its id (the listing
  // card renders below the pump text, like fourtis); standalone tweet otherwise.
  postPump: (coin, percent, firstMc, lastMc, quoteTweetId, media, mime) =>
    send("listing", pumpText(coin, percent, firstMc, lastMc), media, mime, quoteTweetId),
  // Rank-ups quote the listing tweet the same way — the token's own card is the
  // context that makes "climbed to #2" mean something.
  postRankUp: (coin, rank, change, quoteTweetId, media, mime) =>
    send("listing", rankUpText(coin, rank, change), media, mime, quoteTweetId),
  postGainers: (list, dateText, media, mime) => send("listing", gainersText(list, dateText), media, mime),
  postBanner: (booking, media, mime) => send("official", bannerText(booking), media, mime),
  // Exposed for tests + the preview in @dexvraadminbot — building the copy must
  // be checkable without credentials or a network.
  _text: { listingText, trendingText, pumpText, rankUpText, bannerText, gainersText },
  // Error classification is pure and is the thing most worth pinning: it decides
  // what an operator is told to go and fix.
  _diag: { classify, stripCryptoAddresses },
};
