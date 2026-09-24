import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { blockscoutFor, blockscoutHosts, countOf, dsHolderCount, dsHolderPaths, readHolders } from "./holders.ts";
import { _dsChartReset, dsInCooldown } from "./dsChart.ts";

const SFX = "0x0a574aae41da077713ba32aa05ca151c8759e2f6";
const RH1 = "https://robinhoodchain.blockscout.com";
const RH2 = "https://explorer.mainnet.chain.robinhood.com";
const PAIR = { pairAddress: "0xabc123", dexId: "uniswap", chainId: "robinhood", liquidityUsd: 87_700 };

type Call = { url: string; headers: Record<string, string> };
const fakeFetch = (reply: (url: string) => Response | Promise<Response>, calls: Call[] = []) =>
  (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return reply(String(url));
  }) as unknown as typeof fetch;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const down = () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); };
const noPair = async () => ({ ok: true, pair: null, why: "DexScreener has no pair for this token" });
const gtNone = async () => ({ ok: false, status: 0, reason: "over this process's GeckoTerminal budget", body: null });

beforeEach(() => _dsChartReset());

test("⚠️ the reported token: Robinhood's Blockscout counts the holders and the page gets the NUMBER", async () => {
  const calls: Call[] = [];
  const r = await readHolders("robinhood", SFX, {
    fetch: fakeFetch(() => json({ holders_count: "1570" }), calls),
    gtGet: async () => { throw new Error("GT must not be asked when the explorer answered"); },
  });
  assert.deepEqual(r, { count: 1570, source: "blockscout", via: "robinhoodchain.blockscout.com", why: null });
  assert.equal(calls[0].url, `${RH1}/api/v2/tokens/${SFX}`);
});

test("an older Blockscout spells it `holders` — same number", async () => {
  const r = await readHolders("robinhood", SFX, { fetch: fakeFetch(() => json({ holders: "42" })) });
  assert.equal(r.count, 42);
});

test("⚠️ never one hardcoded host: the first explorer DOWN, the chain's own explorer answers", async () => {
  const calls: Call[] = [];
  const r = await readHolders("robinhood", SFX, {
    fetch: fakeFetch((u) => (u.startsWith(RH1) ? down() : json({ holders_count: "1570" })), calls),
    dsPair: async () => { throw new Error("DexScreener must not be asked when an explorer answered"); },
  });
  assert.deepEqual(r, { count: 1570, source: "blockscout", via: "explorer.mainnet.chain.robinhood.com", why: null });
  // A host we cannot REACH is not asked its second path — the same silence twice.
  assert.equal(calls.filter((c) => c.url.startsWith(RH1)).length, 1);
});

test("⚠️ a token record that lags answers 0 — the /counters endpoint has the real number", async () => {
  const calls: Call[] = [];
  const r = await readHolders("robinhood", SFX, {
    fetch: fakeFetch((u) => (u.endsWith("/counters") ? json({ token_holders_count: "1570", transfers_count: "9000" }) : json({ holders_count: "0" })), calls),
  });
  assert.equal(r.count, 1570);
  assert.equal(calls[1].url, `${RH1}/api/v2/tokens/${SFX}/counters`);
});

test("⚠️ a ZERO is 'not indexed', never a count — it may not end the lookup ahead of a real number", async () => {
  const r = await readHolders("robinhood", SFX, {
    fetch: fakeFetch((u) => (u.includes("io.dexscreener") ? json({ holders: { count: 1570 } }) : json({ holders_count: "0", token_holders_count: "0" }))),
    dsPair: async () => ({ ok: true, pair: PAIR, why: null }),
  });
  assert.equal(r.count, 1570);
  assert.equal(r.source, "dexscreener");
});

