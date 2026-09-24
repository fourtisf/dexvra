import test from "node:test";
import assert from "node:assert/strict";
import { blockscoutFor, countOf, readHolders } from "./holders.ts";

const SFX = "0x0a574aae41da077713ba32aa05ca151c8759e2f6";

type Call = { url: string };
const fakeFetch = (reply: (url: string) => Response | Promise<Response>, calls: Call[] = []) =>
  (async (url: string | URL) => {
    calls.push({ url: String(url) });
    return reply(String(url));
  }) as unknown as typeof fetch;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("⚠️ the reported token: Robinhood's Blockscout counts the holders and the page gets the NUMBER", async () => {
  const calls: Call[] = [];
  const r = await readHolders("robinhood", SFX, {
    fetch: fakeFetch(() => json({ holders_count: "1570" }), calls),
    gtGet: async () => { throw new Error("GT must not be asked when the explorer answered"); },
  });
  assert.deepEqual(r, { count: 1570, source: "blockscout", why: null });
  assert.equal(calls[0].url, `https://robinhoodchain.blockscout.com/api/v2/tokens/${SFX}`);
});

test("an older Blockscout spells it `holders` — same number", async () => {
  const r = await readHolders("robinhood", SFX, { fetch: fakeFetch(() => json({ holders: "42" })) });
  assert.equal(r.count, 42);
});

test("an explorer that fails falls through to GeckoTerminal — and GT is asked for a FREE slot only", async () => {
  let opts: { waitMs?: number } | undefined;
  let path = "";
  const r = await readHolders("robinhood", SFX, {
    fetch: fakeFetch(() => json({ message: "nope" }, 503)),
    gtGet: async (p, _q, o) => {
      path = p;
      opts = o;
      return { ok: true, status: 200, reason: null, body: { data: { attributes: { holders: { count: 1570 } } } } };
    },
  });
  assert.deepEqual(r, { count: 1570, source: "geckoterminal", why: null });
  assert.equal(path, `/networks/robinhood/tokens/${SFX}/info`);
  // ⚠️ A holder count is not worth one candle: GT is the scarce per-IP budget
  // every chart on the site shares, so this never QUEUES for a slot.
  assert.equal(opts?.waitMs, 0);
});

test("⚠️ nobody could answer → null with EVERY reason, never a 0", async () => {
  const r = await readHolders("robinhood", SFX, {
    fetch: fakeFetch(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }),
    gtGet: async () => ({ ok: false, status: 0, reason: "over this process's GeckoTerminal budget", body: null }),
  });
  assert.equal(r.count, null);
  assert.equal(r.source, null);
  assert.match(r.why ?? "", /blockscout unreachable \(ENOTFOUND\)/);
  assert.match(r.why ?? "", /geckoterminal: over this process/);
});

test("a chain with no explorer we read goes straight to GeckoTerminal (Solana)", async () => {
  const calls: Call[] = [];
  const r = await readHolders("solana", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", {
    fetch: fakeFetch(() => json({}), calls),
    gtGet: async () => ({ ok: true, status: 200, reason: null, body: { data: { attributes: { holders: { count: "812,000" } } } } }),
  });
  assert.equal(calls.length, 0, "no explorer request for a chain with no Blockscout");
  assert.deepEqual(r, { count: 812000, source: "geckoterminal", why: null });
});

test("countOf reads what an explorer spells, and refuses what it cannot", () => {
  assert.equal(countOf("1570"), 1570);
  assert.equal(countOf(1570), 1570);
  assert.equal(countOf("1,570"), 1570);
  assert.equal(countOf(0), 0, "a zero an explorer ANSWERED is a measurement");
  assert.equal(countOf(""), null, "…a blank is not (the Number('') rule)");
  assert.equal(countOf(null), null);
  assert.equal(countOf("n/a"), null);
  assert.equal(countOf(-3), null);
});

test("BLOCKSCOUT_<CHAIN>: 0 switches it off, a real host overrides, a placeholder is REFUSED", () => {
  const k = "BLOCKSCOUT_ROBINHOOD";
  const was = process.env[k];
  try {
    delete process.env[k];
    assert.equal(blockscoutFor("robinhood"), "https://robinhoodchain.blockscout.com");
    process.env[k] = "";
    assert.equal(blockscoutFor("robinhood"), "https://robinhoodchain.blockscout.com", "blank is ABSENT");
    process.env[k] = "0";
    assert.equal(blockscoutFor("robinhood"), null);
    process.env[k] = "https://explorer.example.org/";
    assert.equal(blockscoutFor("robinhood"), "https://explorer.example.org");
    // CLAUDE.md's first rule: a pasted blank must not replace a working default.
    for (const bad of ["https://your-explorer", "<explorer>", "https://explorer…", "http://explorer.example.org"]) {
      process.env[k] = bad;
      assert.equal(blockscoutFor("robinhood"), "https://robinhoodchain.blockscout.com", bad);
    }
    assert.equal(blockscoutFor("tron"), null, "no explorer configured → none");
  } finally {
    if (was === undefined) delete process.env[k];
    else process.env[k] = was;
  }
});
