// Discovery — merging DexScreener and pools.trade into the two functions the
// auto-lister calls.
//
// Two properties are worth pinning here, and both are about a source that is
// NOT DexScreener getting a fair share of a budget it never used to compete
// for:
//
//  1. INTERLEAVING. The caller prices only the first N candidates per scan
//     (maxLookupsPerRun, 40 by default). Concatenating would bury every
//     pools.trade launch behind ~40 DexScreener entries, and Robinhood Chain
//     would stay exactly as invisible to auto-listing as it was before this
//     module existed — with every feed perfectly healthy.
//
//  2. FAIL-OPEN. One source down must cost only that source's candidates. The
//     auto-lister treats an empty candidate list as a blocker and pages the
//     operator, so a pools.trade outage must not be able to manufacture one
//     while DexScreener is fine.
const test = require("node:test");
const assert = require("node:assert");

const ds = require("../src/dexscreener");
const ps = require("../src/poolstrade");
const discovery = require("../src/discovery");

// The modules are required by object, and their functions are looked up at call
// time, so replacing a property here is enough to stand a source in.
function withSources({ dex, pools }, fn) {
  const realDexDiscovery = ds.fetchDiscovery;
  const realDexInfo = ds.fetchTokenInfo;
  const realPoolsDiscovery = ps.fetchDiscovery;
  const realPoolsInfo = ps.fetchTokenInfo;
  if (dex) Object.assign(ds, dex);
  if (pools) Object.assign(ps, pools);
  return (async () => {
    try {
      return await fn();
    } finally {
      ds.fetchDiscovery = realDexDiscovery;
      ds.fetchTokenInfo = realDexInfo;
      ps.fetchDiscovery = realPoolsDiscovery;
      ps.fetchTokenInfo = realPoolsInfo;
    }
  })();
}

const evm = (n) => "0x" + String(n).padStart(40, "0");

test("candidates from both sources are interleaved, not concatenated", async () => {
  await withSources(
    {
      dex: { fetchDiscovery: async () => [1, 2, 3].map((i) => ({ chain: "base", address: evm(i) })) },
      pools: { fetchDiscovery: async () => [7, 8].map((i) => ({ chain: "robinhood", address: evm(i) })) },
    },
    async () => {
      const out = await discovery.fetchDiscovery();
      assert.deepEqual(
        out.map((c) => c.chain),
        ["base", "robinhood", "base", "robinhood", "base"],
        "sources must alternate so a lookup budget reaches both",
      );
      // The concrete consequence: with a budget of only 2 lookups, a pools.trade
      // token is still one of them.
      assert.ok(out.slice(0, 2).some((c) => c.chain === "robinhood"));
    },
  );
});

test("a pools.trade outage leaves DexScreener candidates intact", async () => {
  await withSources(
    {
      dex: { fetchDiscovery: async () => [{ chain: "base", address: evm(1) }] },
      pools: {
        fetchDiscovery: async () => {
          throw new Error("pools.trade unreachable");
        },
      },
    },
    async () => {
      const out = await discovery.fetchDiscovery();
      assert.equal(out.length, 1, "the scan carries on with the source that answered");
      assert.equal(out[0].chain, "base");
    },
  );
});

test("a DexScreener outage leaves pools.trade candidates intact", async () => {
  await withSources(
    {
      dex: {
        fetchDiscovery: async () => {
          throw new Error("dexscreener unreachable");
        },
      },
      pools: { fetchDiscovery: async () => [{ chain: "robinhood", address: evm(9) }] },
    },
    async () => {
      const out = await discovery.fetchDiscovery();
      assert.equal(out.length, 1);
      assert.equal(out[0].chain, "robinhood");
    },
  );
});

test("both sources down yields an empty list, which the caller reports as a blocker", async () => {
  await withSources(
    {
      dex: { fetchDiscovery: async () => { throw new Error("down"); } },
      pools: { fetchDiscovery: async () => { throw new Error("down"); } },
    },
    async () => {
      assert.deepEqual(await discovery.fetchDiscovery(), []);
    },
  );
});

test("the same token from both sources appears once", async () => {
  const dup = { chain: "robinhood", address: evm(5) };
  await withSources(
    {
      dex: { fetchDiscovery: async () => [dup] },
      // Same address, different case — de-duplication is case-insensitive or a
      // token gets priced (and possibly listed) twice.
      pools: { fetchDiscovery: async () => [{ chain: "robinhood", address: dup.address.toUpperCase().replace("0X", "0x") }] },
    },
    async () => {
      const out = await discovery.fetchDiscovery();
      assert.equal(out.length, 1);
    },
  );
});

test("malformed candidates are dropped rather than passed on", async () => {
  await withSources(
    {
      dex: { fetchDiscovery: async () => [{ chain: "base" }, { address: evm(1) }, null] },
      pools: { fetchDiscovery: async () => [{ chain: "robinhood", address: evm(2) }] },
    },
    async () => {
      const out = await discovery.fetchDiscovery();
      assert.deepEqual(out, [{ chain: "robinhood", address: evm(2) }]);
    },
  );
});

test("a non-array from a source is treated as empty, not spread", async () => {
  await withSources(
    {
      dex: { fetchDiscovery: async () => null },
      pools: { fetchDiscovery: async () => [{ chain: "robinhood", address: evm(3) }] },
    },
    async () => {
      const out = await discovery.fetchDiscovery();
      assert.equal(out.length, 1);
    },
  );
});

test("pricing asks pools.trade first on its own chain, DexScreener elsewhere", async () => {
  const calls = [];
  await withSources(
    {
      dex: {
        fetchTokenInfo: async (c) => {
          calls.push("ds:" + c);
          return { name: "from-dexscreener", symbol: "DS" };
        },
      },
      pools: {
        fetchTokenInfo: async (c) => {
          calls.push("ps:" + c);
          return c === "robinhood" ? { name: "from-poolstrade", symbol: "PS" } : null;
        },
      },
    },
    async () => {
      const rh = await discovery.fetchTokenInfo("robinhood", evm(1));
      assert.equal(rh.name, "from-poolstrade", "the launchpad knows its own tokens best");
      assert.deepEqual(calls, ["ps:robinhood"], "DexScreener is not called when pools.trade answered");

      calls.length = 0;
      const base = await discovery.fetchTokenInfo("base", evm(1));
      assert.equal(base.name, "from-dexscreener");
      assert.deepEqual(calls, ["ds:base"], "pools.trade is never asked about another chain");
    },
  );
});

test("a Robinhood token pools.trade does not know still falls through to DexScreener", async () => {
  // A token deployed on Robinhood Chain outside the launchpad. Returning null
  // here — instead of falling through — would make it permanently unlistable.
  await withSources(
    {
      dex: { fetchTokenInfo: async () => ({ name: "indexed elsewhere", symbol: "ELSE" }) },
      pools: { fetchTokenInfo: async () => null },
    },
    async () => {
      const info = await discovery.fetchTokenInfo("robinhood", evm(1));
      assert.equal(info.name, "indexed elsewhere");
    },
  );
});

test("a pools.trade error during pricing falls through instead of failing the token", async () => {
  await withSources(
    {
      dex: { fetchTokenInfo: async () => ({ name: "fallback", symbol: "FB" }) },
      pools: { fetchTokenInfo: async () => { throw new Error("boom"); } },
    },
    async () => {
      const info = await discovery.fetchTokenInfo("robinhood", evm(1));
      assert.equal(info.name, "fallback");
    },
  );
});
