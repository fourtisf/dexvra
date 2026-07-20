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
const jobMirror = require("../src/db/jobMirror");

// Swap the mongo module's methods for an in-memory "collection". persist.js /
// jobMirror.js call these via the module object, so the overrides take effect.
function fakeMongo(initial = {}, jobs = []) {
  const kv = new Map(Object.entries(initial));
  const jobDocs = jobs.slice();
  mongo.configured = () => true;
  mongo.enabled = () => true;
  mongo.connect = async () => ({}); // truthy "db"
  mongo.kvAll = async () => [...kv.entries()].map(([_id, data]) => ({ _id, data }));
  mongo.kvGet = async (n) => kv.get(n);
  mongo.kvSet = async (n, d) => {
    kv.set(n, d);
  };
  mongo.jobsAll = async (dir) => jobDocs.filter((j) => j.dir === dir);
  mongo.jobSet = async (dir, id, data) => {
    const i = jobDocs.findIndex((j) => j.dir === dir && j.id === id);
    if (i >= 0) jobDocs[i] = { dir, id, data };
    else jobDocs.push({ dir, id, data });
  };
  return { kv, jobDocs };
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
  const { kv } = fakeMongo({}); // mirror starts empty
  const r = await persist.hydrate();
  assert.strictEqual(r.mode, "mongo");
  assert.ok(r.seeded >= 1, `expected a seed, got ${JSON.stringify(r)}`);
  assert.deepStrictEqual(kv.get("groups.json"), { g1: { on: true } });
});

test("saveJSON mirrors to Mongo when connected", async () => {
  const { kv } = fakeMongo({});
  await persist.saveJSON("orders.json", { o1: { status: "paid" } });
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget mirror settle
  assert.deepStrictEqual(kv.get("orders.json"), { o1: { status: "paid" } });
});

test("jobMirror.mirrorJob upserts a job into the jobs mirror", async () => {
  const { jobDocs } = fakeMongo({}, []);
  jobMirror.mirrorJob("broadcasts", { id: "bc1", status: "in_progress", cursor: 40 });
  await new Promise((r) => setImmediate(r));
  const doc = jobDocs.find((j) => j.dir === "broadcasts" && j.id === "bc1");
  assert.ok(doc, "job not mirrored");
  assert.strictEqual(doc.data.cursor, 40);
});

test("jobMirror.restoreAll restores job files missing on disk", async () => {
  fakeMongo({}, [
    { dir: "broadcasts", id: "bc9", data: { id: "bc9", status: "in_progress", cursor: 7 } },
    { dir: "mass_dm", id: "md9", data: { id: "md9", status: "pending_review" } },
  ]);
  await jobMirror.restoreAll();
  const bc = JSON.parse(fss.readFileSync(path.join(DATA, "broadcasts", "bc9.json"), "utf8"));
  const md = JSON.parse(fss.readFileSync(path.join(DATA, "mass_dm", "md9.json"), "utf8"));
  assert.strictEqual(bc.cursor, 7);
  assert.strictEqual(md.status, "pending_review");
});