test("DexScreener: the pair's details carry the Holders tab's number, asked like a browser", async () => {
  const calls: Call[] = [];
  const r = await readHolders("robinhood", SFX, {
    fetch: fakeFetch((u) => (u.includes("io.dexscreener") ? json({ holders: { count: 1570, holders: [] } }) : json({}, 404)), calls),
    dsPair: async () => ({ ok: true, pair: PAIR, why: null }),
    gtGet: async () => { throw new Error("GT must not be asked when DexScreener answered"); },
  });
  assert.deepEqual(r, { count: 1570, source: "dexscreener", via: "io.dexscreener.com", why: null });
  const io = calls.find((c) => c.url.includes("io.dexscreener"))!;
  assert.equal(io.url, "https://io.dexscreener.com/dex/pair-details/v4/robinhood/0xabc123");
  assert.ok(io.headers["user-agent"] && io.headers.referer, "the internal host needs the headers a browser sends");
});

test("DexScreener: a 404 is a SPELLING miss and tries the next path; a 500 does not", async () => {
  const calls: Call[] = [];
  await readHolders("robinhood", SFX, {
    fetch: fakeFetch((u) => (u.includes("/v4/") ? json({}, 404) : u.includes("/v3/") ? json({ holders: { count: 7 } }) : json({}, 404)), calls),
    dsPair: async () => ({ ok: true, pair: PAIR, why: null }),
  }).then((r) => assert.equal(r.count, 7));
  const calls2: Call[] = [];
  const r2 = await readHolders("robinhood", SFX, {
    fetch: fakeFetch((u) => (u.includes("io.dexscreener") ? json({}, 500) : json({}, 404)), calls2),
    dsPair: async () => ({ ok: true, pair: PAIR, why: null }),
    gtGet: gtNone,
  });
  assert.equal(r2.count, null);
  assert.equal(calls2.filter((c) => c.url.includes("io.dexscreener")).length, 1);
});

test("⚠️ DexScreener REFUSING us benches the host (one bench, the chart's) and GT is still asked", async () => {
  const calls: Call[] = [];
  let gtAsked = false;
  const r = await readHolders("robinhood", SFX, {
    fetch: fakeFetch((u) => (u.includes("io.dexscreener") ? json({}, 403) : json({}, 404)), calls),
    dsPair: async () => ({ ok: true, pair: PAIR, why: null }),
    gtGet: async () => { gtAsked = true; return { ok: true, status: 200, reason: null, body: { data: { attributes: { holders: { count: 99 } } } } }; },
  });
  assert.equal(calls.filter((c) => c.url.includes("io.dexscreener")).length, 1, "a refusal is not re-asked on the next path");
  assert.ok(dsInCooldown(), "the refusal benches DexScreener for the chart client too");
  assert.ok(gtAsked);
  assert.equal(r.count, 99);
});

test("an explorer that fails falls through to GeckoTerminal — and GT is asked for a FREE slot only", async () => {
  let opts: { waitMs?: number } | undefined;
  let path = "";
  const r = await readHolders("robinhood", SFX, {
    fetch: fakeFetch(() => json({ message: "nope" }, 503)),
    dsPair: noPair,
    gtGet: async (p, _q, o) => {
      path = p;
      opts = o;
      return { ok: true, status: 200, reason: null, body: { data: { attributes: { holders: { count: 1570 } } } } };
    },
  });
  assert.deepEqual(r, { count: 1570, source: "geckoterminal", via: "api.geckoterminal.com", why: null });
  assert.equal(path, `/networks/robinhood/tokens/${SFX}/info`);
  // ⚠️ A holder count is not worth one candle: GT is the scarce per-IP budget
  // every chart on the site shares, so this never QUEUES for a slot.
  assert.equal(opts?.waitMs, 0);
});

test("⚠️ nobody could answer → null with EVERY reason, naming each host, never a 0", async () => {
  const r = await readHolders("robinhood", SFX, { fetch: fakeFetch(down), dsPair: noPair, gtGet: gtNone });
  assert.equal(r.count, null);
  assert.equal(r.source, null);
  assert.match(r.why ?? "", /robinhoodchain\.blockscout\.com unreachable \(ENOTFOUND\)/);
  assert.match(r.why ?? "", /explorer\.mainnet\.chain\.robinhood\.com unreachable/);
  assert.match(r.why ?? "", /dexscreener: DexScreener has no pair/);
  assert.match(r.why ?? "", /geckoterminal: over this process/);
});

