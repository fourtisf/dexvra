// "SAYA SUDAH DELETE TOKEN FROM DATABASE TPI PUMP ALERT MASIH SPAMM".
//
// A honeypot ($NASDUCK, Robinhood) was deleted from the site and went on
// posting "+1200%" and "+1900% since listing" into the listing channel. The
// sweep read the list once and walked ~680 tokens for many minutes, sweeps
// overlapped (setInterval does not wait), and the token's baseline and latch
// outlived the row. These tests DRIVE the sweep with the network stubbed.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-pumpdel-"));
process.env.PUMP_POLITE_MS = "0";

const test = require("node:test");
const assert = require("node:assert");

const api = require("../src/api/dexvra");
const market = require("../src/marketdata");
const postids = require("../src/channels/postids");
const post = require("../src/channels/post");
const bannerTemplate = require("../src/bannerTemplate");
const pump = require("../src/services/pumpChecker");
const { saveJSON } = require("../src/helpers/persist");

const CA = "0x78fC7E13BCCab8a7aedc5b8465C3442d6D7D9d64";
const KEY = `robinhood:${CA.toLowerCase()}`;
const ROW = { id: "l_nasduck", chain: "robinhood", address: CA, sym: "NASDUCK", name: "Nasduck", tier: "FREE", status: "approved", listedAt: 1000 };
// +1916% on a pool that is ~2% of the cap — a reading that WOULD be announced.
const PUMPED = { priceUsd: 0.5484, mcap: 256.5e6, liq: 5e6 };

const sent = [];
function stubAll({ listings, confirm, price = PUMPED } = {}) {
  sent.length = 0;
  let reads = 0;
  api.getListings = async () => {
    reads++;
    if (reads === 1) return typeof listings === "function" ? listings() : listings;
    if (confirm instanceof Error) throw confirm;
    return typeof confirm === "function" ? confirm() : confirm;
  };
  market.fetchPrice = async () => price;
  postids.get = () => ({ listingMsgId: 7 });
  post.sendMedia = async (channel, media, card, opts) => {
    sent.push({ channel, card, opts });
    return { message_id: 100 + sent.length };
  };
  bannerTemplate.mediaOverride = () => null;
}

async function reset(base = { [KEY]: { price: 0.0272, mcap: 27e6, at: 1, listedAt: 1000 } }) {
  const { baseline, latch } = pump._state();
  for (const k of Object.keys(baseline)) delete baseline[k];
  Object.assign(baseline, JSON.parse(JSON.stringify(base)));
  await latch.deleteWhere(() => true);
  await saveJSON("listingAudit.json", {});
}

test("control: a token still listed IS announced, once, and latched", async () => {
  // Without this the tests below could pass on a sweep that never posts at all.
  await reset();
  stubAll({ listings: [ROW], confirm: [ROW] });
  const out = await pump.sweep();
  assert.equal(out.posted, 1, JSON.stringify(out));
  assert.equal(sent.length, 1);
  assert.ok(pump._state().latch.has(`${KEY}@1900`), "the step is latched after it posts");
  const again = await pump.sweep();
  assert.equal(again.posted, 0, "the same step never posts twice");
});

test("a token DELETED after the sweep read the list is never announced — and nothing is latched", async () => {
  await reset();
  stubAll({ listings: [ROW], confirm: [] }); // gone by the time the alert would go out
  const out = await pump.sweep();
  assert.equal(sent.length, 0, "nothing may be posted about a deleted token");
  assert.equal(out.posted, 0);
  assert.match(out.skipped[0].why, /no longer listed/);
  assert.ok(!pump._state().latch.has(`${KEY}@1900`), "a refusal spends no latch");
});

test("an UNLISTED (rejected) token is treated exactly like a deleted one", async () => {
  await reset();
  stubAll({ listings: [ROW], confirm: [{ ...ROW, status: "rejected" }] });
  await pump.sweep();
  assert.equal(sent.length, 0);
});

test("a re-read that FAILS posts nothing — silence is the safe way to be wrong", async () => {
  await reset();
  stubAll({ listings: [ROW], confirm: new Error("ECONNREFUSED") });
  const out = await pump.sweep();
  assert.equal(sent.length, 0);
  assert.match(out.skipped[0].why, /could not re-read/);
});

test("sweeps never overlap: a tick during a running sweep is skipped, not stacked", async () => {
  await reset();
  stubAll({ listings: [ROW], confirm: [ROW] });
  let release;
  const gate = new Promise((r) => (release = r));
  market.fetchPrice = async () => {
    await gate;
    return PUMPED;
  };
  const first = pump.sweep();
  // Raced against a timer: a second sweep that RUNS would park on the same gate
  // and never settle, which must read as a failure, not as a hung test.
  const second = await Promise.race([pump.sweep(), new Promise((r) => setTimeout(() => r("it ran"), 100))]);
  assert.equal(second, null, "the second tick must not run while the first is in flight");
  release();
  const out = await first;
  assert.equal(out.posted, 1);
  assert.equal(sent.length, 1, "exactly one alert — overlapping sweeps used to double-post a step");
});

