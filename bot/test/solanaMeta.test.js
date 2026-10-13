// A Solana token's own metadata, read off the chain — the socials source a
// third party cannot refuse.
//
// Reported with BINWISE ($BWS, pump.fun, AHWEsrCE9hYNn8RomTbNNUUvgKVu6g3XU872asA4pump):
// the review card said "Website: not set · X: not set · Telegram: not set"
// about a token whose pump.fun page shows its X and its website. Every source
// the merge had was a third party over HTTP; the mint's own Metaplex record —
// whose uri document holds exactly those fields — was never asked.
//
// Driven, never read: the parsers are fed byte layouts built the way the
// programs write them, and the reader is driven end to end with its two
// network reads stubbed (`_deps`).
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-solmeta-"));
process.env.SOLANA_META = "1";

const test = require("node:test");
const assert = require("node:assert");
const { PublicKey } = require("@solana/web3.js");

const sm = require("../src/solanaMeta");
const ipfs = require("../src/helpers/ipfsGateways");
const { isTransportError } = require("../src/config/rpc");
const log = require("../src/helpers/logger");

const MINT = "AHWEsrCE9hYNn8RomTbNNUUvgKVu6g3XU872asA4pump";
const mintKey = new PublicKey(MINT);
const OTHER = new PublicKey("So11111111111111111111111111111111111111112");
const CID = "bafkreibinwiseexamplecidaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const URI = `https://ipfs.io/ipfs/${CID}`;

/** A borsh String, NUL-padded to `pad` the way Metaplex writes name/symbol/uri. */
const bstr = (s, pad) => {
  const b = Buffer.alloc(Math.max(pad || 0, Buffer.byteLength(s)));
  b.write(s);
  const l = Buffer.alloc(4);
  l.writeUInt32LE(b.length);
  return Buffer.concat([l, b]);
};

/** A Metaplex MetadataV1 account (key 4 · update authority · mint · data…). */
function metaplexAccount({ mint = mintKey, name = "BINWISE", symbol = "BWS", uri = URI, key = 4 } = {}) {
  return Buffer.concat([
    Buffer.from([key]),
    Buffer.alloc(32, 9),
    mint.toBuffer(),
    bstr(name, 32),
    bstr(symbol, 10),
    bstr(uri, 200),
    Buffer.from([0xf4, 0x01, 0x00]), // seller fee + no creators — the parser stops before these
  ]);
}

/** A Token-2022 mint with a MetadataPointer then a TokenMetadata extension. */
function token2022Mint({ mint = mintKey, name = "BINWISE", symbol = "BWS", uri = URI, extra = [] } = {}) {
  const tlv = (type, value) => {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(type, 0);
    h.writeUInt16LE(value.length, 2);
    return Buffer.concat([h, value]);
  };
  const count = Buffer.alloc(4);
  count.writeUInt32LE(extra.length);
  const meta = Buffer.concat([
    Buffer.alloc(32, 1),
    mint.toBuffer(),
    bstr(name),
    bstr(symbol),
    bstr(uri),
    count,
    ...extra.flatMap(([k, v]) => [bstr(k), bstr(v)]),
  ]);
  const base = Buffer.alloc(165); // 82-byte mint, padded to an Account's length
  return Buffer.concat([base, Buffer.from([1]), tlv(18, Buffer.alloc(64, 2)), tlv(19, meta)]);
}

const PUMP_DOC = {
  name: "BINWISE",
  symbol: "BWS",
  description: "BINWISE — the wise way to trade memes on Solana, built by the community.",
  image: `ipfs://${CID}`,
  showName: true,
  createdOn: "https://pump.fun",
  twitter: "https://x.com/binwise_sol",
  website: "https://binwise.xyz",
  telegram: "https://t.me/binwise",
};

const real = { ...sm._deps };
function stubDeps({ accounts, docs = {}, onRead } = {}) {
  const asked = { reads: 0, urls: [] };
  sm._deps.readAccounts = async (addrs, o) => {
    asked.reads++;
    asked.addrs = addrs;
    asked.opts = o;
    if (onRead) await onRead();
    if (accounts instanceof Error) throw accounts;
    return accounts;
  };
  sm._deps.fetchJson = async (u) => {
    asked.urls.push(u);
    const d = docs[u];
    if (typeof d === "function") return d();
    return d || { json: null, why: `${new URL(u).hostname}: HTTP 404`, flaky: false };
  };
  return asked;
}
test.beforeEach(() => sm._reset());
test.after(() => Object.assign(sm._deps, real));

