// The banner drew "$???" in front of 12,607 subscribers.
//
// A token listed as 牛来 ($牛来) came out on the listing card as "$???" and again
// on the pump alert as "??". Nothing failed and nothing logged: a font that
// lacks a glyph does not throw, it draws a box or a question mark and ships.
//
// EVERY brand face in this repo is Latin-only — Sora, Space Grotesk, JetBrains
// Mono, Liberation Sans — so every Chinese, Japanese, Korean, Thai or Arabic
// ticker the bot has ever rendered came out the same way.
//
// The fix is a FALLBACK CHAIN, not a second font for Chinese. Canvas resolves a
// comma-separated family list per GLYPH, so "牛来 Finance" keeps the brand face
// for the Latin word and reaches the coverage face only for the Han characters.
// Swapping the whole face on a mixed name would put brand type on one half of a
// title and a system face on the other.
//
// Whether a given glyph can be drawn is a property of the FONTS ON THIS BOX, not
// of the code — the same shape as `raid:check` and `launchpads:check` — so what
// is asserted here is the MECHANISM: that a chain is built, that the brand face
// leads it, and that the report tells the truth about what is missing. Coverage
// itself is `npm run fonts:check`, on the machine that renders.
const test = require("node:test");
const assert = require("node:assert");
const fss = require("node:fs");
const path = require("node:path");

const kit = require("../src/helpers/canvasKit");
const SRC = fss.readFileSync(path.join(__dirname, "..", "src", "helpers", "canvasKit.js"), "utf8");

test("every family carries the coverage chain, so no renderer has to opt in", () => {
  if (!kit.available()) return;   // no native canvas on this box: nothing to assert
  const cov = kit.coverage();
  if (!cov.cjk) return;           // no CJK font installed here — fonts:check says so
  // A renderer that had to ask for the fallback is a renderer that will forget
  // to, on the one card that needed it.
  for (const key of Object.keys(kit.F)) {
    assert.match(kit.F[key], /"DexCover CJK"/, `${key} would still draw boxes for a Chinese name`);
  }
});

test("the brand face LEADS the chain — the fallback never takes over a Latin name", () => {
  if (!kit.available()) return;
  const cov = kit.coverage();
  if (!cov.cjk) return;
  for (const key of Object.keys(kit.F)) {
    assert.ok(!/^"DexCover/.test(kit.F[key]), `${key} resolves Latin text with the coverage font, not the brand face`);
  }
});

test("the 800 display weight is Sora, not Liberation — it silently was not", () => {
  // reg() assigns unconditionally, and the two Liberation "fallback" calls ran
  // AFTER their Sora counterparts, so Liberation won the keys it touched. `x` is
  // the big token title on every card, and it had been off-brand for as long as
  // the brand fonts have been in the repo. Nothing failed; the artwork was just
  // quietly wrong on its most prominent line.
  assert.match(SRC, /const regFb = \(file, fam, key\) => \{ if \(F\[key\] === "sans-serif"\) reg\(file, fam, key\); \};/);
  assert.match(SRC, /regFb\("LiberationSans-Bold\.ttf", "DexBold", "x"\);/);
  assert.match(SRC, /regFb\("LiberationSans-Regular\.ttf", "DexReg", "m"\);/);
  assert.ok(!/\breg\("LiberationSans/.test(SRC), "the unconditional overwrite is back");
  if (!kit.available()) return;
  const fontsDir = path.join(__dirname, "..", "assets", "fonts");
  if (fss.existsSync(path.join(fontsDir, "Sora-800.ttf"))) {
    assert.match(kit.F.x, /^"Sora XBold"/, "the display weight is Liberation again");
    assert.match(kit.F.m, /^"Sora Med"/);
  }
});

test("the coverage font is DISCOVERED across a list, never one hardcoded path", () => {
  // Same rule as the launchpad hosts: a box that keeps its fonts somewhere else,
  // or an operator who drops one into assets/, must not need a code change.
  assert.match(SRC, /const CJK_CANDIDATES = \[/);
  const list = SRC.slice(SRC.indexOf("const CJK_CANDIDATES = ["), SRC.indexOf("const EMOJI_CANDIDATES"));
  assert.ok((list.match(/\n/g) || []).length > 4, "the candidate list collapsed to a single path");
  // The repo's own assets are tried FIRST, so dropping a file in wins over
  // whatever the distro happens to ship.
  assert.ok(list.indexOf('"..", "assets", "fonts"') < list.indexOf("/usr/share/fonts"),
    "a system font outranks one the operator deliberately placed");
  // An unreadable font must not take the process down with it.
  assert.match(SRC, /catch \(_\) \{ \/\* unreadable font is not a reason to fail boot \*\/ \}/);
});

test("extra scripts need a package, never a deploy", () => {
  // Thai/Arabic/Devanagari/Hebrew are in the chain the moment fonts-noto-core
  // exists. Listing them up front is what makes installing the package the whole
  // fix — the contract the launchpad hosts already have.
  for (const fam of ["DexCover Thai", "DexCover Arabic", "DexCover Deva", "DexCover Hebrew"]) {
    assert.ok(SRC.includes(fam), `${fam} is not in the candidate list`);
  }
  // Emoji goes LAST: a colour-emoji face claims some text codepoints, and a
  // ticker's letters must not resolve to it ahead of a real text font.
  const build = SRC.slice(SRC.indexOf("COVER.faces = [];"), SRC.indexOf("const tail ="));
  assert.ok(build.indexOf("EXTRA_CANDIDATES") < build.indexOf("COVER.emoji"),
    "emoji is ahead of the text faces in the chain");
});

test("a missing CJK font is SAID, not discovered from a customer screenshot", () => {
  assert.match(SRC, /no CJK font found/);
  // Names what the USER loses and what to run — not which file is absent.
  assert.match(SRC, /render as boxes/);
  assert.match(SRC, /fonts-noto-cjk/);
  assert.match(SRC, /npm run fonts:check/);
});

test("coverage() measures instead of assuming", () => {
  if (!kit.available()) return;
  const cov = kit.coverage();
  assert.strictEqual(cov.available, true);
  assert.strictEqual(cov.scripts.latin, true, "the control sample failed — the probe itself is broken");
  for (const k of ["chinese", "japanese", "korean", "emoji", "thai", "arabic"]) {
    assert.strictEqual(typeof cov.scripts[k], "boolean", `${k} is not reported at all`);
  }
  // The comparison is against the BARE first family, so a chain that silently
  // lost its tail reports false rather than inheriting a stale true.
  assert.match(SRC, /const bare = F\.r\.split\(","\)\[0\]\.trim\(\);/);
});

test("fonts:check is wired up, because it can only be answered on the box", () => {
  const pkg = JSON.parse(fss.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.strictEqual(pkg.scripts["fonts:check"], "node scripts/fonts-check.js");
  assert.ok(fss.existsSync(path.join(__dirname, "..", "scripts", "fonts-check.js")));
});