test("a token gone from the site has its baseline AND its ladder forgotten", async () => {
  await reset();
  await pump._state().latch.addAll([`${KEY}@100`, `${KEY}@200`, KEY, "robinhood:0xother@100"]);
  const OTHER = { ...ROW, id: "o", address: "0x0000000000000000000000000000000000000abc", sym: "OTHER" };
  stubAll({ listings: [OTHER], confirm: [OTHER], price: null });
  await pump.sweep();
  const { baseline, latch } = pump._state();
  assert.ok(!baseline[KEY], "the deleted token's baseline is dropped");
  assert.ok(!latch.has(`${KEY}@100`) && !latch.has(`${KEY}@200`) && !latch.has(KEY), "…and every step of its ladder");
  assert.ok(latch.has("robinhood:0xother@100"), "another token's ladder is untouched");
});

test("a list that looks like a SITE OUTAGE prunes nothing", async () => {
  // A site that lost its store serves its seed rows; read literally, every
  // real listing was "deleted" at once.
  const many = {};
  for (let i = 0; i < 30; i++) many[`base:0x${String(i).padStart(40, "0")}`] = { price: 1, at: 1 };
  await reset(many);
  stubAll({ listings: [{ ...ROW, address: "0x" + "f".repeat(40) }], confirm: [], price: null });
  await pump.sweep();
  assert.equal(Object.keys(pump._state().baseline).length, 30, "the ledger survives an outage-shaped read");
});

test("an empty read prunes nothing", async () => {
  await reset();
  stubAll({ listings: [], confirm: [], price: null });
  await pump.sweep();
  assert.ok(pump._state().baseline[KEY], "no rows is not 'every row was deleted'");
});

test("a RE-LISTED token (new listedAt) starts a new ladder instead of announcing the old gain", async () => {
  await reset();
  stubAll({ listings: [{ ...ROW, listedAt: 5000 }], confirm: [{ ...ROW, listedAt: 5000 }] });
  const out = await pump.sweep();
  assert.equal(sent.length, 0, "'+1900% since listing' about a listing minutes old is the defect");
  assert.equal(out.posted, 0);
  const b = pump._state().baseline[KEY];
  assert.equal(b.price, PUMPED.priceUsd, "the new baseline is today's price");
  assert.equal(b.listedAt, 5000);
});

test("a price a thin pool printed is not announced as a pump", async () => {
  // GMGN measured the pool at $507 against a $684M cap. Same +1916% as the
  // control (inside the 100–2000% window), only the pool differs.
  await reset();
  stubAll({ listings: [ROW], confirm: [ROW], price: { ...PUMPED, liq: 507.66 } });
  const out = await pump.sweep();
  assert.equal(sent.length, 0);
  assert.match(out.skipped[0].why, /not backed by a pool/);
  assert.ok(!pump._state().latch.has(`${KEY}@1900`), "no latch — a pool that fills in may still announce");
});

test("unbackedPrice: an unpublished liquidity makes no claim, and 0 turns the rule off", () => {
  assert.equal(pump.unbackedPrice({ priceUsd: 1, mcap: 1e6, liq: null }), null);
  assert.equal(pump.unbackedPrice({ priceUsd: 1, mcap: 1e6, liq: 50_000 }), null, "5% is a real market");
  assert.ok(pump.unbackedPrice({ priceUsd: 1, mcap: 1e6, liq: 1_000 }), "0.1% is not");
  assert.equal(pump.unbackedPrice({ priceUsd: 1, mcap: 1e6, liq: 1_000 }, 0), null);
});

test("a token the listing audit flagged as a SCAM is silenced; one flagged only for its logo is not", async () => {
  await reset();
  await saveJSON("listingAudit.json", { checked: {}, flagged: { [KEY]: { why: "potential scam (honeypot)" } } });
  stubAll({ listings: [ROW], confirm: [ROW] });
  let priced = 0;
  market.fetchPrice = async () => (priced++, PUMPED);
  await pump.sweep();
  assert.equal(sent.length, 0, "a flagged honeypot is never pump-announced");
  assert.equal(priced, 0, "…and is not even priced — it costs no indexer budget");

  await reset();
  await saveJSON("listingAudit.json", { checked: {}, flagged: { [KEY]: { why: "no logo (the stored url cannot be drawn)" } } });
  stubAll({ listings: [ROW], confirm: [ROW] });
  await pump.sweep();
  assert.equal(sent.length, 1, "a broken logo is not a reason to stop announcing a real token");
});

test("the confirmation sits BEFORE the tweet and the channel post", () => {
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  const iConfirm = src.indexOf("await confirmListed(r, base)");
  assert.ok(iConfirm > -1, "the sweep must re-ask the site");
  assert.ok(iConfirm < src.indexOf("x.postPump("), "before the tweet");
  assert.ok(iConfirm < src.indexOf("post.sendMedia("), "before the Telegram post");
  assert.ok(!/setInterval\(run,/.test(src), "the timer drives the single-flight sweep, never a bare run");
});

test("rank-up asks the same fresh question before its banner, tweet and post", () => {
  const src = fss.readFileSync(require.resolve("../src/services/rankUpChecker.js"), "utf8");
  const iConfirm = src.indexOf("await confirmListed(a.r, null)");
  assert.ok(iConfirm > -1, "rank-up must re-ask the site");
  assert.ok(iConfirm < src.indexOf('postMedia("rankup"'), "before the banner is rendered");
  assert.ok(iConfirm < src.indexOf("await tweetRankUp("), "before the tweet");
  assert.ok(iConfirm < src.indexOf("post.sendMedia(CHANNELS.trending"), "before the channel post");
});

test("stillListed: one owner — the pump checker does not grow a second copy", () => {
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  assert.match(src, /require\("\.\.\/helpers\/stillListed"\)/);
  assert.ok(!/async function confirmListed/.test(src), "confirmListed lives in helpers/stillListed.js only");
});
