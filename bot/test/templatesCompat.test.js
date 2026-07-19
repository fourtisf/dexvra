// Back-compat: templates saved by admins BEFORE the self-spacing {socials}/
// {overview} vars must keep rendering clean (no doubled blank lines, no raw
// leftovers). Isolated data dir — set BEFORE requiring any src module.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-tplc-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");

test("old string template with explicit blank line after {socials} stays clean", async () => {
  // pre-diff layout: template writes its own \n\n after the placeholder
  await tpl.setTemplate("post_listing", "X\n\n{socials}\n\nCTA [go]({coinUrl})");
  const r = tpl.render("post_listing", {
    socials: "🌐 [Website](https://a.io)\n\n", // new self-spacing var
    coinUrl: "https://dexvra.io/t",
  });
  assert.ok(!/\n{3,}/.test(r.text), `doubled blank lines: ${JSON.stringify(r.text)}`);
  await tpl.resetTemplate("post_listing");
});

test("old ENTITY-saved template: trailing newlines of self-spacing vars are trimmed", async () => {
  // entity-mode save (admin pasted a message): {socials} followed by the
  // template's own blank line — the var's trailing \n\n must be trimmed.
  await tpl.setTemplate("post_trending", {
    text: "HEAD\n\n{socials}\n\nCTA",
    entities: [{ type: "bold", offset: 0, length: 4 }],
  });
  const r = tpl.render("post_trending", {
    socials: "Website · X\n\n",
    overview: "",
  });
  assert.ok(!/\n{3,}/.test(r.text), `doubled blank lines: ${JSON.stringify(r.text)}`);
  assert.ok(r.text.includes("Website · X\n\nCTA"), r.text);
  await tpl.resetTemplate("post_trending");
});

test("new default layout still spaces correctly with entity-style rich vars", () => {
  const r = tpl.render("post_listing", {
    head: "⚡ Xpress",
    tierLine: "",
    logoEmoji: "",
    overview: "About the project.\n\n",
    name: "T",
    symbol: "$T",
    chain: "Solana",
    address: "So1",
    price: "$1",
    mcap: "$2",
    coinUrl: "https://dexvra.io/t",
    socials: "",
    footer: "",
  });
  assert.ok(!/\n{3,}/.test(r.text), JSON.stringify(r.text));
  assert.ok(r.text.includes("About the project."));
});
