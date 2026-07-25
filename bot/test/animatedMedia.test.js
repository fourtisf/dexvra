// A GIF/clip must reach the channel as an INLINE, playing animation — not as a
// "banner-media-rankup.gif · 783 KB" file card. Telegram decides that from
// DocumentAttributeAnimated, which GramJS never adds on its own, so the media
// TYPE has to survive all the way from the poster down to sendFile().
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-anim-"));

const test = require("node:test");
const assert = require("node:assert");

const gramjs = require("../src/gramjs");
const post = require("../src/channels/post");

const PAYLOAD = { text: "hello", entities: [{ type: "bold", offset: 0, length: 5 }] };

function harness() {
  const botCalls = [];
  post.attach({
    sendMessage: async () => ({ message_id: 1 }),
    sendPhoto: async () => ({ message_id: 2 }),
    sendAnimation: async (chat, input, extra) => {
      botCalls.push({ method: "sendAnimation", input, extra });
      return { message_id: 3 };
    },
    sendVideo: async (chat, input, extra) => {
      botCalls.push({ method: "sendVideo", input, extra });
      return { message_id: 4 };
    },
    pinChatMessage: async () => true,
  });
  return botCalls;
}

test("an animation keeps its type down to gramjs (so it can be marked animated)", async () => {
  harness();
  const seen = [];
  const realAvail = gramjs.available;
  const realSend = gramjs.sendToChannel;
  gramjs.available = () => true;
  gramjs.sendToChannel = async (chan, opts) => {
    seen.push(opts);
    return { message_id: 9 };
  };
  try {
    await post.sendMedia("@c", { type: "animation", source: "/tmp/clip.gif" }, PAYLOAD);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].mediaType, "animation", "gramjs is told this is an animation");
    await post.sendMedia("@c", { type: "video", source: "/tmp/clip.mp4" }, PAYLOAD);
    assert.strictEqual(seen[1].mediaType, "video");
    await post.sendMedia("@c", { type: "photo", source: Buffer.from("x") }, PAYLOAD);
    assert.strictEqual(seen[2].mediaType, "photo", "photos are typed too — never left undefined");
  } finally {
    gramjs.available = realAvail;
    gramjs.sendToChannel = realSend;
  }
});

test("only an animation gets DocumentAttributeAnimated", () => {
  // The real Api classes — if GramJS ever renames this, the test fails here
  // rather than silently in production as a file card.
  const { Api } = require("telegram");
  const anim = gramjs._fileAttributes("animation", Api);
  assert.ok(Array.isArray(anim) && anim.length === 1, "one attribute for an animation");
  assert.ok(anim[0] instanceof Api.DocumentAttributeAnimated, "…and it is DocumentAttributeAnimated");
  // Everything else keeps whatever GramJS derived from the file itself.
  for (const t of ["photo", "video", undefined, null, "document"]) {
    assert.strictEqual(gramjs._fileAttributes(t, Api), undefined, `${t} must not be marked animated`);
  }
});

test("bot-api fallback uses sendAnimation (never sendDocument)", async () => {
  const botCalls = harness();
  const realAvail = gramjs.available;
  gramjs.available = () => false; // force the Bot API path
  try {
    await post.sendMedia("@c", { type: "animation", source: Buffer.from("gif") }, PAYLOAD);
    assert.strictEqual(botCalls[0].method, "sendAnimation", "Telegram marks these animated server-side");
    await post.sendMedia("@c", { type: "video", source: Buffer.from("mp4") }, PAYLOAD);
    assert.strictEqual(botCalls[1].method, "sendVideo");
  } finally {
    gramjs.available = realAvail;
  }
});
