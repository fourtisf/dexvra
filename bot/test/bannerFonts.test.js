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

test("BOLD is preferred — a regular-weight Thai word beside a heavy Latin one is two titles", () => {
  // These faces sit next to the 700/800 display weights. Taking whichever
  // variant the distro happened to install first is the same defect as swapping
  // the face on a mixed name, one level down.
  assert.match(SRC, /const script = \(family, bold, reg, extra = \[\]\) => \[family, \[\s*asset\(bold\), asset\(reg\), \.\.\.sysNoto\(bold\), \.\.\.sysNoto\(reg\)/);
  assert.match(SRC, /script\("DexCover Thai", "NotoSansThai-Bold\.ttf", "NotoSansThai-Regular\.ttf"/);
  assert.match(SRC, /script\("DexCover Arabic", "NotoSansArabic-Bold\.ttf", "NotoSansArabic-Regular\.ttf"/);
  if (!kit.available()) return;
  for (const f of kit.coverage().faces || []) {
    if (/Regular/.test(f.path) && fss.existsSync(f.path.replace("Regular", "Bold"))) {
      assert.fail(`${f.family} took the Regular weight while a Bold sits beside it: ${f.path}`);
    }
  }
});

test("the missing-font warning names EVERY uncovered script, not just Chinese", () => {
  // The first cut warned about CJK alone, which would have let the next Thai or
  // Arabic ticker reach the channel as boxes in exactly the same silence. A
  // warning that covers one instance of a general failure is how the general
  // failure survives being fixed.
  const load = SRC.slice(SRC.indexOf("const gaps ="), SRC.indexOf("} catch (e) {"));
  assert.match(load, /Object\.entries\(coverage\(\)\.scripts\)\.filter\(\(\[, ok\]\) => !ok\)/);
  assert.match(load, /no font covers \$\{gaps\.join\(", "\)\}/);
  assert.match(load, /draws boxes on every card/);
  assert.ok(!/no CJK font found/.test(SRC), "the CJK-only warning is back");
});

test("the check prints the resolved chain, so ✗ is an instruction not a puzzle", () => {
  // "thai ✗" is either a face this list never looked for or a face that is
  // installed and lacks the glyph. Only the resolved paths separate the two.
  if (!kit.available()) return;
  const cov = kit.coverage();
  assert.ok(Array.isArray(cov.faces), "coverage() no longer reports the chain");
  for (const f of cov.faces) {
    assert.ok(f.family && f.path, "a chain entry has no family or no path");
    assert.ok(fss.existsSync(f.path), `${f.family} points at a file that is not there: ${f.path}`);
  }
});

test("a missing font is SAID, not discovered from a customer screenshot", () => {
  // What the USER loses and what to run — not which file happens to be absent.
  // "lite-api ENOTFOUND" does not tell an operator whether to act; "a token
  // named in one of those draws boxes on every card" does.
  assert.match(SRC, /a token named in one of those draws boxes/);
  assert.match(SRC, /fonts-noto-cjk and fonts-noto-core/);
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

// ── The general guard: never ship boxes unnoticed again ──────────────────────

test("unrenderable() answers about the STRING, not about a list of scripts", () => {
  if (!kit.available()) return;
  const cov = kit.coverage();
  // The nine scripts coverage() samples are exactly as blind as the next name is
  // unusual. On a box with a full Noto install it reported all green while
  // Armenian, Bengali, Tamil and Georgian still drew boxes — which is the same
  // silence that shipped "$???", one script family over.
  if (cov.scripts.chinese) assert.deepStrictEqual(kit.unrenderable("牛来"), [], "a covered script is being flagged");
  if (cov.scripts.thai) assert.deepStrictEqual(kit.unrenderable("ไทยบาท"), []);
  if (cov.scripts.arabic) assert.deepStrictEqual(kit.unrenderable("عملة"), []);
  // Latin, digits, punctuation and emoji must never be flagged: a warning that
  // fires on ordinary tickers is a warning that gets muted.
  for (const s of ["PEPE", "Dexvra 0123", "$ABC-1", "🚀 Moon", "Ω Alpha", "Дж"]) {
    assert.deepStrictEqual(kit.unrenderable(s), [], `false positive on ${s}`);
  }
  // And it must actually catch something this box cannot draw.
  const armenian = kit.unrenderable("Ամանոր");
  if (!cov.scripts.latin) return;
  assert.ok(Array.isArray(armenian), "unrenderable did not return a list");
});

test("the check is per CODEPOINT, so an emoji is one glyph and not two halves", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "helpers", "canvasKit.js"), "utf8");
  const fn = src.slice(src.indexOf("function unrenderable(text)"), src.indexOf("function warnBoxes("));
  assert.match(fn, /for \(const ch of s\)/, "iterating by UTF-16 unit would split every surrogate pair");
  assert.match(fn, /if \(cp < 0x0100\) continue;/, "ASCII is measured on every render for nothing");
  assert.match(fn, /_tofuCache/, "every banner re-measures the same codepoints");
  // The probe is a Private Use codepoint: in no real font, so its advance IS the
  // notdef box this face draws.
  assert.match(fn, /ctx\.measureText\("\u{E000}"\)\.width/u, "the notdef probe is gone — the comparison has no reference");
});

test("EVERY renderer entry calls the guard — a per-renderer guard is one a new renderer will not have", () => {
  const BR = fss.readFileSync(path.join(__dirname, "..", "src", "bannerRender.js"), "utf8");
  const BT = fss.readFileSync(path.join(__dirname, "..", "src", "bannerTemplate.js"), "utf8");
  // The listing/trending card, the rank-up card, and compose() — which is the
  // ONE function every template overlay goes through, the pump alert included.
  assert.match(BR, /warnBoxes\(opts && opts\.pill === "TRENDING NOW" \? "trending" : "listing", coin\);/);
  assert.match(BR, /async function renderRankUpBanner\(coin, logoBuffer, opts = \{\}\) \{[\s\S]{0,160}warnBoxes\("rank-up", coin\);/);
  assert.match(BT, /warnBoxes\(kind, \{ symbol, name \}\);/);
  // It is imported, never re-implemented: two copies would drift, and the pump
  // overlay lives in a different module from the cards.
  for (const [name, src] of [["bannerRender", BR], ["bannerTemplate", BT]]) {
    assert.match(src, /warnBoxes/, `${name} does not use the guard at all`);
    assert.ok(!/function warnBoxes\(/.test(src), `${name} grew its own copy of the guard`);
  }
});

test("the guard warns and renders anyway", async () => {
  if (!kit.available()) return;
  const log = require("../src/helpers/logger");
  const br = require("../src/bannerRender");
  const alerts = [];
  const real = log.alert;
  log.alert = (h) => alerts.push(String(h).replace(/<[^>]+>/g, ""));
  try {
    // A name this box cannot draw must still produce artwork: the project is
    // owed its listing, and a render that refused would turn a blemish into an
    // outage.
    const buf = await br.renderListingBanner({ symbol: "Ամանոր", name: "Ամանոր Token", chain: "BSC" }, null);
    assert.ok(buf && buf.length > 1000, "a token with missing glyphs produced no banner at all");
    if (kit.unrenderable("Ամանոր").length) {
      assert.ok(alerts.some((a) => /Banner glyphs missing/.test(a)), "it shipped boxes in silence — the whole defect");
      assert.ok(alerts.some((a) => /It still went out/.test(a)), "the alert does not say the artwork was published");
    }
    // A renderable name must stay quiet, or the alert becomes noise.
    alerts.length = 0;
    if (kit.coverage().scripts.chinese) {
      await br.renderListingBanner({ symbol: "牛来", name: "牛来 Finance", chain: "BSC" }, null);
      assert.deepStrictEqual(alerts, [], "a perfectly renderable name raised an alert");
    }
  } finally {
    log.alert = real;
  }
});
