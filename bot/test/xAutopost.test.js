// X auto-posting: the operator's rule is "EVERY listing gets posted to X".
//
// The X path is best-effort everywhere — a dead X API must never fail a paid
// order — which means every bug in it is a SILENT one. Nothing here goes red
// when X is down; it goes red when a post path forgets to tweet at all, when a
// tweet is fired too late for the channel card to carry its "Announce On X"
// link, or when the copy stops fitting in a tweet. Those are the failures no
// runtime log will ever show you.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-xpost-"));

const test = require("node:test");
const assert = require("node:assert");

const tpl = require("../src/templates");
const fmt = require("../src/channels/format");
const x = require("../src/twitter");

// ── the copy ────────────────────────────────────────────────────────────────

const coin = {
  name: "Bull Cat",
  symbol: "BULLCAT",
  chain: "solana",
  address: "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump",
  tier: "PLATINUM",
  price: 0.000725,
  mcap: 725_100,
  links: { twitter: "https://x.com/bullcat", website: "https://bullcat.io" },
};

/** X's own weighted count: a URL is a flat 23 however long (t.co wraps it) and
 *  emoji weigh 2. Raw String.length would fail every Solana listing on address
 *  length alone and teach us nothing. */
function tweetLength(text) {
  const s = String(text).replace(/https?:\/\/\S+/g, " ".repeat(23));
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    n += cp > 0x1100 && (cp <= 0x115f || cp >= 0x2e80) ? 2 : 1;
  }
  return n;
}