const META = { owner: sm.METADATA_PROGRAM, data: metaplexAccount() };
const PLAIN_MINT = { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: Buffer.alloc(82) };

// ── Parsing ─────────────────────────────────────────────────────────────────

test("a Metaplex account is read for THIS mint only — the NUL padding is stripped", () => {
  const r = sm._test.parseMetaplex(metaplexAccount(), mintKey.toBuffer());
  assert.deepStrictEqual({ name: r.name, symbol: r.symbol, uri: r.uri }, { name: "BINWISE", symbol: "BWS", uri: URI });
  assert.strictEqual(sm._test.parseMetaplex(metaplexAccount({ mint: OTHER }), mintKey.toBuffer()), null, "a record about another mint is another token's socials");
  assert.strictEqual(sm._test.parseMetaplex(metaplexAccount({ key: 6 }), mintKey.toBuffer()), null, "only MetadataV1");
});

test("a Token-2022 mint's own metadata extension is read past the pointer, additional pairs included", () => {
  const r = sm._test.parseToken2022(token2022Mint({ extra: [["Twitter", "https://x.com/t22"]] }), mintKey.toBuffer());
  assert.strictEqual(r.name, "BINWISE");
  assert.strictEqual(r.uri, URI);
  assert.strictEqual(r.extra.twitter, "https://x.com/t22", "keys are matched case-insensitively");
  assert.strictEqual(sm._test.parseToken2022(token2022Mint({ mint: OTHER }), mintKey.toBuffer()), null);
  assert.strictEqual(sm._test.parseToken2022(Buffer.alloc(82), mintKey.toBuffer()), null, "a plain mint has no extensions");
});

test("a length that cannot fit is a mis-parse, never a megabyte of garbage", () => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(0xffffff, 0);
  assert.strictEqual(sm._test.readString(b, 0), null);
});

// ── Extraction ──────────────────────────────────────────────────────────────

test("a pump.fun document yields the website, X, Telegram, overview and logo the form asks for", () => {
  const i = sm._test.extract(PUMP_DOC, { name: "BINWISE", symbol: "BWS", extra: {} });
  assert.strictEqual(i.website, "https://binwise.xyz");
  assert.strictEqual(i.twitter, "https://x.com/binwise_sol");
  assert.strictEqual(i.telegram, "https://t.me/binwise");
  assert.match(i.description, /wise way to trade/);
  assert.match(i.logoUrl, /^https:\/\/.+\/ipfs\/bafkrei/, "an ipfs:// image is rewritten to a url the site accepts");
  assert.strictEqual(i.source, "solana-meta");
  for (const k of ["priceUsd", "mcap", "liq", "vol24", "pairCreatedAt"]) {
    assert.ok(!(k in i), `${k}: display metadata only — the gates' fields are ABSENT so a merge can never fill one`);
  }
});

test("the other shapes the standard tools write: `extensions`, bare domains, bare handles", () => {
  const i = sm._test.extract(
    { extensions: { website: "binwise.xyz", twitter: "@binwise_sol", telegram: "t.me/binwise" } },
    { name: "B", symbol: "B", extra: {} },
  );
  assert.strictEqual(i.website, "https://binwise.xyz");
  assert.strictEqual(i.twitter, "https://x.com/binwise_sol");
  assert.strictEqual(i.telegram, "https://t.me/binwise");
});

test("⚠️ a link is kept only where its label says it goes — a 'twitter' to another site is refused", () => {
  const i = sm._test.extract({ twitter: "https://evil.example/login", telegram: "https://x.com/notatg" }, { extra: {} });
  assert.strictEqual(i.twitter, null, "a buyer taps 'X:' believing it is the project's X");
  assert.strictEqual(i.telegram, null);
});

test("a launchpad's own url in external_url is where the token was MADE, not its website", () => {
  assert.strictEqual(sm._test.extract({ external_url: "https://pump.fun/coin/x" }, { extra: {} }).website, null);
  assert.strictEqual(sm._test.extract({ external_url: "https://launch.example", createdOn: "https://launch.example" }, { extra: {} }).website, null);
  assert.strictEqual(sm._test.extract({ external_url: "https://binwise.xyz" }, { extra: {} }).website, "https://binwise.xyz");
});

// ── The reader, driven ──────────────────────────────────────────────────────

