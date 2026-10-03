'use strict';
/**
 * The build stamp as a FILE, keyed by the PID that wrote it.
 *
 * ⚠️ `npm run deploy` ended red on a healthy box:
 *
 *     · dexvra-tradebot  no build stamp — did it start?
 *     ✗ da073b4 is checked out, but not everything is running it.
 *
 * Nothing was wrong. The tradebot was correctly NOT restarted (no tradebot/ or
 * shared/ file had changed), and the verifier went looking for its
 * `[boot] build <sha>` line in the last 2000 lines of `pm2 logs` — while the
 * snipe loop writes several lines a second, so that line had scrolled out of
 * reach hours earlier. "Not written recently" was reported as "did it start?".
 * This file already records that exact defect twice (the `[curve]` line lost
 * under `--lines 200`, the `[jup]` line lost under `--lines 40`): A FACT THAT
 * LIVES ONLY IN A LOG LINE IS NOT RETRIEVABLE.
 *
 * So every process also writes `<repo>/.run/build/<pid>.json` at boot:
 * `{ sha, pid, name, at }`. Keyed by PID, which is what makes it safe to read
 * at any time: the deploy asks pm2 for the pid of the process RUNNING NOW and
 * reads that file, so a stamp from an earlier boot can never be read as this
 * one — the stale-log-line rule the verifier already enforces, for free.
 *
 * Only under pm2 (`pm_id` is set): a test or a one-off script must not leave
 * stamps in the checkout. The directory is gitignored (`.run/`), because the
 * deploy refuses a dirty tree.
 *
 * BEST-EFFORT. A stamp file can never cost a boot: every failure is swallowed
 * into one console line, and the log line is still printed beside it.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = path.join(__dirname, '..', '.run', 'build');

/** Is `pid` a live process? EPERM means it exists under another user. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

/**
 * Write this process's stamp. Returns the path written, or null.
 * `opts.force` writes outside pm2 (tests); everything else has a default.
 */
function writeStamp(sha, opts = {}) {
  const underPm2 = process.env.pm_id != null && process.env.pm_id !== '';
  if (!underPm2 && !opts.force) return null;
  const dir = opts.dir || DEFAULT_DIR;
  const pid = opts.pid || process.pid;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Stamps of processes that are gone — a restart leaves one per boot, and
    // a directory that only grows is how a box fills up without anyone asking.
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d+)\.json$/.exec(f);
      if (m && Number(m[1]) !== pid && !(opts.isAlive || alive)(Number(m[1]))) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* raced — fine */ }
      }
    }
    const file = path.join(dir, `${pid}.json`);
    const tmp = `${file}.tmp`;
    const body = { sha: String(sha), pid, name: opts.name || process.env.name || null, at: opts.now || Date.now() };
    // Written then RENAMED, so the deploy can never read half a file.
    fs.writeFileSync(tmp, JSON.stringify(body) + '\n');
    fs.renameSync(tmp, file);
    return file;
  } catch (e) {
    console.warn(`[boot] build stamp file not written (${e.message}) — the deploy will fall back to the log line`);
    return null;
  }
}

/** The stamp `pid` wrote, or null. For the tests; the deploy reads it in bash. */
function readStamp(pid, dir = DEFAULT_DIR) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8'));
  } catch (_) {
    return null;
  }
}

module.exports = { writeStamp, readStamp, DEFAULT_DIR };
