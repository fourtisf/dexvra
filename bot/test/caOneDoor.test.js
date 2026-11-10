// ONE DOOR FOR A CONTRACT — so the next one cannot be built beside it.
//
// "bagaimana agar masalah ini tidak terjadi lgi" (2026-10-31), asked straight
// after "bot tidak bisa baca ca token" was fixed. The fix wired helpers/caInput
// into the seven flows that take a contract address from a person. The audit
// that followed found TWO more nobody had wired — the banner's contract step
// and a bare pair pasted into the DM — and that is the defect to design
// against: every door was written by hand, so the eighth will be too, and the
// reported symptom ("DexScreener has it, the bot can't read the CA") comes back
// on whichever door forgot.
//
// So the rule is COUNTED, not trusted: any module that shape-tests a contract
// address, holds a CA regex, or runs a "send me the contract" step must go
// through helpers/caInput — or be listed below with the reason it does not
// need to. A new door fails this test until somebody decides which it is, and
// the decision is written down where the next reader will see it.
//
// It is a source scan, so it is the CHEAP half. caInputWiring.test.js is the
// other half: it DRIVES every door with the reported link and asserts the token
// is what got stored — a scan cannot tell a wiring that fires from one that is
// merely written down.
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const SRC = path.join(__dirname, "..", "src");

// Block comments and whole-line `//` comments. A trailing comment that MENTIONS
// a validator still trips the scan — the safe direction: it costs a line in
// EXEMPT, never a door that slips through.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

/** What makes a module a door. Each trigger is a way contract input has been
 *  read in this repo before. */
const TRIGGERS = {
  // An address validator or shape probe, called.
  validator: /\b(?:isValidAddress|looksLikeCA|looksLikeAddress|extractAddress|probeChains|candidateChains)\s*\(/,
  // A typed step that collects a contract ("banner_ca", the listing form's "address").
  step: /(?:awaitingField\s*===?\s*|case\s+)["'](?:[a-z0-9]+_)?(?:ca|address)["']/,
  // A private EVM address pattern — the shape every hand-rolled door starts with.
  regex: /0x\[(?:a-fA-F0-9|0-9a-fA-F|a-f0-9|0-9a-f)\]\{40\}/,
};

/** Modules that trip a trigger and are NOT a door, each with the reason. A new
 *  entry is a decision; make it in the open. */
const EXEMPT = {
  "config/chains.js": "defines isValidAddress — the predicate, not a consumer of input",
  "helpers/caInput.js": "IS the door every other module goes through",
  "helpers/listedGuard.js": "extractAddress parses a message for the already-listed lookup; its one caller (handlers/text.js) is a door and resolves",
  "twitter.js": "strips addresses from OUTGOING tweet text; reads nothing a person typed",
  "services/tokenLogo.js": "an address the bot already holds (a listing row), never typed",
  "poolstrade.js": "addresses in pools.trade API responses, never typed",
  "services/sellSim.js": "shape-checks a token the scan or a listing row already holds, and addresses decoded from Transfer logs — never typed",
};

/** The doors the fix wired, by file. If the scan stops seeing any of them it
 *  is the scan that broke, and a scan that sees nothing passes for the wrong
 *  reason. */
const KNOWN_DOORS = [
  "handlers/listing.js",
  "handlers/massdm.js",
  "handlers/text.js",
  "handlers/banner.js",
  "group/setup.js",
  "gainers.js",
];

const USES_DOOR = /require\(\s*["'](?:\.\.?\/)+(?:helpers\/)?caInput["']\s*\)/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

function scan() {
  const doors = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    const src = stripComments(fs.readFileSync(file, "utf8"));
    const why = Object.entries(TRIGGERS).filter(([, re]) => re.test(src)).map(([k]) => k);
    if (why.length) doors.push({ rel, why, wired: USES_DOOR.test(src) });
  }
  return doors;
}

test("every module that reads a contract from a person goes through helpers/caInput", () => {
  const unwired = scan().filter((d) => !d.wired && !EXEMPT[d.rel]);
  assert.deepEqual(
    unwired.map((d) => `${d.rel} (${d.why.join(", ")})`),
    [],
    "these modules read a contract address without helpers/caInput — a DexScreener link or pair pasted there is read as the POOL. " +
      "Wire caInput.resolveInput / resolveInputSoon in, or add the file to EXEMPT with the reason it is not a door.",
  );
});

test("vacuity: the scan still sees every door the fix wired", () => {
  const seen = new Map(scan().map((d) => [d.rel, d]));
  for (const rel of KNOWN_DOORS) {
    assert.ok(seen.has(rel), `${rel} no longer trips any trigger — the scan is blind to it, so this guard could pass over a broken door`);
    assert.ok(seen.get(rel).wired, `${rel} is a door and no longer requires helpers/caInput`);
  }
});

test("EXEMPT carries no dead entries — an exemption for a file that is not a door is a hole kept open", () => {
  const seen = new Set(scan().map((d) => d.rel));
  for (const rel of Object.keys(EXEMPT)) assert.ok(seen.has(rel), `${rel} is exempt but trips no trigger — remove the entry`);
  for (const [rel, why] of Object.entries(EXEMPT)) assert.ok(why.length > 20, `${rel} is exempt with no reason`);
});

test("the triggers see the shapes they claim to — each against a door it was written for", () => {
  assert.ok(TRIGGERS.step.test(`if (s.awaitingField === "banner_ca") {`), "the banner step shape");
  assert.ok(TRIGGERS.step.test(`    case "address": {`), "the listing form's step shape");
  assert.ok(TRIGGERS.validator.test("listed.extractAddress(raw)"), "a method call on a validator");
  assert.ok(TRIGGERS.regex.test("/^0x[a-fA-F0-9]{40}$/"), "a private EVM pattern");
  assert.ok(!TRIGGERS.step.test(`case "logo": {`), "an unrelated step");
});
