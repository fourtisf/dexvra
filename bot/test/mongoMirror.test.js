// hydrate()'s disk↔Mongo convergence + saveJSON's mirror, exercised against an
// in-memory fake of the mongo module (no live server needed). Pins the whole
// point of the durability feature: a fresh container restores its state from
// the mirror, and an existing VPS seeds the mirror from local files.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
delete process.env.MONGO_URI;
const DATA = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-mirror-"));
process.env.BOT_DATA_DIR = DATA;

const test = require("node:test");
const assert = require("node:assert");
const mongo = require("../src/db/mongo");
const persist = require("../src/helpers/persist");

// Swap the mongo module's methods for an in-memory kv "collection". persist.js
// calls these via the module object, so the overrides take effect.
function fakeMongo(initial = {}) {
  const kv = new Map(Object.entries(initial));
  mongo.configured = () => true;
  mongo.enabled = () => true;
  mongo.connect = async () => ({}); // truthy "db"
  mongo.kvAll = async () => [...kv.entries()].map(([_id, data]) => ({ _id, data }));
  mongo.kvGet = async (n) => kv.get(n);
  mongo.kvSet = async (n, d) => {
    kv.set(n, d);
  };
  return kv;
}

test("hydrate restores a store missing on disk from the Mongo mirror", async () => {
  fakeMongo({ "templates.json": { welcome: "hi" } });
  assert.ok(!fss.existsSync(path.join(DATA, "templates.json")), "precondition: no local file");
  const r = await persist.hydrate();
  assert.strictEqual(r.mode, "mongo");
  assert.ok(r.restored >= 1, `expected a restore, got ${JSON.stringify(r)}`);
  assert.deepStrictEqual(persist.loadJSONSync("templates.json", null), { welcome: "hi" });
});

test("hydrate does NOT clobber a present local file", async () => {
  await persist.saveJSON("templates.json", { welcome: "LOCAL-NEWER" });
  fakeMongo({ "templates.json": { welcome: "old-mirror" } });
  await persist.hydrate();
  assert.deepStrictEqual(persist.loadJSONSync("templates.json", null), { welcome: "LOCAL-NEWER" });
});

test("hydrate seeds Mongo from a local store not yet mirrored", async () => {
  await persist.saveJSON("groups.json", { g1: { on: true } });
  const kv = fakeMongo({}); // mirror starts empty
  const r = await persist.hydrate();
  assert.strictEqual(r.mode, "mongo");
  assert.ok(r.seeded >= 1, `expected a seed, got ${JSON.stringify(r)}`);
  assert.deepStrictEqual(kv.get("groups.json"), { g1: { on: true } });
});

test("saveJSON mirrors to Mongo when connected", async () => {
  const kv = fakeMongo({});
  await persist.saveJSON("orders.json", { o1: { status: "paid" } });
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget mirror settle
  assert.deepStrictEqual(kv.get("orders.json"), { o1: { status: "paid" } });
});
