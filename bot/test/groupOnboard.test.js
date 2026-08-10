// What a project sees the moment the bot lands in their group: the permissions
// greeting, the "/" command menu, and the fact that every word of the setup
// flow is now an admin-editable template rather than a string literal.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-onb-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const start = require("../src/handlers/start");

const src = (rel) => fss.readFileSync(path.join(__dirname, "..", "src", rel), "utf8");

// ── The greeting on being added ──────────────────────────────────────────────

function addCtx(over = {}) {
  const sent = [];
  return {
    sent,
    chat: { id: -1001, type: "supergroup", title: "tes fourportal2" },
    myChatMember: {
      old_chat_member: { status: "left" },
      new_chat_member: { status: "member" },
      ...(over.myChatMember || {}),
    },
    reply: async (text, extra) => {
      sent.push({ text, extra });
      return { message_id: 1 };
    },
    ...over,
  };
}

test.beforeEach(() => start._greeted.clear());

test("being added asks for the three permissions the bot actually uses", async () => {
  const ctx = addCtx();
  await start.botAddedToGroup(ctx);
  assert.strictEqual(ctx.sent.length, 1, "it speaks up without waiting to be asked");
  const t = ctx.sent[0].text;
  // Each one is a permission the code genuinely needs — pinning for whale
  // alerts and the raid card, deleting for the raid panel's cleanup, banning
  // for the chat lock. Asking for more than you use earns a refusal of all of it.
  for (const perm of ["Delete messages", "Ban users", "Pin messages"]) {
    assert.ok(t.includes(perm), `it names ${perm}`);
  }
  assert.match(t, /\/start/, "and says what to send next");
});

test("a permission change is not a new arrival", async () => {
  // Telegram sends my_chat_member for every admin-rights edit too. Greeting on
  // each one means a fresh welcome every time somebody ticks a checkbox.
  for (const [was, now] of [
    ["member", "administrator"],
    ["administrator", "member"],
    ["administrator", "administrator"],
  ]) {
    const ctx = addCtx({ myChatMember: { old_chat_member: { status: was }, new_chat_member: { status: now } } });
    await start.botAddedToGroup(ctx);
    assert.strictEqual(ctx.sent.length, 0, `${was} → ${now} is not an arrival`);
  }
});

test("being removed says nothing at all", async () => {
  for (const now of ["left", "kicked"]) {
    const ctx = addCtx({ myChatMember: { old_chat_member: { status: "administrator" }, new_chat_member: { status: now } } });
    await start.botAddedToGroup(ctx);
    assert.strictEqual(ctx.sent.length, 0, `→ ${now} is silent`);
  }
});

test("added straight as an admin still counts as arriving", async () => {
  const ctx = addCtx({ myChatMember: { old_chat_member: { status: "left" }, new_chat_member: { status: "administrator" } } });
  await start.botAddedToGroup(ctx);
  assert.strictEqual(ctx.sent.length, 1);
});

test("a private chat never gets the group greeting", async () => {
  const ctx = addCtx({ chat: { id: 7, type: "private" } });
  await start.botAddedToGroup(ctx);
  assert.strictEqual(ctx.sent.length, 0);
});

test("the ➕ deep link does not produce two welcomes stacked on each other", async () => {
  // Adding through the main-menu button fires BOTH: my_chat_member, and the
  // /start Telegram delivers into the group right behind it.
  const ctx = addCtx();
  await start.botAddedToGroup(ctx);
  assert.strictEqual(ctx.sent.length, 1, "the greeting");
  await start.groupStart(ctx);
  assert.strictEqual(ctx.sent.length, 1, "and /start seconds later stays quiet");
});

test("a /start typed later is a real request and always answers", async () => {
  const ctx = addCtx();
  await start.botAddedToGroup(ctx);
  // Age the greeting past the quiet window.
  start._greeted.set(String(ctx.chat.id), Date.now() - 60_000);
  await start.groupStart(ctx);
  assert.strictEqual(ctx.sent.length, 2);
  assert.match(ctx.sent[1].text, /settoken/, "and it is the setup guide, not the greeting again");
});

