// The suite is offline BY CONSTRUCTION (scripts/offline-guard.js, preloaded by
// scripts/run-tests.js). It used to be offline by accident: the dev sandbox has
// no egress, so a test that forgot a stub passed there and failed in CI, where
// the real DexScreener answered. These assert the guard is ACTIVE — by its own
// message, because a request that fails for some OTHER reason (a sandbox proxy
// refusing it) proves nothing about the guard.
// This file reaches for the internet ON PURPOSE, so it stays out of the
// runner's leak report — a permanent entry there would teach its reader to
// skim past the list that exists to catch the real ones.
delete process.env.TEST_NET_LOG;
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const https = require("node:https");

test("fetch to a real host is refused, fast, as a transport error that names the guard", async () => {
  const t0 = Date.now();
  const err = await fetch("https://api.dexscreener.com/latest/dex/tokens/x").then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "a request to the internet must not succeed in the test suite");
  assert.strictEqual(err.message, "fetch failed", "the shape undici gives a dead network");
  assert.strictEqual(err.cause && err.cause.code, "ECONNREFUSED");
  assert.match(String(err.cause.message), /test suite is offline/, "the guard is what refused it — run the suite through scripts/run-tests.js");
  assert.ok(Date.now() - t0 < 1000, "refused immediately, not after a timeout");
});

test("http/https to a real host fail as an ordinary ECONNREFUSED", async () => {
  for (const mod of [https, http]) {
    const code = await new Promise((resolve) => {
      const req = mod.get(`${mod === https ? "https" : "http"}://example.com/`, () => resolve("answered"));
      req.on("error", (e) => resolve(e.code));
    });
    assert.strictEqual(code, "ECONNREFUSED");
  }
});

test("a LOCAL server still answers — several tests stand one up on purpose", async (t) => {
  const srv = http.createServer((_, res) => res.end("ok"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const { port } = srv.address();
  assert.strictEqual(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "ok");
  const viaHttp = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/`, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(b));
    }).on("error", reject);
  });
  assert.strictEqual(viaHttp, "ok");
});