test("a chain with no explorer we read skips Blockscout (Solana)", async () => {
  const calls: Call[] = [];
  const r = await readHolders("solana", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", {
    fetch: fakeFetch(() => json({}), calls),
    dsPair: noPair,
    gtGet: async () => ({ ok: true, status: 200, reason: null, body: { data: { attributes: { holders: { count: "812,000" } } } } }),
  });
  assert.equal(calls.length, 0, "no explorer request for a chain with no Blockscout");
  assert.equal(r.count, 812000);
  assert.equal(r.source, "geckoterminal");
});

test("countOf reads what an explorer spells, and refuses what it cannot", () => {
  assert.equal(countOf("1570"), 1570);
  assert.equal(countOf(1570), 1570);
  assert.equal(countOf("1,570"), 1570);
  assert.equal(countOf(0), 0, "the parser reads a zero; readHolders is what refuses it");
  assert.equal(countOf(""), null, "…a blank is not (the Number('') rule)");
  assert.equal(countOf(null), null);
  assert.equal(countOf("n/a"), null);
  assert.equal(countOf(-3), null);
});

test("dsHolderCount reads the spellings a pair-details body may use; dsHolderPaths pins and refuses", () => {
  assert.equal(dsHolderCount({ holders: { count: 1570 } }), 1570);
  assert.equal(dsHolderCount({ holders: { total: "12" } }), 12);
  assert.equal(dsHolderCount({ holdersCount: 3 }), 3);
  assert.equal(dsHolderCount({ ti: { holders: { count: 5 } } }), 5);
  assert.equal(dsHolderCount({ holders: { holders: [] } }), null);
  assert.equal(dsHolderCount(null), null);
  assert.equal(dsHolderPaths("")[0], "/dex/pair-details/v4/{chain}/{pair}");
  assert.deepEqual(dsHolderPaths("/x/{chain}/{pair}"), ["/x/{chain}/{pair}"], "a pin REPLACES the list");
  assert.equal(dsHolderPaths("/dex/<path>/{pair}")[0], "/dex/pair-details/v4/{chain}/{pair}", "a placeholder is refused");
});

test("BLOCKSCOUT_<CHAIN>: a list, 0 switches it off, a pin REPLACES, a placeholder is REFUSED", () => {
  const k = "BLOCKSCOUT_ROBINHOOD";
  const was = process.env[k];
  try {
    delete process.env[k];
    assert.deepEqual(blockscoutHosts("robinhood"), [RH1, RH2]);
    assert.equal(blockscoutFor("robinhood"), RH1);
    process.env[k] = "";
    assert.deepEqual(blockscoutHosts("robinhood"), [RH1, RH2], "blank is ABSENT");
    process.env[k] = "0";
    assert.deepEqual(blockscoutHosts("robinhood"), []);
    process.env[k] = "https://explorer.example.org/, https://b.example.org";
    assert.deepEqual(blockscoutHosts("robinhood"), ["https://explorer.example.org", "https://b.example.org"]);
    // CLAUDE.md's first rule: a pasted blank must not replace a working default.
    for (const bad of ["https://your-explorer", "<explorer>", "https://explorer…", "http://explorer.example.org"]) {
      process.env[k] = bad;
      assert.deepEqual(blockscoutHosts("robinhood"), [RH1, RH2], bad);
    }
    process.env[k] = "https://ok.example.org,<blank>";
    assert.deepEqual(blockscoutHosts("robinhood"), ["https://ok.example.org"], "a refused entry is dropped, the real one kept");
    assert.deepEqual(blockscoutHosts("tron"), [], "no explorer configured → none");
  } finally {
    if (was === undefined) delete process.env[k];
    else process.env[k] = was;
  }
});
