// A buyer's typed message is never parsed as HTML; a card we rendered as
// markup still is. One `<` in an entity-less message made Telegram refuse every
// send of a paid broadcast, and raw tags a buyer typed were rendered.
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-mdparse-"));

const test = require("node:test");
const assert = require("node:assert");
const sender = require("../src/massdm/sender");
const store = require("../src/massdm/store");

test("an entity-less buyer message goes out PLAIN, as text or as a caption", () => {
  const job = { text: "price < $1 — <b>wow</b>", entities: [], parseMode: null };
  assert.ok(!("parse_mode" in sender._jobExtra(job, false)));
  assert.ok(!("parse_mode" in sender._jobExtra(job, true)));
  assert.strictEqual(sender._jobExtra(job, true).caption, job.text);
});

test("a job created without a parse mode (every buyer path) stores none", async () => {
  const job = await store.createJob({ text: "a < b", entities: [], createdBy: 1, targets: [], test: true });
  assert.strictEqual(job.parseMode, null);
  const forged = await store.createJob({ text: "x", entities: [], parseMode: "MarkdownV2", createdBy: 1, targets: [], test: true });
  assert.strictEqual(forged.parseMode, null, "only HTML is ever honoured, and only from our own card");
});

test("a card rendered as HTML markup is still parsed as HTML", () => {
  const job = { text: "<b>$TOKEN</b> listed", entities: [], parseMode: "HTML" };
  assert.strictEqual(sender._jobExtra(job, false).parse_mode, "HTML");
  assert.strictEqual(sender._jobExtra(job, true).parse_mode, "HTML");
});

test("entities always win — they carry the premium emoji", () => {
  const ents = [{ type: "bold", offset: 0, length: 3 }];
  const out = sender._jobExtra({ text: "abc", entities: ents, parseMode: "HTML" }, false);
  assert.deepStrictEqual(out.entities, ents);
  assert.ok(!("parse_mode" in out));
});
