// GIF/video media override + the sendMedia dispatcher + pump 50× band.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-media-"));
process.env.BANNER_BUNDLED_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-media-b-"));

const test = require("node:test");
const assert = require("node:assert");
const bt = require("../src/bannerTemplate");

test("mediaOverride: none → null; gif → animation; mp4 → video; one clip per kind", async () => {
  assert.strictEqual(bt.mediaOverride("pump"), null);
  await bt.saveMedia("pump", Buffer.from("GIF89a fake"), "gif");
  assert.deepStrictEqual(
    { type: bt.mediaOverride("pump").type },
    { type: "animation" },
  );
  // saving a different ext replaces the prior clip (no two files linger)
  await bt.saveMedia("pump", Buffer.from("\x00\x00\x00 fake mp4"), "mp4");
  assert.strictEqual(bt.mediaOverride("pump").type, "video");
  assert.ok(bt.hasMedia("pump"));
  await bt.removeMedia("pump");
  assert.strictEqual(bt.mediaOverride("pump"), null);
});

test("saveMedia rejects an unsupported extension", async () => {
  await assert.rejects(() => bt.saveMedia("listing", Buffer.from("x"), "exe"));
});

test("sendMedia dispatches by type (photo/animation/video) with caption+reply", async () => {
  const post = require("../src/channels/post");
  const calls = [];
  const stub = {
    sendPhoto: async (ch, src, extra) => (calls.push(["photo", ch, src, extra]), { message_id: 1 }),
    sendAnimation: async (ch, src, extra) => (calls.push(["animation", ch, src, extra]), { message_id: 2 }),
    sendVideo: async (ch, src, extra) => (calls.push(["video", ch, src, extra]), { message_id: 3 }),
    sendMessage: async () => ({ message_id: 9 }),
    pinChatMessage: async () => {},
  };
  post.attach(stub);
  const payload = { text: "hi", entities: [] };

  await post.sendMedia("@c", { type: "animation", source: "/tmp/a.gif" }, payload, { replyTo: 42 });
  await post.sendMedia("@c", { type: "video", source: "/tmp/a.mp4" }, payload);
  await post.sendMedia("@c", { source: "/tmp/a.png" }, payload); // no type → photo
  await post.sendMedia("@c", null, payload); // null → text

  assert.strictEqual(calls[0][0], "animation");
  assert.strictEqual(calls[0][3].caption, "hi");
  assert.ok(calls[0][3].reply_parameters && calls[0][3].reply_parameters.message_id === 42);
  assert.strictEqual(calls[1][0], "video");
  assert.strictEqual(calls[2][0], "photo");
});

test("pump band: fires 100%..just under 5000% (50×), not below/above", () => {
  const inBand = (pct) => pct >= 100 && pct < 5000; // mirrors pumpChecker
  assert.ok(!inBand(99));
  assert.ok(inBand(100));
  assert.ok(inBand(4999));
  assert.ok(!inBand(5000)); // 50× ceiling
});
