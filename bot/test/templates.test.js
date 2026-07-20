const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");

test("substitute replaces placeholders and blanks missing ones", () => {
  assert.strictEqual(tpl.substitute("{a}-{b}", { a: "1", b: "2" }), "1-2");
  assert.strictEqual(tpl.substitute("hi {name}!", { name: "Bob" }), "hi Bob!");
  assert.strictEqual(tpl.substitute("x {missing} y", {}), "x  y"); // missing → empty
});

test("t() renders a channel-post template with real values", () => {
  const out = tpl.t("post_pump", {
    name: "Jimothy",
    symbol: "$JIM",
    percent: 137,
    firstMc: "$310K",
    lastMc: "$128M",
    address: "So1...",
    coinUrl: "https://dexvra.io/x",
    footer: "",
  });
  assert.ok(out.includes("137%"));
  assert.ok(out.includes("$JIM"));
  assert.ok(out.includes("Market cap"));
});

test("every default template key has editor metadata + a group", () => {
  for (const k of tpl.keys()) {
    const m = tpl.meta(k);
    assert.ok(m.label, `missing label for ${k}`);
    assert.ok(["Bot Messages", "Channel Posts", "Mass DM", "Group Buy Bot", "X Posts", "Other"].includes(m.group), `bad group for ${k}`);
  }
  const g = tpl.groups();
  assert.ok(g["Bot Messages"].length > 0);
  assert.ok(g["Channel Posts"].length >= 4); // listing/trending/pump/banner
});

test("t() falls back to default for an unknown key without throwing", () => {
  assert.strictEqual(tpl.t("does_not_exist", {}), "");
});

test("every template group is menu-reachable via a unique slug (admin editor)", () => {
  const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "") || "grp";
  const groups = Object.keys(tpl.groups());
  // the families the bot now ships MUST each be their own editable group
  for (const g of ["Bot Messages", "Channel Posts", "Mass DM", "Group Buy Bot"]) {
    assert.ok(groups.includes(g), `admin editor is missing the '${g}' group`);
  }
  // slugs are unique (callback-data collisions would hide a group)
  const slugs = groups.map(slug);
  assert.strictEqual(new Set(slugs).size, slugs.length, "duplicate group slugs");
  // every template resolves to a listed group (nothing orphaned)
  for (const k of tpl.keys()) assert.ok(groups.includes(tpl.meta(k).group), `${k} in an unlisted group`);
});
