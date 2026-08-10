// A /command a reader taps must land in the chat input, not on the clipboard.
//
// Telegram builds the tappable `bot_command` entity itself, from the PLAIN TEXT
// of the message. A command wrapped in `backticks` becomes a `code` entity
// instead, and a code entity taps to "copied to clipboard" — so the reader sees
// a tooltip, an empty input box, and nothing happens. Every setup instruction
// in the group templates was written that way.
//
// This pins the shape, not the wording: templates are admin-editable, so the
// test asks "is any command inside a code span" rather than "does this template
// say X".
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-cmd-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");

// A command as Telegram recognises it: a slash, a letter, then word characters,
// ending at whitespace or end of string. "/status/" — the X-URL fragment in
// raid_bad_url — deliberately does NOT match: the trailing slash means Telegram
// would never make it a command either, so it is free to stay code-formatted.
const COMMAND = /(^|\s)\/[a-z][a-z0-9_]{0,30}(\s|$)/;

test("no default template hides a /command inside a code span", () => {
  const bad = [];
  for (const key of tpl.keys()) {
    let payload;
    try {
      payload = tpl.render(key);
    } catch {
      continue; // render failures are templateLinks.test.js's job
    }
    for (const e of payload.entities || []) {
      if (e.type !== "code" && e.type !== "pre") continue;
      const span = String(payload.text).substr(e.offset, e.length);
      if (COMMAND.test(span)) bad.push(`${key}: \`${span}\``);
    }
  }
  assert.deepStrictEqual(bad, [], `these tap to the clipboard instead of the chat box:\n${bad.join("\n")}`);
});

test("the group setup commands survive as plain, tappable text", () => {
  // The positive half. Unwrapping is only useful if the command actually
  // reaches Telegram as bare text — an over-eager edit that dropped the slash,
  // or a template rewritten to say "the settoken command", would pass the
  // negative test above while leaving nothing to tap.
  const start = tpl.render("group_start");
  for (const cmd of ["/settoken", "/setminbuy", "/buybot", "/setwhale", "/raid"]) {
    const at = start.text.indexOf(cmd);
    assert.ok(at >= 0, `group_start no longer mentions ${cmd}`);
    const covering = (start.entities || []).filter(
      (e) => (e.type === "code" || e.type === "pre") && at >= e.offset && at < e.offset + e.length,
    );
    assert.deepStrictEqual(covering, [], `${cmd} is inside a code span in group_start`);
  }
});