test("BINWISE: one RPC request for both accounts, then the document across the ladder — the socials arrive", async () => {
  const ladder = ipfs.candidates(URI, 4);
  const asked = stubDeps({
    accounts: [META, PLAIN_MINT],
    docs: {
      [ladder[0]]: { json: null, why: "ipfs.io: HTTP 504", flaky: true },
      [ladder[1]]: { json: PUMP_DOC, why: null, flaky: false },
    },
  });
  const r = await sm.fetchTokenInfoX("solana", MINT, { budgetMs: 4000 });
  assert.strictEqual(r.ok, true, r.why);
  assert.strictEqual(r.info.twitter, "https://x.com/binwise_sol");
  assert.strictEqual(r.info.website, "https://binwise.xyz");
  assert.strictEqual(asked.reads, 1, "the metadata PDA and the mint ride ONE getMultipleAccounts");
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), new PublicKey(sm.METADATA_PROGRAM).toBuffer(), mintKey.toBuffer()],
    new PublicKey(sm.METADATA_PROGRAM),
  );
  assert.deepStrictEqual(asked.addrs, [pda.toBase58(), MINT]);
  assert.deepStrictEqual(asked.urls.slice(0, 2), ladder.slice(0, 2), "the uri's own gateway first, pump.fun's pin next");
});

test("a Token-2022 mint's own metadata outranks a Metaplex record", async () => {
  const t22 = { owner: sm.TOKEN_2022, data: token2022Mint({ name: "FROMMINT" }) };
  stubDeps({ accounts: [META, t22], docs: { [URI]: { json: PUMP_DOC } } });
  const r = await sm.fetchTokenInfoX("solana", MINT);
  assert.strictEqual(r.info.name, "FROMMINT");
});

test("⚠️ an account owned by anyone else is not believed, whatever its bytes say", async () => {
  stubDeps({ accounts: [{ owner: "11111111111111111111111111111111", data: metaplexAccount() }, PLAIN_MINT], docs: { [URI]: { json: PUMP_DOC } } });
  const r = await sm.fetchTokenInfoX("solana", MINT);
  assert.strictEqual(r.info, null);
  assert.strictEqual(r.ok, true);
});

test("⚠️ an RPC we could not ask is NOT cached, and says why — with the syscall code", async (t) => {
  const lines = [];
  const orig = log.info;
  log.info = (m) => lines.push(String(m));
  t.after(() => (log.info = orig));
  const err = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
  const asked = stubDeps({ accounts: err });
  const a = await sm.fetchTokenInfoX("solana", MINT);
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.info, null);
  assert.match(a.why, /Solana RPC .*ENOTFOUND/);
  await sm.fetchTokenInfoX("solana", MINT);
  assert.strictEqual(asked.reads, 2, "a refusal is never remembered as 'this mint has no metadata'");
  assert.match(sm.lastWhy(MINT), /ENOTFOUND/);
  assert.ok(lines.some((l) => /\[solana-meta\].*could not read/.test(l)), "production prints INFO, not debug");
});

test("an ANSWER is remembered, and concurrent pastes share one read", async () => {
  const asked = stubDeps({ accounts: [META, PLAIN_MINT], docs: { [URI]: { json: PUMP_DOC } }, onRead: () => new Promise((r) => setTimeout(r, 20)) });
  const [a, b] = await Promise.all([sm.fetchTokenInfoX("solana", MINT), sm.fetchTokenInfoX("solana", MINT)]);
  assert.strictEqual(asked.reads, 1, "two pastes of one mint in flight are one request");
  assert.deepStrictEqual(a, b);
  await sm.fetchTokenInfoX("solana", MINT);
  assert.strictEqual(asked.reads, 1, "a decided answer is cached");
});

test("a document that answered and is unusable keeps the on-chain name — and says which", async () => {
  stubDeps({ accounts: [META, PLAIN_MINT] }); // every gateway answers 404 (not flaky)
  const r = await sm.fetchTokenInfoX("solana", MINT);
  assert.strictEqual(r.ok, true, "an answer about the document, not a bad minute");
  assert.strictEqual(r.info.name, "BINWISE");
  assert.strictEqual(r.info.twitter, null);
  assert.match(r.why, /metadata document is unusable/);
});

test("every gateway refusing us is 'could not be read' — ok:false, never cached", async () => {
  const flaky = () => ({ json: null, why: "HTTP 429", flaky: true });
  const docs = Object.fromEntries(ipfs.candidates(URI, 4).map((u) => [u, flaky]));
  const asked = stubDeps({ accounts: [META, PLAIN_MINT], docs });
  const r = await sm.fetchTokenInfoX("solana", MINT);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.info.name, "BINWISE", "the on-chain half still reaches the form");
  assert.match(r.why, /could not be read/);
  await sm.fetchTokenInfoX("solana", MINT);
  assert.strictEqual(asked.reads, 2);
});

