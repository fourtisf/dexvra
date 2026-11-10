// The listing form's SECOND LOOK at a token's own metadata.
//
// Reported 2026-10-14 with $KVR (KOVRA), a pump.fun launch three minutes old:
// the review card came back "Logo: not set · Website: not set · X: not set"
// beside its pump.fun page drawing all three. The on-chain metadata reader
// (solanaMeta.js) had shipped and been measured working on the box the day
// before — what it could not survive was ONE clock: an RPC answering 429 for a
// few seconds under the buy bot's polling, or a CID minted minutes ago that no
// gateway had cached yet, and the miss was permanent.
//
// These tests drive the real paste handler and pin the four things that make a
// late answer safe: it never holds the polling loop, it fills holes only, it
// never repaints a card the buyer has left, and it stops when it cannot help.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-latefill-"));
process.env.LISTING_AUTOFILL_MS = "400";
// The runner switches the chain read off for every other file; the second
// look exists only where it is on, so this file turns it back on — blank,
// which is what a box that never set it has.
process.env.SOLANA_META = "";

const test = require("node:test");
const assert = require("node:assert");

const listing = require("../src/handlers/listing");
const listedGuard = require("../src/helpers/listedGuard");
const solanaMeta = require("../src/solanaMeta");

const MINT = "DzBCYzmGHEVdh5HK8tFBgS72iNaCEqkSHDeCCTLSpump"; // the reported token
const FIRST = { name: "KOVRA", symbol: "KVR", logoUrl: null, website: null, twitter: null, telegram: null };
const FULL = {
  name: "KOVRA",
  symbol: "KVR",
  logoUrl: "https://ipfs.io/ipfs/bafkreikovra",
  website: "https://kovra.fun",
  twitter: "https://x.com/kovra_sol",
  telegram: null,
  description: "Kovra is a cat in a costume, minted on pump.fun for Halloween season.",
};

const realLookups = { ...listing._lookups };
const realLate = { ...listing._late };
const realBlock = listedGuard.blockIfListed;
test.beforeEach(() => {
  solanaMeta._reset();
  listedGuard.blockIfListed = async () => false;
  listing._lookups.fetchMarket = async () => null;
  listing._lookups.fetchTokenDescription = async () => null;
  listing._late.delays = () => [0, 0];
  listing._late.wait = async () => {};
  listing._late.started = null;
});
test.afterEach(() => {
  Object.assign(listing._lookups, realLookups);
  Object.assign(listing._late, realLate);
  listedGuard.blockIfListed = realBlock;
});

/** A chat whose LIVE session is `ctx.session` unless a test replaces it. */
function chat(over = {}) {
  const replies = [];
  let id = 100;
  const ctx = {
    replies,
    chat: { id: 7, type: "private" },
    from: { id: 7 },
    session: { type: "xpress_listing", form: { ...listing._test.emptyForm(), chain: "solana", ...over }, awaitingField: "address" },
    message: { text: MINT },
    reply: async (t) => {
      replies.push(String(t));
      return { message_id: ++id };
    },
    replyWithPhoto: async (_p, extra) => {
      replies.push(String((extra && extra.caption) || ""));
      return { message_id: ++id };
    },
    telegram: { deleteMessage: async () => {} },
    answerCbQuery: async () => {},
  };
  ctx.live = ctx.session;
  listing._late.peek = () => ctx.live;
  return ctx;
}

/** The paste's own read, then the second look's — in that order. */
function reads(...answers) {
  const calls = [];
  listing._lookups.fetchTokenInfo = async (...a) => {
    calls.push(a);
    return answers[Math.min(calls.length - 1, answers.length - 1)];
  };
  return calls;
}

test("⚠️ THE REPORTED CARD: a read that missed the paste fills the logo, X, website and overview on the second look", async () => {
  const calls = reads(FIRST, FULL);
  const ctx = chat();
  await listing.handleText(ctx);
  await listing._late.started;
  const f = ctx.session.form;
  assert.strictEqual(f.logoUrl, FULL.logoUrl);
  assert.strictEqual(f.twitter, FULL.twitter);
  assert.strictEqual(f.website, FULL.website);
  assert.match(f.overview, /cat in a costume/, "the auto-written intro must give way to the project's own words");
  assert.strictEqual(calls.length, 2, "one paste read, one second look");
  const last = ctx.replies[ctx.replies.length - 1];
  assert.match(last, /kovra_sol/, `the review card was not re-rendered with the find: ${last}`);
});

