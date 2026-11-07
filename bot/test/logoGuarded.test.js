// fetchLogoUrlX — the ONE function every banner, every logo repair and
// post:check reads a logo through — and the host our own proxy refuses.
//
// `$W` (Wormhole Token) went out drawing the Dexvra mark because
// `https://wormhole.com/token.png` is not on /api/logo's allowlist: the proxy
// answered 400 and this stopped there. A refusal BY OUR ALLOWLIST is now read
// through helpers/safeImage — and the rules that kept this safe still hold:
// a raw `fetch(logoUrl)` is never made for a refusal, and an answer about the
// FILE (a 404 from every gateway) does not reach for the project's host.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-logoguard-"));

const test = require("node:test");
const assert = require("node:assert");
const f = require("../src/fulfillment");
const safeImage = require("../src/helpers/safeImage");
const log = require("../src/helpers/logger");

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(30, 1)]);
const WORMHOLE = "https://wormhole.com/token.png";
const isProxy = (u) => u.includes("/api/logo?u=");

/** Proxy answers `proxy` = {status, why}; anything else is a raw fetch, recorded. */
function stub(t, { proxy, guarded }) {
  const orig = { fetch: global.fetch, fi: safeImage.fetchImage, warn: log.warn };
  const raw = [];
  const direct = [];
  const warns = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (!isProxy(u)) {
      raw.push(u);
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => PNG };
    }
    if (proxy === undefined) throw new Error("ECONNREFUSED");
    return {
      ok: proxy.status === 200,
      status: proxy.status,
      headers: { get: (k) => (k === "x-logo-why" ? proxy.why || null : null) },
      arrayBuffer: async () => (proxy.status === 200 ? PNG : new ArrayBuffer(0)),
    };
  };
  safeImage.fetchImage = async (u) => (direct.push(u), guarded);
  log.warn = (m) => warns.push(String(m));
  t.after(() => {
    global.fetch = orig.fetch;
    safeImage.fetchImage = orig.fi;
    log.warn = orig.warn;
  });
  return { raw, direct, warns };
}

test("$W: a host our allowlist refuses (400, no reason) is read through the GUARD — and the banner gets bytes", async (t) => {
  const s = stub(t, { proxy: { status: 400 }, guarded: { bytes: PNG, ext: "png", mime: "image/png", why: null } });
  const r = await f.fetchLogoUrlX(WORMHOLE);
  assert.ok(r.bytes && r.bytes.length, "the project's own artwork must reach the banner");
  assert.strictEqual(r.source, "guarded");
  assert.deepStrictEqual(s.direct, [WORMHOLE]);
  assert.deepStrictEqual(s.raw, [], "⚠️ a refusal is NEVER fetched raw — only through helpers/safeImage");
  assert.strictEqual(s.warns.length, 0, "a logo that loaded is not a banner falling back");
});

test("an answer about the FILE (every gateway 404'd, with a reason) does not reach for the project's host", async (t) => {
  const s = stub(t, { proxy: { status: 404, why: "ipfs.io: HTTP 404 after 30ms" }, guarded: { bytes: PNG } });
  const r = await f.fetchLogoUrlX("https://ipfs.io/ipfs/bafkreimissing");
  assert.strictEqual(r.bytes, null);
  assert.deepStrictEqual(s.direct, [], "the guard is for OUR refusal, not for a file that is not there");
  assert.deepStrictEqual(s.raw, []);
});

test("a refused host that the guard also cannot read says WHY on the warn, and carries it back", async (t) => {
  const s = stub(t, { proxy: { status: 400 }, guarded: { bytes: null, why: "wormhole.com: HTTP 404", flaky: false } });
  const r = await f.fetchLogoUrlX(WORMHOLE);
  assert.strictEqual(r.bytes, null);
  assert.strictEqual(r.guardedWhy, "wormhole.com: HTTP 404");
  assert.strictEqual(r.guardedFlaky, false);
  assert.match(s.warns.join("\n"), /its own host, fetched directly: wormhole\.com: HTTP 404/);
});

test("`quiet` keeps a PROBE off the ops channel — one candidate failing is not a banner falling back", async (t) => {
  const s = stub(t, { proxy: { status: 400 }, guarded: { bytes: null, why: "x", flaky: false } });
  await f.fetchLogoUrlX(WORMHOLE, { quiet: true });
  assert.strictEqual(s.warns.length, 0);
});

test("a proxy that cannot be REACHED still falls through to the plain read, exactly as before — and not to the guard", async (t) => {
  const s = stub(t, { proxy: undefined, guarded: { bytes: PNG } });
  const r = await f.fetchLogoUrlX(WORMHOLE);
  assert.ok(r.bytes);
  assert.strictEqual(r.source, "direct");
  assert.deepStrictEqual(s.direct, []);
  assert.deepStrictEqual(s.raw, [WORMHOLE]);
});