test("the greeting is wired to the update it rides on", () => {
  const reg = src("handlers/registry.js");
  assert.match(reg, /bot\.on\("my_chat_member"/, "registered");
  assert.match(reg, /start\.botAddedToGroup/, "…to the right handler");
  const block = reg.slice(reg.indexOf('bot.on("my_chat_member"'), reg.indexOf('bot.on("my_chat_member"') + 400);
  assert.match(block, /return next\(\)/, "and passes the update on — other pipelines still need it");
});

// ── The "/" menu inside a group ──────────────────────────────────────────────

test("a group's command menu lists the group commands, not start/home/help", () => {
  const { GROUP_COMMANDS, COMMANDS } = require("../src/bot");
  const names = GROUP_COMMANDS.map((c) => c.command);
  for (const c of ["settoken", "setchain", "setminbuy", "setwhale", "buybot", "raid"]) {
    assert.ok(names.includes(c), `/${c} is offered in groups`);
  }
  assert.ok(!COMMANDS.map((c) => c.command).includes("settoken"), "and the DM list is left alone");
});

test("every command offered in a group is actually registered", () => {
  // A command listed and not registered is worse than one that is missing:
  // tapping it does nothing at all, with no error to explain why.
  const { GROUP_COMMANDS } = require("../src/bot");
  const reg = src("handlers/registry.js") + src("raid/index.js");
  for (const { command } of GROUP_COMMANDS) {
    assert.match(reg, new RegExp(`bot\\.(command\\("${command}"|start)`), `/${command} has a handler`);
  }
});

test("the group list is published under the group SCOPE", () => {
  // Without the scope it overwrites the default list and every DM user loses
  // their menu.
  const bot = src("bot.js");
  assert.match(bot, /setMyCommands\(GROUP_COMMANDS, \{ scope: \{ type: "all_group_chats" \} \}\)/);
  const fn = bot.slice(bot.indexOf("async function publishCommands"));
  assert.match(fn.slice(0, 700), /\.catch\(/, "its failure must not cost the default list");
});

// ── Everything the setup flow says is editable ───────────────────────────────

test("no user-facing string is left hardcoded in the group setup commands", () => {
  const s = src("group/setup.js");
  // Every reply goes through say(key) → tpl.render. A literal sentence passed
  // to ctx.reply is one the operator cannot reword without a deploy.
  const literals = [...s.matchAll(/ctx\s*\.?\s*reply\(\s*(["'`])/g)];
  assert.strictEqual(literals.length, 0, "no ctx.reply with a literal string");
  assert.match(s, /function say\(ctx, key, vars\)/, "there is one helper and it takes a key");
});

test("no user-facing string is left hardcoded in the raid panel", () => {
  const s = src("raid/panel.js");
  const literals = [...s.matchAll(/ctx\s*\.?\s*reply\(\s*(["'])/g)];
  assert.strictEqual(literals.length, 0, "no ctx.reply with a literal string");
});

test("every setup and raid template is reachable in the editor", () => {
  const groups = tpl.groups();
  for (const key of [
    "group_added",
    "group_start",
    "settoken_ok",
    "settoken_not_found",
    "setwhale_ok",
    "setwhale_off",
    "buybot_status",
    "buybot_need_token",
    "pin_on",
    "setup_admin_only",
  ]) {
    assert.strictEqual(tpl.meta(key).group, "Group Setup", `${key} is in the editor`);
  }
  for (const key of ["raid_panel", "raid_group_only", "raid_bad_url", "raid_reposts_only", "raid_no_goals"]) {
    assert.strictEqual(tpl.meta(key).group, "Dexvra Raid", `${key} is in the editor`);
  }
  assert.ok(groups["Group Setup"].length >= 20, "the whole setup flow, not a sample");
});

test("every placeholder a setup template uses is one its caller passes", () => {
  // A {placeholder} nobody fills renders as empty string — silently, in a
  // customer's group. This is the cheap check that catches a rename.
  const setup = src("group/setup.js");
  for (const key of tpl.keys()) {
    if (tpl.meta(key).group !== "Group Setup") continue;
    for (const [, ph] of String(tpl.getRaw(key)).matchAll(/\{(\w+)\}/g)) {
      // baseVars supplies these to every template with no call site involved.
      if (["site", "listing", "trending", "announce", "xlisting", "bot", "botName"].includes(ph)) continue;
      assert.ok(tpl.meta(key).ph.includes(ph), `${key} uses {${ph}} — declare it in META so the editor lists it`);
      assert.match(setup, new RegExp(`\\b${ph}\\s*[,:}]`), `${key} uses {${ph}} — nothing in setup.js passes it`);
    }
  }
});

test("the setup replies are premium markup, not the HTML they used to be", () => {
  // These render through premium.parse now. A stray <b> would reach the group
  // as literal angle brackets.
  for (const key of tpl.keys()) {
    if (tpl.meta(key).group !== "Group Setup") continue;
    const raw = String(tpl.getRaw(key));
    assert.ok(!/<\/?(b|i|code|pre|a)\b/i.test(raw), `${key} still carries an HTML tag`);
  }
});
