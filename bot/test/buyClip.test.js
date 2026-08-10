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

const kindPath = (kind, ext) => path.join(dir, `banner-media-${kind}.${ext}`);
const clipPath = (ext) => kindPath("buy", ext);
const writeKind = (kind, ext) => fss.writeFileSync(kindPath(kind, ext), "GIF89a-not-really");
const writeClip = (ext) => writeKind("buy", ext);
const clearClips = () => {
  for (const kind of ["buy", "whale", "default"]) {
    for (const ext of ["gif", "mp4", "webm", "mov"]) {
      try {
        fss.unlinkSync(kindPath(kind, ext));
      } catch {
        /* not there */
      }
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
  for (const kind of ["buy", "whale", "default"]) {
    assert.ok(km[1].split("|").includes(kind), `${kind} is media-capable`);
    assert.match(src, new RegExp(`btk:${kind}`), `and ${kind} is reachable from the artwork menu`);
  }
  assert.ok(typeof adminBot === "object");
});

// ── The ⭐ default slot ───────────────────────────────────────────────────────

test("an empty slot falls back to the shared default clip", () => {
  // One upload, artwork on every group alert — the point of the slot.
  writeKind("default", "gif");
  assert.strictEqual(mon.buyClip("buy").source, kindPath("default", "gif"));
  assert.strictEqual(mon.buyClip("whale").source, kindPath("default", "gif"));
});

test("a kind's OWN clip always beats the default", () => {
  writeKind("default", "gif");
  writeKind("whale", "gif");
  assert.strictEqual(mon.buyClip("whale").source, kindPath("whale", "gif"), "whale keeps its own look");
  assert.strictEqual(mon.buyClip("buy").source, kindPath("default", "gif"), "buy, undressed, takes the house clip");
});

test("buy and whale still never borrow from EACH OTHER", () => {
  // The two slots exist so a whale LOOKS different scrolling past. Only the
  // explicit ⭐ default is shared; cross-borrowing would give both alerts
  // identical artwork with only the wording changed.
  writeKind("buy", "gif");
  assert.strictEqual(mon.buyClip("whale"), null, "no whale clip and no default → text, not the buy clip");
  writeKind("whale", "mp4");
  assert.strictEqual(mon.buyClip("buy").source, kindPath("buy", "gif"), "and buy does not borrow the whale clip either");
});

test("with nothing uploaded anywhere, nothing changes — the alert is still text", () => {
  assert.strictEqual(mon.buyClip("buy"), null);
  assert.strictEqual(mon.buyClip("whale"), null);
  assert.strictEqual(mon.buyClip(mon.DEFAULT_CLIP_KIND), null);
});

test("asking for the default kind directly does not look itself up twice", () => {
  // Cheap to get wrong, and the wrong version is an infinite-ish double stat()
  // on the hot path for every alert sent with no clip at all.
  const bt = require("../src/bannerTemplate");
  const real = bt.mediaOverride;
  const asked = [];
  try {
    bt.mediaOverride = (k) => {
      asked.push(k);
      return null;
    };
    assert.strictEqual(mon.buyClip("default"), null);
    assert.deepStrictEqual(asked, ["default"]);
  } finally {
    bt.mediaOverride = real;
  }
});
