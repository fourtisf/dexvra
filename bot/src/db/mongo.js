// Single shared MongoDB connection for the bot (main + admin processes both
// call connect() at boot). Purpose: a DURABLE MIRROR of the bot's on-disk JSON
// state so nothing lives only on the VPS — if the container/VPS is replaced,
// boot-time hydrate() restores every store from here.
//
// Fail-open by design: if MONGO_URI is unset OR the server can't be reached,
// enabled() stays false and every persistence call in persist.js silently falls
// back to the local-file behaviour the bot has always had. Mongo is never on the
// critical path of a payment or a message send — mirror writes are best-effort
// and fire-and-forget.
const { MongoClient } = require("mongodb");
const { MONGO_URI, MONGO_DB } = require("../config/constants");
const log = require("../helpers/logger");

let client = null;
let db = null;
let connecting = null;
let connected = false;

/** MONGO_URI is configured (a connection will be attempted). */
function configured() {
  return !!MONGO_URI;
}
/** A live connection exists right now (mirror reads/writes will run). */
function enabled() {
  return connected;
}

/** Connect once (idempotent). Resolves to the Db, or null on failure/disabled.
 *  Never throws — a bad URI or an unreachable server logs a warning and the bot
 *  continues in local-file mode. */
async function connect() {
  if (!MONGO_URI) return null;
  if (db) return db;
  if (connecting) return connecting;
  connecting = (async () => {
    const c = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      maxPoolSize: 10,
      maxIdleTimeMS: 60000, // close idle sockets before the network reaper does
    });
    await c.connect();
    // A cheap round-trip proves the server is actually reachable (connect()
    // alone can resolve against a buffered pool).
    await c.db(MONGO_DB || undefined).command({ ping: 1 });
    client = c;
    db = c.db(MONGO_DB || undefined);
    connected = true;
    c.on("topologyClosed", () => {
      connected = false;
    });
    log.info(`[mongo] connected (db=${db.databaseName})`);
    return db;
  })().catch((e) => {
    connected = false;
    connecting = null;
    log.warn(`[mongo] connect failed — running on local files only: ${e && e.message}`);
    return null;
  });
  return connecting;
}

function coll(name) {
  if (!db) throw new Error("mongo not connected");
  return db.collection(name);
}

// ── KV mirror (used by persist.js) — one doc per store: {_id:name, data, at} ──
async function kvAll() {
  if (!connected) return [];
  return coll("kv").find({}).toArray();
}
async function kvGet(name) {
  if (!connected) return undefined;
  const doc = await coll("kv").findOne({ _id: name });
  return doc ? doc.data : undefined;
}
async function kvSet(name, data) {
  if (!connected) return;
  await coll("kv").updateOne({ _id: name }, { $set: { data, at: Date.now() } }, { upsert: true });
}

// ── Job mirror (used by db/jobMirror.js) — one doc per job in the `jobs`
//    collection: {_id:"<dir>/<id>", dir, id, data, at}. `dir` is the job family
//    ("broadcasts" | "mass_dm") so a family can be restored independently. ──
async function jobsAll(dir) {
  if (!connected) return [];
  return coll("jobs").find({ dir }).toArray();
}
async function jobSet(dir, id, data) {
  if (!connected) return;
  await coll("jobs").updateOne(
    { _id: `${dir}/${id}` },
    { $set: { dir, id, data, at: Date.now() } },
    { upsert: true },
  );
}

async function close() {
  if (client) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
  client = null;
  db = null;
  connected = false;
  connecting = null;
}

module.exports = { connect, close, configured, enabled, coll, db: () => db, kvAll, kvGet, kvSet, jobsAll, jobSet };
