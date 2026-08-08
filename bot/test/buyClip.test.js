// The admin-uploaded GIF/video for buy alerts (@dexvraadminbot → 🎨 Gambar
// Banner Channel → 🟢 Buy Bot). One clip, every group.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const dir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-clip-"));
process.env.BOT_DATA_DIR = dir;

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");
const bannerTpl = require("../src/bannerTemplate");
const adminBot = require("../src/admin/adminBot");

const clipPath = (ext) => path.join(dir, `banner-media-buy.${ext}`);
const writeClip = (ext) => fss.writeFileSync(clipPath(ext), "GIF89a-not-really");
const clearClips = () => {
  for (const ext of ["gif", "mp4", "webm", "mov"]) {
    try {
      fss.unlinkSync(clipPath(ext));
    } catch {
      /* not there */
    }
  }
};

test.beforeEach(clearClips);
test.after(clearClips);

test("with no clip uploaded, the alert is a plain text message", async () => {
  const calls = [];
  const tg = {
    sendMessage: async (c, t, e) => calls.push(["text", c, t, e]),
    sendAnimation: async () => calls.push(["anim"]),
    sendVideo: async () => calls.push(["video"]),
  };
  await mon.sendAlert(tg, "-100", "buy!", { entities: [] });
  assert.strictEqual(calls[0][0], "text");
});

test("a GIF is sent as an ANIMATION with the alert as its caption", async () => {
  writeClip("gif");
  const calls = [];
  const tg = {
    sendMessage: async () => calls.push(["text"]),
    sendAnimation: async (c, media, extra) => calls.push(["anim", c, media, extra]),
    sendVideo: async () => calls.push(["video"]),
  };
  const entities = [{ type: "bold", offset: 0, length: 3 }];
  await mon.sendAlert(tg, "-100", "buy!", { entities, disable_web_page_preview: true });
  const [kind, chat, media, extra] = calls[0];
  assert.strictEqual(kind, "anim");
  assert.strictEqual(chat, "-100");
  assert.strictEqual(media.source, clipPath("gif"));
  assert.strictEqual(extra.caption, "buy!");
  // caption_entities, NOT entities — a caption carries its formatting under a
  // different key, and sending the wrong one drops every link silently.
  assert.deepStrictEqual(extra.caption_entities, entities);
  assert.strictEqual(extra.entities, undefined);
});

test("an MP4 is sent as a VIDEO", async () => {
  writeClip("mp4");
  const calls = [];
  const tg = {
    sendMessage: async () => calls.push(["text"]),
    sendAnimation: async () => calls.push(["anim"]),
    sendVideo: async (c, media) => calls.push(["video", c, media]),
  };
  await mon.sendAlert(tg, "-100", "buy!", {});
  assert.strictEqual(calls[0][0], "video");
});

test("a clip Telegram REFUSES costs the artwork, never the alert", async () => {
  writeClip("gif");
  const calls = [];
  const tg = {
    sendMessage: async (c, t) => {
      calls.push(["text", t]);
      return { message_id: 1 };
    },
    sendAnimation: async () => {
      throw new Error("400: Bad Request: wrong file identifier");
    },
    sendVideo: async () => {},
  };
  const sent = await mon.sendAlert(tg, "-100", "buy!", {});
  assert.strictEqual(calls[0][0], "text", "it falls back to the text card");
  assert.deepStrictEqual(sent, { message_id: 1 });
});

test("swapping the clip takes effect on the very next alert", () => {
  // It is resolved per send rather than cached: editing it at runtime is the
  // entire point of the admin menu.
  assert.strictEqual(mon.buyClip(), null);
  writeClip("gif");
  assert.strictEqual(mon.buyClip().type, "animation");
  clearClips();
  assert.strictEqual(mon.buyClip(), null);
});

test("the buy clip uses the same per-kind storage as every other banner clip", async () => {
  // Which is what gets it into the Mongo media mirror (BLOB_RE covers
  // banner-media-*) and out of a container replace alive.
  await bannerTpl.saveMedia("buy", Buffer.from("x"), "gif");
  assert.ok(bannerTpl.mediaOverride("buy"));
  await bannerTpl.removeMedia("buy");
  assert.strictEqual(bannerTpl.mediaOverride("buy"), null);
});

test("the admin menu exposes Buy Bot as a media-capable kind", () => {
  // The upload/remove/preview handlers are all gated on one regex; a kind
  // missing from it renders a button that silently does nothing.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "adminBot.js"), "utf8");
  const km = src.match(/const KM = "\(([^)]+)\)"/);
  assert.ok(km, "the media-kind regex still exists");
  assert.ok(km[1].split("|").includes("buy"), "buy is media-capable");
  assert.match(src, /btk:buy/, "and reachable from the artwork menu");
  assert.ok(typeof adminBot === "object");
});