test("the document read is HEDGED: a gateway that hangs does not cost the one behind it", async () => {
  const cands = ipfs.candidates(URI, 4);
  const docs = { [cands[0]]: () => new Promise(() => {}), [cands[1]]: { json: PUMP_DOC } };
  const fetchJson = async (u) => (typeof docs[u] === "function" ? docs[u]() : docs[u] || { json: null, why: "404", flaky: false });
  const timers = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  const before = timers();
  const t0 = Date.now();
  const r = await sm._test.readDocument(URI, { deadlineMs: 2000, staggerMs: 30, fetchJson });
  assert.ok(r.json, r.why);
  assert.ok(Date.now() - t0 < 1000, "the second gateway started on the stagger, not after the first gave up");
  // ⚠️ The deadline is NOT unref'd (a caller waits on it), so a read that won
  // early must clear it — or a 2s budget holds the loop open 2s past a 30ms
  // answer, on every paste.
  assert.ok(timers() <= before, "the deadline and stagger timers are cleared on the winning path");
});

test("…and the deadline holds over gateways that all hang — with its timers cleared", async () => {
  const before = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  const r = await sm._test.readDocument(URI, { deadlineMs: 120, staggerMs: 20, fetchJson: () => new Promise(() => {}) });
  assert.strictEqual(r.json, null);
  assert.strictEqual(r.flaky, true);
  assert.match(r.why, /within 120ms/);
  const after = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  assert.ok(after <= before, "a settled read leaves no timer holding the loop open");
});

test("a budgeted read leaves the merge time to use it — the RPC never gets the whole clock", async () => {
  const asked = stubDeps({ accounts: [META, PLAIN_MINT], docs: { [URI]: { json: PUMP_DOC } } });
  await sm.fetchTokenInfoX("solana", MINT, { budgetMs: 7250 });
  assert.ok(asked.opts.budgetMs < 7250 / 2, `RPC budget ${asked.opts.budgetMs}ms leaves no room for the document`);
  assert.ok(asked.opts.timeoutMs <= asked.opts.budgetMs);
});

test("a refusal by an RPC host reads as a TRANSPORT error, so the next endpoint is asked", async (t) => {
  const orig = global.fetch;
  t.after(() => (global.fetch = orig));
  for (const status of [401, 403, 429]) {
    global.fetch = async () => ({ ok: false, status, json: async () => ({}) });
    const e = await sm._test.rpcPost("https://rpc.example", "getMultipleAccounts", [], 500).catch((x) => x);
    assert.ok(isTransportError(e), `${status}: ${e.message}`);
  }
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: { code: -32429, message: "Too many requests" } }) });
  assert.ok(isTransportError(await sm._test.rpcPost("https://rpc.example", "x", [], 500).catch((x) => x)));
});

test("not a key is an answer about the paste; another chain is not asked at all", async () => {
  const asked = stubDeps({ accounts: [META, PLAIN_MINT] });
  assert.deepStrictEqual(await sm.fetchTokenInfoX("solana", "not-a-mint!!"), { ok: true, why: "not a Solana address", info: null });
  assert.deepStrictEqual(await sm.fetchTokenInfoX("bsc", "0x" + "1".repeat(40)), { ok: true, why: null, info: null });
  assert.strictEqual(asked.reads, 0);
});

test("SOLANA_META=0 turns it off; blank and absent are ON (the production default)", () => {
  const had = process.env.SOLANA_META;
  try {
    process.env.SOLANA_META = "0";
    assert.strictEqual(sm.covers("solana"), false);
    process.env.SOLANA_META = "";
    assert.strictEqual(sm.covers("solana"), true);
    delete process.env.SOLANA_META;
    assert.strictEqual(sm.covers("solana"), true);
  } finally {
    process.env.SOLANA_META = had;
  }
});

test("the bot's IPFS ladder is a PORT of the site's, and the two default lists are EQUAL", () => {
  const ts = fss.readFileSync(path.join(__dirname, "..", "..", "src", "lib", "ipfsGateways.ts"), "utf8");
  const block = ts.slice(ts.indexOf("export const IPFS_GATEWAYS"), ts.indexOf("export function ipfsPath"));
  const site = [...block.replace(/^\s*\/\/.*$/gm, "").matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(site.length >= 3, "vacuity: the site's list was not found — this guard would pass on anything");
  assert.deepStrictEqual(ipfs.DEFAULTS, site, "two ladders disagreeing is how pump.fun's own pin went missing once");
});
