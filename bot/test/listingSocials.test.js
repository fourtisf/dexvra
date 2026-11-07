// "bot tidak detect socials nya pdahal tokenya ada website dan x" — the form,
// DRIVEN through the real discovery merge, with every third party answering
// the way it does on the box: DexScreener has a pair and no profile (no
// socials), the launchpad registry refuses us. The token's own on-chain
// metadata is the source that fills the card.
//
// ⚠️ A POSITIVE test, because a wiring that does nothing refuses beautifully —
// the `curveBuyPath` scar. A unit test of solanaMeta passes on a form that
// never asks it.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-listsocials-"));
process.env.SOLANA_META = "1";

const test = require("node:test");
const assert = require("node:assert");

const stub = (request, exports) => {
  const resolved = require.resolve(request);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const MINT = "AHWEsrCE9hYNn8RomTbNNUUvgKVu6g3XU872asA4pump";
const asked = { ds: 0, pads: 0 };
// A pump.fun pair with no paid profile: name and ticker, and an empty `info`.
const NO_PROFILE = { name: "BINWISE", symbol: "BWS", logoUrl: null, website: null, twitter: null, telegram: null, priceUsd: 0.0001, mcap: 9000, liq: 4000, vol24: 100, pairCreatedAt: 1, pairCount: 1 };
let dsInfo = NO_PROFILE;
stub("../src/dexscreener", {
  fetchTokenInfoX: async () => {
    asked.ds++;
    return { info: { ...dsInfo }, ok: true, why: null };
  },
  fetchTokenInfo: async () => null,
  fetchDiscoveryX: async () => ({ items: [], ok: true, why: null }),
  DEX_SLUG: {},
});
stub("../src/launchpads", {
  covers: () => true,
  padsFor: () => [],
  // pump.fun's API refusing a datacenter IP — the pad answers nothing.
  fetchTokenInfo: async () => {
    asked.pads++;
    return null;
  },
  fetchDescription: async () => null,
  // What the real shim remembers from the registry's per-pad answers.
  lastWhy: () => "pumpfun: answered: never heard of it (frontend-api-v3.pump.fun) — said: answered 404 — Coin not found",
});

const sm = require("../src/solanaMeta");
const discovery = require("../src/discovery");
const listing = require("../src/handlers/listing");
const listedGuard = require("../src/helpers/listedGuard");
const log = require("../src/helpers/logger");

const DOC = {
  name: "BINWISE",
  symbol: "BWS",
  description: "BINWISE — the wise way to trade memes on Solana, built by the community.",
  createdOn: "https://pump.fun",
  twitter: "https://x.com/binwise_sol",
  website: "https://binwise.xyz",
  telegram: "https://t.me/binwise",
};
const CID = "bafkreibinwiseexamplecidaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** A Metaplex MetadataV1 account for MINT whose uri is the document above. */
function metaplex() {
  const { PublicKey } = require("@solana/web3.js");
  const bstr = (s, pad) => {
    const b = Buffer.alloc(Math.max(pad, Buffer.byteLength(s)));
    b.write(s);
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    return Buffer.concat([l, b]);
  };
  return Buffer.concat([Buffer.from([4]), Buffer.alloc(32, 9), new PublicKey(MINT).toBuffer(), bstr("BINWISE", 32), bstr("BWS", 10), bstr(`https://ipfs.io/ipfs/${CID}`, 200)]);
}

const realDeps = { ...sm._deps };
const realLookups = { ...listing._lookups };
const realBlock = listedGuard.blockIfListed;
let reads = 0;
/** pump.fun's BondingCurve account with `sold` of the curve gone. */
function curve(sold) {
  const b = Buffer.alloc(8 + 40 + 1 + 32);
  Buffer.from(sm._test.PUMP_CURVE_DISC).copy(b, 0);
  b.writeBigUInt64LE(BigInt(Math.round(793100000000000 * (1 - sold))), 24);
  return { owner: sm.PUMP_PROGRAM, data: b };
}
function chainAnswers(ok = true, curveAcct = null) {
  sm._deps.readAccounts = async () => {
    reads++;
    if (!ok) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return [{ owner: sm.METADATA_PROGRAM, data: metaplex() }, null, curveAcct];
  };
  sm._deps.fetchJson = async () => ({ json: DOC, why: null, flaky: false });
}
test.beforeEach(() => {
  dsInfo = NO_PROFILE;
  sm._reset();
  reads = 0;
  Object.assign(listing._lookups, realLookups);
  listing._lookups.fetchMarket = async () => null;
  listing._lookups.fetchTokenDescription = async () => null; // GT and the pad both silent
  listedGuard.blockIfListed = async () => false;
});
test.after(() => {
  Object.assign(sm._deps, realDeps);
  Object.assign(listing._lookups, realLookups);
  listedGuard.blockIfListed = realBlock;
});

function ctxWith(session, msgText) {
  const replies = [];
  return {
    replies,
    chat: { id: 7, type: "private" },
    from: { id: 7 },
    session,
    message: { text: msgText },
    reply: async (t, extra) => (replies.push({ text: String(t), extra }), { message_id: replies.length }),
    replyWithPhoto: async (photo, extra) => (replies.push({ photo, text: String((extra && extra.caption) || "") }), { message_id: replies.length }),
    telegram: { deleteMessage: async () => {} },
    answerCbQuery: async () => {},
  };
}
const form = () => ({ ...listing._test.emptyForm(), chain: "solana" });

test("BINWISE: the review card gets its website, X, Telegram and overview from the mint's own metadata", async () => {
  chainAnswers(true);
  const ctx = ctxWith({ type: "xpress_listing", form: form(), awaitingField: "address" }, MINT);
  await listing.handleText(ctx);
  const f = ctx.session.form;
  assert.strictEqual(f.website, "https://binwise.xyz");
  assert.strictEqual(f.twitter, "https://x.com/binwise_sol");
  assert.strictEqual(f.telegram, "https://t.me/binwise");
  assert.match(String(f.overview || ""), /wise way to trade/, "the project's own words, not the auto-written intro");
  assert.strictEqual(f.sym, "BWS");
  assert.strictEqual(reads, 1);
  assert.ok(asked.ds >= 1 && asked.pads >= 1, "the third parties are still asked first");
});

test("the review card says the token is still bonding — from the CURVE, while pump.fun's API says nothing", async () => {
  // The box: `pumpfun answered: never heard of it (frontend-api-v3.pump.fun)`
  // and "phase unknown — no pad said". The chain states the phase anyway.
  chainAnswers(true, curve(0.25));
  const ctx = ctxWith({ type: "xpress_listing", form: form(), awaitingField: "address" }, MINT);
  await listing.handleText(ctx);
  const b = ctx.session.form.bonding;
  assert.ok(b, "no bonding line — the pads were silent and the chain was not consulted for the phase");
  assert.ok(Math.abs(b.progressPct - 25) < 1e-6, `25% sold read as ${b.progressPct}`);
  assert.strictEqual(b.launchpad, "pump.fun");
  assert.strictEqual(reads, 1, "the curve rode the metadata request — no second RPC call");
});

test("⚠️ the indexer keeps precedence — the chain only fills what it left blank", async () => {
  chainAnswers(true);
  // A paid DexScreener profile that DISAGREES with the mint: the profile wins
  // where it answered; the chain fills only the holes it left.
  dsInfo = { ...NO_PROFILE, name: "Binwise Official", twitter: "https://x.com/binwise_profile" };
  const info = await discovery.fetchTokenInfo("solana", MINT, { chainMeta: true });
  assert.strictEqual(info.name, "Binwise Official");
  assert.strictEqual(info.twitter, "https://x.com/binwise_profile");
  assert.strictEqual(info.priceUsd, 0.0001, "the market fields are DexScreener's");
  assert.strictEqual(info.website, "https://binwise.xyz", "…and the hole is filled from the chain");
  assert.match(info.source, /^dexscreener\+.*solana-meta$/, "every contributor is named — DexScreener's part used to vanish from the provenance");
});

test("⚠️ OPT-IN: the auto-lister and the audit (no `chainMeta`) never pay for an RPC read", async () => {
  chainAnswers(true);
  const info = await discovery.fetchTokenInfo("solana", MINT);
  assert.strictEqual(reads, 0, "a scan of forty candidates would pay forty RPC reads for fields it never renders");
  assert.strictEqual(info.twitter, null);
});

test("a form that still has no socials SAYS WHY, naming the chain's own reason", async (t) => {
  chainAnswers(false);
  const lines = [];
  const orig = log.info;
  log.info = (m) => lines.push(String(m));
  t.after(() => (log.info = orig));
  const ctx = ctxWith({ type: "xpress_listing", form: form(), awaitingField: "address" }, MINT);
  await listing.handleText(ctx);
  assert.strictEqual(ctx.session.form.twitter, null);
  const line = lines.find((l) => l.startsWith("[listing] autofill"));
  assert.ok(line, `no diagnosis line: ${lines.join(" | ")}`);
  assert.match(line, /no website, X or Telegram/);
  assert.match(line, /on-chain metadata: could not read .*ECONNREFUSED/, "'the chain could not be asked' is not 'the creator wrote none'");
  // …and what each launchpad SAID. "merged from launchpad:jupiter" named only
  // the pads that answered, so pump.fun refusing this box read exactly like
  // pump.fun never having heard of the mint.
  assert.match(line, /launchpads that did not know it: pumpfun: .*Coin not found/, "the line dropped what pump.fun answered");
});
