// /ca — "what's the contract?", the most-asked question in any token group.
//
// The bot had no answer for it. A member typed /ca or just "ca" and nothing
// happened, so every group answered it by hand a hundred times or pinned a
// message that scrolled out of reach.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-ca-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const cfg = require("../src/group/config");
const setup = require("../src/group/setup");

const ADDR = "8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS";

/** A group chat context that records what the bot replied. */
function ctxFor(chatId, text = "/ca", from = { id: 7 }) {
  const sent = [];
  return {
    sent,
    chat: { id: chatId, type: "supergroup" },
    from,
    message: { text, message_id: 1 },
    reply: (t, e) => (sent.push({ text: t, extra: e || {} }), Promise.resolve({ message_id: 2 })),
    telegram: { getChatMember: async () => ({ status: "member" }) },
  };
}
const configure = (chatId, over = {}) =>
  cfg.upsert(chatId, { chain: "solana", address: ADDR, sym: "ALON", name: "alon", pairAddress: "PooL1", on: true, ...over });

test("it answers with the contract address, tap-to-copy", async () => {
  // A `code` span, because a hand-typed contract address is a lost transaction.
  const ctx = ctxFor("-1001");
  await configure("-1001");
  await setup.ca(ctx);
  const { text, extra } = ctx.sent[0];
  assert.ok(text.includes(ADDR));
  const code = (extra.entities || []).find((e) => e.type === "code");
  assert.ok(code, "the address must be a code span");
  assert.strictEqual(text.substr(code.offset, code.length), ADDR, "the span covers the address exactly");
});

test("it names the token and its network, and offers the three links", async () => {
  const ctx = ctxFor("-1002");
  await configure("-1002");
  await setup.ca(ctx);
  const { text, extra } = ctx.sent[0];
  assert.match(text, /^🟣 alon \$ALON$/m, "the same token row the buy card uses");
  assert.match(text, /^🔗 Solana$/m);
  const links = {};
  for (const e of extra.entities || []) if (e.type === "text_link") links[text.substr(e.offset, e.length)] = e.url;
  assert.match(links["📈 Chart"], /^https:\/\/dexscreener\.com\/solana\/PooL1$/);
  assert.match(links["⚡ Trade"], /\?start=ca_solana_/);
  assert.match(links["💎 Dexvra"], new RegExp(`/token/solana/${ADDR}$`));
});

test("a token with no resolved name prints the ticker once, not twice", async () => {
  const ctx = ctxFor("-1003");
  await configure("-1003", { name: "" });
  await setup.ca(ctx);
  assert.match(ctx.sent[0].text, /^🟣 \$ALON$/m);
});

test("no token set → the same card /buybot shows, with the same Add CA button", async () => {
  // One place that explains how to set a token, not two that will eventually
  // disagree about it.
  const ctx = ctxFor("-1004");
  await setup.ca(ctx);
  const { text, extra } = ctx.sent[0];
  assert.match(text, /No token set here yet/);
  const btns = (extra.reply_markup.inline_keyboard || []).flat();
  assert.ok(btns.some((b) => b.callback_data === "bs_token"), "the way out is on the card");
});

test("it is NOT admin-gated — the people asking are holders, not the admin", async () => {
  // getChatMember reports a plain member above, and the answer still comes.
  const ctx = ctxFor("-1005");
  await configure("-1005");
  await setup.ca(ctx);
  assert.ok(ctx.sent[0].text.includes(ADDR));
});

test("in a private chat it says so instead of answering nothing", async () => {
  const ctx = ctxFor("55");
  ctx.chat.type = "private";
  await setup.ca(ctx);
  assert.strictEqual(ctx.sent.length, 1);
  assert.ok(!ctx.sent[0].text.includes(ADDR));
});

test("a bare 'ca' is the same question without the slash", async () => {
  await configure("-1006");
  for (const word of ["ca", "CA", "Ca?", "contract", "/ca"]) {
    const ctx = ctxFor("-1006", word);
    let fell = false;
    await setup.groupTokenReply(ctx, () => (fell = true));
    assert.ok(!fell, `"${word}" should be answered, not passed through`);
    assert.ok(ctx.sent[0] && ctx.sent[0].text.includes(ADDR), `"${word}" must return the CA`);
  }
});

test("a bare 'ca' in a group with NO token stays silent", async () => {
  // /ca is explicit and always deserves a reply. A bot that answers a random
  // "ca" in a group it was never pointed at is posting unprompted into
  // somebody's chat, which is how it gets removed.
  const ctx = ctxFor("-1007", "ca");
  let fell = false;
  await setup.groupTokenReply(ctx, () => (fell = true));
  assert.ok(fell, "it must fall through");
  assert.strictEqual(ctx.sent.length, 0);
});

test("ordinary chat containing the word is left alone", async () => {
  await configure("-1008");
  for (const line of ["ca please", "what is the ca", "contract address?", "cat"]) {
    const ctx = ctxFor("-1008", line);
    let fell = false;
    await setup.groupTokenReply(ctx, () => (fell = true));
    assert.ok(fell, `"${line}" is conversation, not a command`);
  }
});

test("the card is admin-editable like every other group message", () => {
  const m = tpl.meta("group_ca");
  assert.strictEqual(m.group, "Group Setup");
  for (const ph of ["nameRow", "chain", "address", "chartUrl", "tradeUrl", "coinUrl"]) {
    assert.ok(m.ph.includes(ph), `{${ph}} must be offered in the editor`);
  }
});

test("the trade link has ONE definition, shared with the buy card", () => {
  // It used to live in buyMonitor.js alone. Two copies of the ?start= payload
  // shape is one to forget when the shape changes.
  const { tradeDeepLink } = require("../src/config/chains");
  const mon = require("../src/group/buyMonitor");
  const vars = mon.alertVars(
    { chatId: "-1", chain: "solana", address: ADDR, sym: "ALON", name: "alon" },
    { txHash: "t", buyer: "b", usd: 40, tokenAmount: 100 },
    { priceUsd: 1, mcap: 1 },
    null,
  );
  assert.strictEqual(vars.tradeUrl, tradeDeepLink("solana", ADDR));
});