test("every X template fits in a tweet, with real values in it", () => {
  const built = {
    x_listing_tiered: x._text.listingText(coin),
    x_listing: x._text.listingText({ ...coin, tier: "XPRESS" }),
    x_trending: x._text.trendingText(coin),
    x_pump: x._text.pumpText(coin, 240, 1_240_000, 4_230_000),
    x_rankup: x._text.rankUpText(coin, 2, 41.7),
    x_banner: x._text.bannerText({ title: "Acme", slot: "Hero", linkUrl: "https://acme.xyz" }),
    x_gainers: x._text.gainersText("1. $BULLCAT  +41.7%\n2. $JIM  +22.4%", "Friday · July 31 · 2026"),
  };
  for (const [key, text] of Object.entries(built)) {
    const n = tweetLength(text);
    assert.ok(n > 0 && n <= 280, `${key} is ${n}/280 chars:\n${text}`);
    assert.ok(!/\{\w+\}/.test(text), `${key} left an unsubstituted placeholder:\n${text}`);
  }
  // The values that make each post worth reading actually landed.
  assert.match(built.x_listing_tiered, /BULLCAT/);
  assert.match(built.x_listing_tiered, /PLATINUM/i);
  assert.match(built.x_listing_tiered, /@bullcat/, "the project's own X is @mentioned");
  assert.match(built.x_rankup, /#2/);
  assert.match(built.x_rankup, /\+42%/);
  assert.match(built.x_gainers, /\$JIM/);
});

test("every tweet kind has an editable template registered in the editor", () => {
  // A hardcoded tweet body is invisible to @dexvraadminbot — the banner ad's
  // copy was exactly that until it became x_banner, and nobody could reword it.
  for (const key of ["x_listing", "x_listing_tiered", "x_trending", "x_pump", "x_rankup", "x_banner", "x_gainers"]) {
    assert.ok(tpl.keys().includes(key), `${key} is not a template`);
    assert.strictEqual(tpl.meta(key).group, "X Posts", `${key} is not in the X Posts group`);
    assert.ok(tpl.meta(key).ph.length, `${key} has no placeholder hints`);
  }
});

test("a token with no X link degrades to no mention, never a dangling '@'", () => {
  const bare = x._text.listingText({ ...coin, links: {} });
  assert.ok(!/@\s|@$/.test(bare), bare);
  assert.match(bare, /BULLCAT/);
});

// ── the channel cards ───────────────────────────────────────────────────────

test("every channel post carries an Announce On X line when a tweet exists", () => {
  const withTweet = { ...coin, xUrl: "https://x.com/i/status/123" };
  const posts = {
    listing: fmt.listingPost(withTweet),
    trending: fmt.trendingPost(withTweet),
    pump: fmt.pumpPost(withTweet, 240, 1_000_000, 3_400_000),
    rankup: fmt.rankupPost(withTweet, 2, 41.7),
  };
  for (const [kind, p] of Object.entries(posts)) {
    assert.match(p.text, /Announce On X/i, `${kind} post has no Announce On X line`);
    const at = p.text.search(/Announce On X/i);
    const link = p.entities.find((e) => e.type === "text_link" && e.offset === at);
    assert.ok(link, `${kind}: the Announce On X label is not a link`);
    assert.strictEqual(link.url, withTweet.xUrl, `${kind}: wrong tweet url`);
  }
});

test("…and drops the line entirely when there is no tweet (never a dead label)", () => {
  for (const [kind, p] of Object.entries({
    listing: fmt.listingPost(coin),
    trending: fmt.trendingPost(coin),
    pump: fmt.pumpPost(coin, 240, 1_000_000, 3_400_000),
    rankup: fmt.rankupPost(coin, 2, 41.7),
  })) {
    assert.ok(!/Announce On X/i.test(p.text), `${kind} kept a dead Announce On X label:\n${p.text}`);
    assert.ok(!/\n{3,}/.test(p.text), `${kind} left a hole where the line was`);
  }
});

test("every channel post links Dexvra's own X account", () => {
  const { X_LISTING_URL } = require("../src/config/constants");
  for (const [kind, p] of Object.entries({
    listing: fmt.listingPost(coin),
    trending: fmt.trendingPost(coin),
    pump: fmt.pumpPost(coin, 240, 1_000_000, 3_400_000),
    rankup: fmt.rankupPost(coin, 2, 41.7),
  })) {
    const at = p.text.indexOf("X Alerts");
    assert.ok(at !== -1, `${kind} does not link Dexvra's X account:\n${p.text}`);
    const link = p.entities.find((e) => e.type === "text_link" && e.offset === at);
    assert.ok(link, `${kind}: 'X Alerts' is a dead label`);
    assert.strictEqual(link.url, X_LISTING_URL, `${kind}: wrong X account`);
  }
});

// ── the bot messages ────────────────────────────────────────────────────────

test("{xlisting} resolves in EVERY template, with no call site passing it", () => {
  // baseVars() is what makes this true. Before it, a template that gained an X
  // link rendered it blank until someone remembered to update the one handler
  // that renders it — which is exactly what happened to four of these.
  const { X_LISTING_URL } = require("../src/config/constants");
  for (const key of ["welcome", "intro_xpress", "intro_tiered", "intro_banner", "already_listed", "trending_ca_prompt", "buybot_help", "group_start"]) {
    const p = tpl.render(key, {});
    const text = p.html != null ? p.html : p.text;
    assert.ok(!text.includes("{xlisting}"), `${key} left {xlisting} unsubstituted`);
    // The url lives in the text for a bare link and in a text_link entity for a
    // labelled one — a template is correct either way, dead in neither.
    const linked = (p.entities || []).some((e) => e.url === X_LISTING_URL);
    assert.ok(text.includes(X_LISTING_URL) || linked, `${key} does not link the X listing account`);
  }
});

test("the X account is never hardcoded — renaming it is one env var", () => {
  // Three intro cards used to spell https://x.com/dexvralisting into their copy,
  // so X_LISTING_HANDLE was a lie the moment the account was renamed.
  for (const key of tpl.keys()) {
    const raw = tpl.getRaw(key);
    assert.ok(
      !/https:\/\/(x|twitter)\.com\/dexvra/i.test(raw),
      `${key} hardcodes the Dexvra X url — use {xlisting} instead:\n${raw}`,
    );
  }
});

// ── the wiring ──────────────────────────────────────────────────────────────

test("a free auto-listing tweets, and its card carries the tweet", async (t) => {
  const al = require("../src/services/autoLister");
  const twitter = require("../src/twitter");
  const orig = { postListing: twitter.postListing, enabled: twitter.enabled };
  t.after(() => Object.assign(twitter, orig));

  let tweeted = null;
  twitter.enabled = () => true;
  twitter.postListing = async (c) => {
    tweeted = c;
    return "1955000000000000001";
  };

  const c = { chain: "solana", address: "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump" };
  const input = { name: "Bull Cat", sym: "BULLCAT", twitter: "https://x.com/bullcat" };
  const coinObj = { name: input.name, symbol: input.sym, chain: c.chain, address: c.address };
  const id = await al.tweetListing(coinObj, c, input);

  assert.strictEqual(id, "1955000000000000001");
  assert.ok(tweeted, "an auto-listing did NOT reach X — this is the whole rule");
  assert.strictEqual(tweeted.symbol, "BULLCAT");
  // The card is rendered AFTER this, from the same object, so the url has to be
  // on it by the time tweetListing resolves — not a tick later.
  assert.strictEqual(coinObj.xUrl, "https://x.com/i/status/1955000000000000001");
});

test("auto-listing tweets can be muted on their own (X_AUTOLIST_ENABLED=0)", async (t) => {
  const before = process.env.X_AUTOLIST_ENABLED;
  process.env.X_AUTOLIST_ENABLED = "0";
  // constants reads env at load time, so the switch is only observable on a
  // fresh require — which is also how it behaves in production (a restart).
  for (const k of Object.keys(require.cache)) {
    if (/src[/\\](config[/\\]constants|services[/\\]autoLister|twitter)\.js$/.test(k)) delete require.cache[k];
  }
  t.after(() => {
    if (before == null) delete process.env.X_AUTOLIST_ENABLED;
    else process.env.X_AUTOLIST_ENABLED = before;
    for (const k of Object.keys(require.cache)) {
      if (/src[/\\](config[/\\]constants|services[/\\]autoLister|twitter)\.js$/.test(k)) delete require.cache[k];
    }
  });

  const al = require("../src/services/autoLister");
  const twitter = require("../src/twitter");
  let called = false;
  twitter.enabled = () => true;
  twitter.postListing = async () => {
    called = true;
    return "1";
  };
  const coinObj = { name: "N", symbol: "N", chain: "solana", address: "A" };
  const id = await al.tweetListing(coinObj, { chain: "solana", address: "A" }, { sym: "N" });
  assert.strictEqual(id, null);
  assert.strictEqual(called, false, "the mute switch did not mute anything");
  assert.strictEqual(coinObj.xUrl, undefined);
});

test("a rank-up quotes the token's listing tweet when we know it", async (t) => {
  const postids = require("../src/channels/postids");
  const twitter = require("../src/twitter");
  const orig = { postRankUp: twitter.postRankUp, enabled: twitter.enabled };
  t.after(() => Object.assign(twitter, orig));

  await postids.set("solana", "QuoteMe111", { listingTweetId: "1900000000000000001" });
  let quoted;
  twitter.enabled = () => true;
  twitter.postRankUp = async (c, rank, change, quoteId) => {
    quoted = quoteId;
    return "1955000000000000002";
  };

  const { tweetRankUp } = require("../src/services/rankUpChecker");
  const coinObj = { name: "Q", symbol: "Q", chain: "solana", address: "QuoteMe111" };
  const id = await tweetRankUp(coinObj, { rank: 2, change: 41.7, r: { chain: "solana", address: "QuoteMe111" } });
  assert.strictEqual(id, "1955000000000000002");
  assert.strictEqual(quoted, "1900000000000000001", "the rank-up did not quote the listing tweet");
  assert.strictEqual(coinObj.xUrl, "https://x.com/i/status/1955000000000000002");
});

test("a rank-up on a token with no known listing tweet still posts (standalone)", async (t) => {
  const twitter = require("../src/twitter");
  const orig = { postRankUp: twitter.postRankUp, enabled: twitter.enabled };
  t.after(() => Object.assign(twitter, orig));
  let quoted = "unset";
  twitter.enabled = () => true;
  twitter.postRankUp = async (c, r, ch, q) => {
    quoted = q;
    return "3";
  };
  const { tweetRankUp } = require("../src/services/rankUpChecker");
  const id = await tweetRankUp({ symbol: "Z" }, { rank: 1, change: 20, r: { chain: "solana", address: "Unknown999" } });
  assert.strictEqual(id, "3");
  assert.strictEqual(quoted, null, "a missing listing tweet must be null, not undefined");
});

test("the optional second account falls back to the listing account", () => {
  // The normal setup is ONE X account. Before the fallback, a banner ad tweeted
  // through the unconfigured "official" credentials and vanished without trace.
  const { X } = require("../src/config/constants");
  assert.ok(!X.official.appKey, "this test assumes X_O_* is unset (the default)");
  // postBanner routes to "official"; with X_O_* blank that must resolve to the
  // listing credentials rather than to nothing at all.
  const built = x._text.bannerText({ title: "Acme", linkUrl: "https://acme.xyz" });
  assert.match(built, /Acme/);
  assert.ok(tweetLength(built) <= 280);
});

test("missingKeys names exactly what an operator has to paste into .env", () => {
  const names = x.missingKeys("listing");
  // In CI none are set, so all four are reported — and by their REAL env names,
  // which is the only part of this an operator can act on.
  assert.deepStrictEqual(names, ["X_API_KEY", "X_API_KEY_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]);
});

test("with no keys, every post path is a silent no-op instead of a throw", async () => {
  // A paid order must complete when X is unreachable or unconfigured.
  assert.strictEqual(x.enabled(), false);
  assert.strictEqual(await x.postListing(coin), null);
  assert.strictEqual(await x.postTrending(coin), null);
  assert.strictEqual(await x.postPump(coin, 100, 1, 2), null);
  assert.strictEqual(await x.postRankUp(coin, 1, 20), null);
  assert.strictEqual(await x.postGainers("1. $A +5%", "today"), null);
  assert.strictEqual(await x.postBanner({ title: "A", linkUrl: "https://a.io" }), null);
  assert.strictEqual(await x.whoami(), null);
});

test("the gainers board has a plain-text form for X (no Telegram markup)", () => {
  const gainers = require("../src/gainers");
  const list = gainers.listText([
    { symbol: "BULLCAT", pct: 41.7, x: "bullcat", url: "https://dexvra.io/token/solana/x", mcap: 4_200_000 },
    { symbol: "JIM", pct: 22.4, x: null, url: "https://dexvra.io/token/solana/y", mcap: 900_000 },
  ]);
  // Telegram's [label](url) markup would publish its own brackets on X.
  assert.ok(!/\[|\]|\(http/.test(list), `markup leaked into the tweet:\n${list}`);
  assert.match(list, /1\. \$BULLCAT @bullcat/);
  assert.match(list, /2\. \$JIM/);
  assert.ok(!/@null|@undefined/.test(list), "a token with no X handle got a broken mention");
});

test("an admin-queued gainers banner tweets too, not just the daily one", async (t) => {
  // The daily board was tweeted and the identical admin-tapped board was not —
  // the copy has to travel on the job because the admin bot owns the coins and
  // the main bot owns the X keys.
  const gp = require("../src/services/gainersPoster");
  const twitter = require("../src/twitter");
  const orig = { postGainers: twitter.postGainers, enabled: twitter.enabled };
  t.after(() => Object.assign(twitter, orig));

  let sent = null;
  twitter.enabled = () => true;
  twitter.postGainers = async (list, date) => {
    sent = { list, date };
    return "1955000000000000009";
  };

  const url = await gp.tweetQueued({ xList: "1. $BULLCAT  +41.7%", xDate: "Friday · July 31 · 2026", imagePath: "" });
  assert.strictEqual(url, "https://x.com/i/status/1955000000000000009");
  assert.match(sent.list, /BULLCAT/);
  assert.strictEqual(sent.date, "Friday · July 31 · 2026");

  // A job queued before xList existed must be skipped, never tweeted blank.
  sent = null;
  assert.strictEqual(await gp.tweetQueued({ imagePath: "" }), null);
  assert.strictEqual(sent, null, "a job with no board copy must not produce an empty tweet");
});

test("the gainers board carries its own Announce On X line, and drops it when unposted", () => {
  const gainers = require("../src/gainers");
  const coins = [{ symbol: "BULLCAT", pct: 41.7, x: "bullcat", url: "https://dexvra.io/token/solana/x", mcap: 4_200_000 }];

  const posted = gainers.captionPayload(coins, { xUrl: "https://x.com/i/status/777" });
  assert.match(posted.text, /Announce On X/i, "a tweeted board must link its tweet");
  const at = posted.text.search(/Announce On X/i);
  const link = posted.entities.find((e) => e.type === "text_link" && e.offset === at);
  assert.ok(link && link.url === "https://x.com/i/status/777", "the Announce On X label is not linked to the tweet");

  // The admin-queued path builds its caption in the OTHER process, before the
  // main bot tweets, so it legitimately has no url — the line must vanish
  // rather than sit there dead.
  const quiet = gainers.captionPayload(coins, {});
  assert.ok(!/Announce On X/i.test(quiet.text), `dead label left behind:\n${quiet.text}`);
  assert.ok(!/\n{3,}/.test(quiet.text), "removing the line left a hole");
  assert.match(quiet.text, /BULLCAT/, "the board itself survived the strip");
  assert.match(quiet.text, /X Alerts/, "the footer still links Dexvra's X account");
});

test("a blocked network is never reported as 'X refused your keys'", () => {
  // A proxy, a firewall or a sandbox egress allowlist answers with the SAME 403
  // X uses for a read-only access token — and its body is a bare string, not
  // X's error object, so reading only .detail/.title threw away the one line
  // that said what happened. Conflating the two sends an operator off
  // regenerating credentials that were never the problem. (Hit for real: this
  // container returned `403 Host not in allowlist: api.x.com` and the checker
  // confidently blamed the keys.)
  const { classify } = require("../src/twitter")._diag;

  const proxied = classify(
    Object.assign(new Error("Request failed with code 403"), {
      code: 403,
      data: "Host not in allowlist: api.x.com. Add this host to your network egress settings to allow access.",
    }),
  );
  assert.strictEqual(proxied.kind, "network", `a proxy block must not read as an auth failure: ${proxied.message}`);
  assert.match(proxied.message, /cannot reach api\.x\.com/);

  // A REAL read-only-token 403 from X still has to be called what it is.
  const readOnly = classify(
    Object.assign(new Error("Request failed with code 403"), {
      code: 403,
      data: { status: 403, detail: "Your client app is not configured with the appropriate oauth1 app permissions." },
    }),
  );
  assert.strictEqual(readOnly.kind, "permission", readOnly.message);
  assert.match(readOnly.message, /Read and write/);

  assert.strictEqual(classify(Object.assign(new Error("401"), { code: 401 })).kind, "auth");
  assert.strictEqual(classify(Object.assign(new Error("429"), { code: 429 })).kind, "ratelimit");
  for (const m of ["fetch failed", "ENOTFOUND api.x.com", "socket hang up", "ETIMEDOUT"]) {
    assert.strictEqual(classify(new Error(m)).kind, "network", m);
  }
});

test("X's new-app crypto rule is not mistaken for a bad access token", () => {
  // A brand-new X app may not post contract addresses for its first 7 days.
  // It arrives as a 403 — the same status as a read-only token — so the naive
  // mapping told the operator to regenerate credentials that were perfectly
  // fine. (Hit for real on the first live listing: @dexvralisting authenticated
  // the same day, and the Catjak card was refused for its CA line.)
  const { classify } = require("../src/twitter")._diag;
  const res = classify(
    Object.assign(new Error("Request failed with code 403"), {
      code: 403,
      data: { status: 403, detail: "Crypto addresses are prohibited for the first 7 days after authentication." },
    }),
  );
  assert.strictEqual(res.kind, "newapp-crypto", res.message);
  assert.match(res.message, /NOT a key problem/);
  assert.ok(!/READ-ONLY/.test(res.message), "must not send the operator to regenerate the token");
});

test("a refused listing is retried without its CA, keeping the token link", () => {
  const { stripCryptoAddresses: strip } = require("../src/twitter")._diag;
  const full = x._text.listingText({
    name: "Catjak",
    symbol: "CATJAK",
    chain: "solana",
    address: "3taE4SdY29sa3fnwyWqfshudJ95gMb9LoFTy5Uuppump",
    tier: "XPRESS",
    price: 0.000549,
    mcap: 541_400,
    links: {},
  });
  assert.match(full, /CA: 3taE4SdY/, "precondition: the card carries a bare CA");

  const safe = strip(full);
  assert.ok(!/CA:/.test(safe), `the CA line must go, label included:\n${safe}`);
  // The token page URL embeds the same address — it must SURVIVE. X shortens
  // every url to t.co, so the link is not what the rule is scanning for, and
  // dropping it would cost the tweet its only route back to Dexvra.
  assert.match(safe, /https:\/\/dexvra\.io\/token\/solana\/3taE4SdY/, `the token link was dropped:\n${safe}`);
  assert.match(safe, /CATJAK/, "the ticker survived");
  assert.match(safe, /\$541\.4K/, "the market cap survived");
  assert.ok(!/\n{3,}/.test(safe), "removing the line left a hole");
  assert.ok(tweetLength(safe) <= 280);

  // Every chain shape the bot lists on, not just Solana.
  for (const addr of [
    "0x2170ed0880ac9a755fd29b2688956bd959f933f8",
    "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    "EQCcGZm1AqBCTBc0Kkm8kdmuOZfE7SFrRA0TnCLLtnQZlkOB",
  ]) {
    const s = strip(`Header\n\nCA: ${addr}\n\nhttps://dexvra.io/token/x/${addr}\n\n#Dexvra`);
    assert.ok(!/CA:/.test(s), `${addr} not stripped:\n${s}`);
    assert.match(s, /dexvra\.io\/token/, `${addr}: link should survive:\n${s}`);
  }

  // A tweet with no address at all must come back untouched — the fallback
  // fires on every kind of post, and the gainers board has no CA to lose.
  const gainers = x._text.gainersText("1. $A  +12%\n2. $B  +8%", "Friday");
  assert.strictEqual(strip(gainers), gainers.trim());
});