test("⚠️ it NEVER holds the handler — Telegraf fetches no updates until the paste returns", async () => {
  reads(FIRST, FULL);
  let release;
  listing._late.wait = () => new Promise((r) => { release = r; });
  const ctx = chat();
  let t;
  await Promise.race([
    listing.handleText(ctx),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error("the paste waited on the second look — the whole bot is deaf for its schedule")), 1500); }),
  ]).finally(() => clearTimeout(t));
  assert.strictEqual(ctx.session.form.logoUrl, null, "nothing may be applied before the look runs");
  release();
  await listing._late.started;
  assert.strictEqual(ctx.session.form.logoUrl, FULL.logoUrl);
});

test("holes only: what the first read or the buyer filled is never overwritten", async () => {
  reads({ ...FIRST, twitter: "https://x.com/first_read" }, { ...FULL, twitter: "https://x.com/someone_else" });
  const ctx = chat();
  await listing.handleText(ctx);
  await listing._late.started;
  assert.strictEqual(ctx.session.form.twitter, "https://x.com/first_read");
  assert.strictEqual(ctx.session.form.logoUrl, FULL.logoUrl);
});

test("a typed overview is the buyer's words and is kept", () => {
  const f = { ...listing._test.emptyForm(), chain: "solana", name: "KOVRA", sym: "KVR", overview: "Our own words about the project, typed by hand." };
  const add = listing._lateAdditions(f, FULL);
  assert.ok("logoUrl" in add, "the vacuity check — the find itself must still be offered");
  assert.ok(!("overview" in add), JSON.stringify(add));
});

test("⚠️ a buyer who MOVED ON is never repainted — a new flow replaced the session", async () => {
  reads(FIRST, FULL);
  const ctx = chat();
  listing._late.wait = async () => { ctx.live = { type: "trending", latest_bot_message: 999 }; };
  await listing.handleText(ctx);
  const n = ctx.replies.length;
  const r = await listing._late.started;
  assert.strictEqual(r.applied, false);
  assert.strictEqual(ctx.replies.length, n, "a review card was sent over a new flow");
  assert.strictEqual(ctx.session.form.logoUrl, null);
});

test("an open edit prompt, or the tier card already on screen, also stops it", async () => {
  for (const move of [(s) => { s.awaitingField = "website"; }, (s) => { s.latest_bot_message = 4242; }]) {
    reads(FIRST, FULL);
    const ctx = chat();
    listing._late.wait = async () => move(ctx.live);
    await listing.handleText(ctx);
    const n = ctx.replies.length;
    const r = await listing._late.started;
    assert.strictEqual(r.applied, false, JSON.stringify(r));
    assert.strictEqual(ctx.replies.length, n);
  }
});

test("⚠️ the guard is asked AGAIN right before the send — a tap during the lookup wins", async () => {
  const ctx = chat();
  let n = 0;
  listing._lookups.fetchTokenInfo = async () => {
    n++;
    if (n === 1) return FIRST;
    ctx.live.latest_bot_message = 7777; // the buyer tapped Confirm while we were asking
    return FULL;
  };
  await listing.handleText(ctx);
  const before = ctx.replies.length;
  const r = await listing._late.started;
  assert.strictEqual(r.applied, false);
  assert.strictEqual(ctx.replies.length, before);
  assert.strictEqual(ctx.session.form.logoUrl, null);
});

