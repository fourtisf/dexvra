// "Which .env is this process actually reading" is the first question behind
// every setting that appears not to apply. dotenv resolves ".env" against
// process.cwd(), and under PM2 the cwd is whatever the process was FIRST
// started with — not where you stood when you ran `pm2 restart`. A .env one
// directory off then looks correct and is read by nobody.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-env-"));

const test = require("node:test");
const assert = require("node:assert");
const { loadEnv, BOT_DIR, REPO_DIR } = require("../src/config/loadEnv");

test("both the repo root and bot/ are searched, not just the cwd", () => {
  // The two places an operator plausibly puts it. Only checking one is how a
  // treasury address gets set and never picked up.
  assert.strictEqual(path.basename(BOT_DIR), "bot");
  assert.strictEqual(REPO_DIR, path.join(BOT_DIR, ".."));
  const src = fss.readFileSync(require.resolve("../src/config/loadEnv.js"), "utf8");
  assert.match(src, /REPO_DIR, "\.env"/);
  assert.match(src, /BOT_DIR, "\.env"/);
  assert.match(src, /process\.cwd\(\), "\.env"/);
});

test("loadEnv returns the files it actually read, so boot can name them", () => {
  const loaded = loadEnv();
  assert.ok(Array.isArray(loaded));
  for (const f of loaded) {
    assert.ok(path.isAbsolute(f), `${f} must be absolute — a relative path names nothing useful`);
    assert.ok(fss.existsSync(f), `${f} was reported but does not exist`);
  }
  assert.strictEqual(new Set(loaded).size, loaded.length, "no file is loaded twice");
});

test("a missing .env is not an error — env vars may come from the shell", () => {
  assert.doesNotThrow(() => loadEnv());
});

test("both entry points load env this way and say which file won", () => {
  for (const entry of ["../main.js", "../adminbot.js"]) {
    const src = fss.readFileSync(require.resolve(entry), "utf8");
    assert.match(src, /require\("\.\/src\/config\/loadEnv"\)\.loadEnv\(\)/, `${entry} must use loadEnv`);
    assert.match(src, /\[env\] loaded/, `${entry} must log which .env it read`);
    assert.ok(!/require\("dotenv"\)\.config\(/.test(src), `${entry} must not also call dotenv directly`);
  }
});

test("the override that beats PM2's stale env snapshot is still there", () => {
  // PM2 re-injects the env it captured at the FIRST `pm2 start` on every
  // restart; --update-env only overlays the current shell. Without override a
  // stale snapshot silently wins over an edited .env (live incident:
  // POST_BANNERS=0 survived every restart).
  const src = fss.readFileSync(require.resolve("../src/config/loadEnv.js"), "utf8");
  assert.match(src, /override: true/);
});
