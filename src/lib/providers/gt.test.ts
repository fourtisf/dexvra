// The shared GeckoTerminal client. The live failure it was written for: the
// server answered `(GeckoTerminal 429)` and a bare curl from the same box did
// too — the IP was over its quota, and the web app had SIX modules taking turns
// discovering that independently.
import test from "node:test";
import assert from "node:assert/strict";

process.env.GT_MIN_GAP_MS = "0"; // the pacing gap is not what these pin
const { _gtReset, gtArmCooldown, gtBaseFor, gtGet, gtHeadersFor, gtInCooldown } = await import("./gt.ts");

const withFetch = async (impl: typeof fetch, fn: () => Promise<void>) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
};
const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test.beforeEach(_gtReset);

test("an API key switches the base AND sends the header — the only real way past the ceiling", () => {
  // Same variable the bot reads, so one line in the server's env serves both
  // processes on that IP.
  assert.equal(gtBaseFor(""), "https://api.geckoterminal.com/api/v2");
  assert.equal(gtBaseFor("k3y"), "https://pro-api.coingecko.com/api/v3/onchain");
  assert.deepEqual(gtHeadersFor("k3y")["x-cg-pro-api-key"], "k3y");
  assert.ok(!("x-cg-pro-api-key" in gtHeadersFor("")), "no empty header when there is no key");
});

test("an explicit base pins the host and skips the choice", () => {
  assert.equal(gtBaseFor("k3y", "https://gt.internal/v2/"), "https://gt.internal/v2", "trailing slash trimmed");
});

test("a success carries the body and no reason", async () => {
  await withFetch(async () => reply(200, { data: [1] }), async () => {
    const r = await gtGet<{ data: number[] }>("/networks/solana/tokens/x");
    assert.equal(r.ok, true);
    assert.deepEqual(r.body?.data, [1]);
    assert.equal(r.reason, null);
  });
});

test("⚠️ a 429 silences EVERY caller, and the next one makes no request at all", async () => {
  // "Two modules with their own fetch and their own backoff means one of them
  // keeps hammering through a 429 that the other has already noticed" — the
  // bot's client, about two. The web app had six.
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return reply(429, {});
    },
    async () => {
      const first = await gtGet("/networks/solana/tokens/a");
      assert.equal(first.status, 429);
      assert.match(first.reason ?? "", /429/);
      assert.equal(gtInCooldown(), true);

      const second = await gtGet("/networks/solana/pools/b/trades");
      assert.equal(second.status, 0, "no request was made");
      assert.match(second.reason ?? "", /cooling down/);
    },
  );
  assert.equal(calls, 1, "one request, not one per caller");
});

test("the cooldown honours Retry-After when GeckoTerminal sends one", async () => {
  await withFetch(async () => reply(429, {}, { "retry-after": "300" }), async () => {
    await gtGet("/x");
  });
  // 300s is far past the 120s default — the upstream's own number wins.
  assert.ok(gtInCooldown(Date.now() + 200_000), "still cooling at +200s");
});

test("a 5xx does NOT arm it — one bad pool must not take the whole site down", async () => {
  // The cooldown is process-wide; a per-request failure says nothing about our
  // quota. 429 is the only status that means "all of you, stop".
  await withFetch(async () => reply(503, {}), async () => {
    const r = await gtGet("/x");
    assert.equal(r.status, 503);
    assert.equal(gtInCooldown(), false);
  });
});

test("a dead socket does not arm it either, and still names the syscall", async () => {
  await withFetch(
    async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
    },
    async () => {
      const r = await gtGet("/x");
      assert.equal(r.status, 0);
      assert.match(r.reason ?? "", /fetch failed: ECONNRESET/);
      assert.equal(gtInCooldown(), false, "a timeout is not a rate limit");
    },
  );
});

test("a 404 is an answer, not a silence", async () => {
  await withFetch(async () => reply(404, {}), async () => {
    const r = await gtGet("/x");
    assert.equal(r.status, 404, "callers key their 'not indexed' branch off this");
    assert.equal(gtInCooldown(), false);
  });
});

test("the cooldown only ever extends, never shortens", async () => {
  gtArmCooldown(300_000);
  gtArmCooldown(1000);
  assert.ok(gtInCooldown(Date.now() + 200_000), "a short arm must not cancel a long one");
});
