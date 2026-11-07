// "bisakah delete from server? … kalo token sudah dihapus berarti token bener2
// dihapus" — npm run listing:delete removes ONE named listing from a shell, the
// same act as the admin console's 🗑. These pin what it may do, what it says,
// and that it stays the ONLY caller of the route that may delete a paid row.
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-listingdel-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const del = require("../scripts/listing-delete");
const identityCheck = require("../scripts/identity-check");

const ROW = {
  id: "l_abc",
  chain: "solana",
  address: "C5xphKMn5iTRGEqPp1Bc8bzGyPWT8nmZzG3uPPBpump",
  sym: "$LTC",
  name: "Little Titty Coin",
  tier: "FREE",
  status: "approved",
  source: "bot",
  listedAt: Date.now() - 3 * 86400000,
};

/** Run with console.log captured; returns { r, out }. */
async function quiet(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const r = await fn();
    return { r, out: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

function deps(over = {}) {
  const calls = [];
  return {
    calls,
    findListing: async () => ROW,
    remove: async (id, address) => {
      calls.push([id, address]);
      return { deleted: true };
    },
    wasEverListed: () => true,
    remember: async (rows) => {
      calls.push(["remember", rows.map((r) => r.address)]);
      return 1;
    },
    granted: {},
    ...over,
  };
}

test("a DRY RUN deletes nothing and prints the complete --apply line with the row's own values", async () => {
  const d = deps();
  const { r, out } = await quiet(() => del.run("solana", ROW.address, false, d));
  assert.equal(r.ok, true);
  assert.equal(r.deleted, false);
  assert.equal(d.calls.length, 0, "a dry run never calls the delete");
  assert.match(out, new RegExp(`listing:delete -- solana ${ROW.address} --apply`));
  assert.ok(!/[<>]/.test(out.split("\n").find((l) => l.includes("--apply"))), "no bracketed blank on the pasteable line");
});

test("--apply deletes the row it FOUND, restating that row's own address", async () => {
  const d = deps();
  const { r, out } = await quiet(() => del.run("solana", ROW.address.toLowerCase(), true, d));
  assert.equal(r.deleted, true);
  assert.deepEqual(d.calls[0], [ROW.id, ROW.address], "the stored address, not the typed spelling");
  assert.match(out, /pump and rank-up alerts: none/);
  assert.match(out, /channel posts are still in Telegram/);
});

test("a token that is not listed has nothing to delete — and nothing is called", async () => {
  const d = deps({ findListing: async () => null });
  const { r, out } = await quiet(() => del.run("solana", ROW.address, true, d));
  assert.equal(r.ok, false);
  assert.equal(d.calls.length, 0);
  assert.match(out, /nothing to delete/);
});

test("a refused delete is a failure and says nothing was deleted", async () => {
  const d = deps({
    remove: async () => {
      throw new Error("POST … → 409: refused");
    },
  });
  const { r, out } = await quiet(() => del.run("solana", ROW.address, true, d));
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.match(out, /Nothing was deleted/);
});

test("an answer that does not confirm the delete is not reported as one", async () => {
  const d = deps({ remove: async () => ({}) });
  const { r } = await quiet(() => del.run("solana", ROW.address, true, d));
  assert.equal(r.deleted, false);
  assert.equal(r.ok, false);
});

test("a deleted contract is put on the never-relist ledger, so the auto-lister cannot bring it back", async () => {
  const ledger = new Set();
  const d = deps({
    remember: async (rows) => rows.forEach((r) => ledger.add(r.address)),
    wasEverListed: (c, a) => ledger.has(a),
  });
  const { out } = await quiet(() => del.run("solana", ROW.address, true, d));
  assert.ok(ledger.has(ROW.address), "recorded on the ledger");
  assert.match(out, /will not list this contract again for free/);
});

test("…and a ledger that could not be written is SAID, not assumed safe", async () => {
  const d = deps({ remember: async () => 0, wasEverListed: () => false });
  const { out } = await quiet(() => del.run("solana", ROW.address, true, d));
  assert.match(out, /could not record it on the never-relist ledger/);
});

test("a dry run and a refused delete never touch the ledger", async () => {
  for (const [apply, over] of [[false, {}], [true, { remove: async () => { throw new Error("409"); } }]]) {
    const d = deps(over);
    await quiet(() => del.run("solana", ROW.address, apply, d));
    assert.ok(!d.calls.some((c) => c[0] === "remember"), `apply=${apply}`);
  }
});

test("the row summary names a live trending slot the delete would end, and a bot-given tier", () => {
  const row = { ...ROW, tier: "XPRESS", trendingRank: 2, trendExp: Date.now() + 5 * 3600000 };
  const lines = del.describe(row, { [`solana:${ROW.address.toLowerCase()}`]: "XPRESS" }).join("\n");
  assert.match(lines, /holds a trending slot/);
  assert.match(lines, /given by the auto-lister, not bought/);
});

test("identity:check prints a complete delete line for a wrongly named row", () => {
  const line = identityCheck.deleteLine(ROW);
  assert.match(line, new RegExp(`npm run listing:delete -- solana ${ROW.address} --apply$`));
  assert.match(line, /^cd \//, "a real directory, not a placeholder");
  assert.ok(!/[<>]/.test(line));
});

// ⚠️ THE GUARD. removeListingByHand reaches the route that may delete a PAID
// row. Exactly one script may call it; a bulk cleanup that grew a call would be
// the purchase-taking defect the bulk DELETE route exists to refuse.
test("exactly ONE caller of removeListingByHand: scripts/listing-delete.js", () => {
  const roots = ["src", "scripts"].map((d) => path.join(__dirname, "..", d));
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) {
        const src = fs
          .readFileSync(p, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (/removeListingByHand/.test(src)) callers.push(path.relative(path.join(__dirname, ".."), p));
      }
    }
  };
  roots.forEach(walk);
  callers.sort();
  // the definition (api/dexvra.js) and the one script — nothing else
  assert.deepEqual(callers, ["scripts/listing-delete.js", "src/api/dexvra.js"]);
});
