// Test runner: `npm test`.
//
// Its only job is to make sure the suite NEVER reads the operator's live data/
// directory. The bot persists admin-saved templates, trending-board emoji and
// service config there, so a template the operator edited in @dexvraadminbot
// makes every template-rendering test compare against THEIR copy instead of the
// shipped default. On the VPS that turned `npm test` red for a reason that had
// nothing to do with the code (2026-07-25) — and it would have gone red on any
// server whose operator had ever saved a channel post.
//
// Individual test files still mkdtemp their own BOT_DATA_DIR where they need to
// write; this only guarantees nothing falls through to the real one.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-test-"));
// The file list is built here rather than left to `node --test`'s discovery,
// for two reasons: discovery treats ANY file named test.js as a test file (so a
// runner at scripts/test.js finds and re-spawns itself), and `node --test test/`
// is not a directory scan in this Node version — it tries to LOAD "test" as a
// module and dies with MODULE_NOT_FOUND.
const args = process.argv.slice(2);
const files = args.length
  ? args
  : fs
      .readdirSync(path.join(__dirname, "..", "test"))
      .filter((f) => f.endsWith(".test.js"))
      .sort()
      .map((f) => path.join("test", f));
// Every test process is OFFLINE BY CONSTRUCTION — see scripts/offline-guard.js
// for the CI run that proved the suite had only ever been offline by accident.
// Quoted, because NODE_OPTIONS splits on spaces and a checkout path may have one.
const netLog = path.join(dir, "net.log");
const guard = path.join(__dirname, "offline-guard.js");
const res = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(guard)}`].filter(Boolean).join(" "),
    TEST_NET_LOG: netLog,
    BOT_DATA_DIR: dir,
    // The GeckoTerminal limiter paces against a REMOTE quota, and there is no
    // remote here — every test stubs global.fetch. Left at the production
    // default it makes the suite wait 2.4s per stubbed request. Raised, not
    // disabled, so the queue and the priority ordering are still exercised.
    GT_MAX_RPM: process.env.GT_MAX_RPM || "100000",
    // The post's market read pauses between attempts to let a refusing or
    // queued upstream clear — against a REAL upstream. Every test stubs fetch,
    // so the pause is pure wall-clock; 0 still runs every attempt.
    POST_MARKET_PAUSE_MS: process.env.POST_MARKET_PAUSE_MS || "0",
    // The free-listing contract check asks GoPlus/RugCheck, and there is no
    // remote here. Off by default in the suite; listingSafety.test.js turns it
    // back on and drives it, and pins that the PRODUCTION default is on.
    FREE_LISTING_SAFETY: process.env.FREE_LISTING_SAFETY || "0",
    // The free-listing artwork lookup (services/listingLogo) asks the image
    // proxy and five logo sources, and uploads what it finds — none of which
    // exists here. Off by default in the suite, exactly like the safety check;
    // listingLogo.test.js turns it back on with stubbed sources.
    FREE_LISTING_LOGO: process.env.FREE_LISTING_LOGO || "0",
    // …and the guarded direct fetch of a host the proxy refuses must never make
    // a real request to a stranger from a test. Its own tests inject `request`.
    LOGO_GUARDED_FETCH: process.env.LOGO_GUARDED_FETCH || "0",
    // The listing form's on-chain Solana metadata read (solanaMeta.js) asks a
    // Solana RPC and an IPFS gateway — neither exists here. solanaMeta.test.js
    // turns it back on with stubbed reads, and pins that blank means ON.
    SOLANA_META: process.env.SOLANA_META || "0",
    // The premium listing clip renders 150 frames through ffmpeg — seconds of
    // CPU per listing post, and every fulfilment test posts one. Off by default
    // in the suite so those tests keep exercising the ladder they were written
    // for; listingMotion.test.js turns it back on and drives it.
    LISTING_MOTION: process.env.LISTING_MOTION || "0",
    // …and the pump alert's gauge clip, for the same reason: pumpMotion.test.js
    // turns it back on and drives it.
    PUMP_MOTION: process.env.PUMP_MOTION || "0",
  },
});
// A test that reached for the internet was refused, and passed or failed on
// that refusal — the same everywhere now, but still a test leaning on a stub it
// never wrote. Said once, after the run, so a leak is visible rather than
// silent; it does not turn the exit code.
try {
  const lines = fs.existsSync(netLog) ? fs.readFileSync(netLog, "utf8").split("\n").filter(Boolean) : [];
  if (lines.length) {
    const byFile = new Map();
    for (const l of lines) {
      const [file, host] = l.split("\t");
      if (!byFile.has(file)) byFile.set(file, new Set());
      byFile.get(file).add(host);
    }
    console.error(`\n⚠ ${byFile.size} test file(s) reached for the internet and were refused (the suite is offline — stub the request):`);
    for (const [file, hosts] of [...byFile].sort()) console.error(`  ${file} → ${[...hosts].sort().join(", ")}`);
  }
} catch {
  /* the report is informational; it must never change the result */
}
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* best-effort cleanup */
}
process.exit(res.status == null ? 1 : res.status);
