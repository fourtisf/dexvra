// Explicit .env loading.
//
// `require("dotenv").config()` resolves ".env" against process.cwd(), and under
// PM2 the cwd is whatever the process was FIRST started with — not the
// directory you were standing in when you ran `pm2 restart`. So a .env placed
// one level up (repo root instead of bot/, or the other way round) looks
// completely correct, is edited, is re-read by nobody, and the operator is left
// staring at a setting that "won't apply". Every plausible location is loaded
// explicitly instead, and the boot log names the files that were actually used.
//
// override:true — .env beats PM2's stale env snapshot, which it re-injects on
// every restart (--update-env only overlays the current shell). A live incident
// had POST_BANNERS=0 survive every restart that way.
const path = require("node:path");
const fs = require("node:fs");

const BOT_DIR = path.join(__dirname, "..", ".."); // <repo>/bot
const REPO_DIR = path.join(BOT_DIR, ".."); // <repo>

/** Load .env from repo root, bot/, and cwd — general first, so the most
 *  specific file wins. Returns the absolute paths that existed. */
function loadEnv() {
  const dotenv = require("dotenv");
  const seen = new Set();
  const loaded = [];
  for (const file of [path.join(REPO_DIR, ".env"), path.join(BOT_DIR, ".env"), path.resolve(process.cwd(), ".env")]) {
    const real = path.resolve(file);
    if (seen.has(real)) continue;
    seen.add(real);
    if (!fs.existsSync(real)) continue;
    dotenv.config({ path: real, override: true });
    loaded.push(real);
  }
  return loaded;
}

module.exports = { loadEnv, BOT_DIR, REPO_DIR };