test("only where it can help: another chain, a complete form, or a SETTLED answer with nothing new stop it", async () => {
  // Another chain — no second look at all.
  let calls = reads(FIRST, FULL);
  let ctx = chat({ chain: "ethereum" });
  ctx.message.text = "0x0000000000000000000000000000000000000001";
  await listing.handleText(ctx);
  const r0 = await listing._late.started;
  assert.strictEqual(r0.why, "not applicable");
  assert.strictEqual(calls.length, 1, "an EVM paste paid for a Solana second look");

  // A form that already has its art and a social — nothing to look for.
  calls = reads({ ...FIRST, logoUrl: "https://cdn.example/k.png", website: "https://kovra.fun" });
  ctx = chat();
  await listing.handleText(ctx);
  const r1 = await listing._late.started;
  assert.strictEqual(r1.why, "nothing missing");
  assert.strictEqual(calls.length, 1);

  // A settled chain answer with nothing new: ONE look, not the whole schedule.
  calls = reads(FIRST, FIRST);
  const realSettled = solanaMeta.settled;
  solanaMeta.settled = () => true;
  try {
    ctx = chat();
    listing._late.delays = () => [0, 0, 0];
    await listing.handleText(ctx);
    const r2 = await listing._late.started;
    assert.strictEqual(r2.why, "nothing new");
    assert.strictEqual(calls.length, 2, "a settled answer was asked again and again");
  } finally {
    solanaMeta.settled = realSettled;
  }
});

test("LISTING_LATE_FILL_MS=0 turns it off; blank is the default schedule, never no time at all", () => {
  const { execFileSync } = require("node:child_process");
  const probe = (v) =>
    execFileSync(process.execPath, ["-e", `process.env.LISTING_LATE_FILL_MS=${JSON.stringify(v)};console.log(JSON.stringify(require("./src/handlers/listing")._late.delays()))`], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, BOT_DATA_DIR: process.env.BOT_DATA_DIR },
    })
      .toString()
      .trim()
      .split("\n")
      .pop();
  assert.strictEqual(probe("0"), "[]");
  assert.strictEqual(probe(""), "[4000,15000]");
  assert.strictEqual(probe("2000,9000"), "[2000,9000]");
});

// ⚠️ THE GUARD IS ONLY AS GOOD AS ITS STORE. Every test above stubs `peek`; in
// production it reads the store telegraf's session middleware writes — which
// is the store ONLY if bot.js hands it over. Without that, `peek` answers
// undefined for ever and the second look silently never applies.
test("the main bot's session middleware writes the store the guard reads", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "bot.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /session\(\{\s*store:\s*sessionStore\.store,\s*getSessionKey:\s*generateSessionKey/, "bot.js no longer hands telegraf the shared store");
  assert.match(src, /const generateSessionKey = sessionStore\.key;/);
});

test("peek sees a WHOLESALE reassignment through telegraf's real session middleware — the case the guard exists for", async () => {
  const { session } = require("telegraf");
  const store = require("../src/helpers/sessionStore");
  const mw = session({ store: store.store, getSessionKey: store.key, defaultSession: () => ({}) });
  let upd = 0;
  const mk = () => ({ from: { id: 41 }, chat: { id: 41 }, update: { update_id: ++upd } });
  const first = mk();
  await mw(first, async () => { first.session.form = { address: MINT }; });
  const old = first.session;
  assert.strictEqual(store.peek(first), old, "the store must hold the object the update left");
  const second = mk();
  await mw(second, async () => { second.session = { type: "trending" }; }); // freshSession
  assert.notStrictEqual(store.peek(first), first.session, "through the OLD ctx the reassignment is invisible — peek must not be");
  assert.strictEqual(store.peek(first).type, "trending");
});

// ⚠️ IDENTITY, not resemblance. A session store that hands back a COPY (any
// persisted store) has a `form` that looks exactly like ours and is not the
// object the next tap will read — mutating ours would change nothing the buyer
// sees after the re-render, and the card would claim fields the order lacks.
test("a session that merely RESEMBLES this one (a copy) is not this one", async () => {
  reads(FIRST, FULL);
  const ctx = chat();
  listing._late.wait = async () => { ctx.live = JSON.parse(JSON.stringify(ctx.session)); };
  await listing.handleText(ctx);
  const n = ctx.replies.length;
  const r = await listing._late.started;
  assert.strictEqual(r.applied, false, JSON.stringify(r));
  assert.strictEqual(ctx.replies.length, n);
});
