// Proving, from outside Telegram, what a group is actually pointed at.
//
// An operator opened a group they had never configured and found a token set
// in it. There was no way to check the claim: the admin bot never reads group
// config, and data/groups.json is a wall of chat ids. So "the bot invented a
// CA" and "somebody pasted one weeks ago" looked identical from every angle
// available to them — and neither could be proved or cleared.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const { execFileSync } = require("node:child_process");

const test = require("node:test");
const assert = require("node:assert");

const SCRIPT = path.join(__dirname, "..", "scripts", "group-ca.js");
const ADDR = "8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS";

function withData(groups) {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-gca-"));
  fss.writeFileSync(path.join(dir, "groups.json"), JSON.stringify(groups));
  return dir;
}
const run = (dir, ...args) =>
  execFileSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, BOT_DATA_DIR: dir }, encoding: "utf8" });
const read = (dir) => JSON.parse(fss.readFileSync(path.join(dir, "groups.json"), "utf8"));

const configured = () => ({
  "-1001": {
    chatId: "-1001",
    on: true,
    minBuyUsd: 250,
    whaleWalletUsd: 75000,
    pin: false,
    createdAt: 1754000000000,
    chain: "solana",
    address: ADDR,
    pairAddress: "9dHV",
    sym: "ALON",
  },
  "-1002": { chatId: "-1002", on: false, minBuyUsd: 25, createdAt: 1754500000000 },
});

test("the listing shows every group, what it watches, and WHEN that was set", () => {
  // createdAt is the whole point: a configuration is either older than the
  // group's memory of setting it, or it is not. Without a date the argument
  // has nowhere to go.
  const dir = withData(configured());
  const out = run(dir);
  assert.match(out, new RegExp(ADDR), "the configured group names its token");
  assert.match(out, /— no token —/, "and an unconfigured one says so plainly");
  assert.match(out, /2025-/, "with the date it was created");
});

test("--clear removes the token and KEEPS the tuning", () => {
  // Swapping a contract is the ordinary reason to do this. Wiping the floor
  // and whale bar with it would only surface later, as an alert that came in
  // under a number nobody chose.
  const dir = withData(configured());
  run(dir, "-1001", "--clear");
  const g = read(dir)["-1001"];
  assert.strictEqual(g.address, null);
  assert.strictEqual(g.pairAddress, null);
  assert.strictEqual(g.sym, null);
  assert.strictEqual(g.minBuyUsd, 250, "the floor the admin chose survives");
  assert.strictEqual(g.whaleWalletUsd, 75000, "so does the whale bar");
  assert.strictEqual(g.pin, false, "and the pin setting");
});

test("a cleared group is no longer polled, but its row survives", () => {
  // cfg.active() requires an address, so a row without one calls nothing —
  // which is why the token is nulled rather than the row deleted.
  const dir = withData(configured());
  run(dir, "-1001", "--clear");
  const rows = read(dir);
  assert.ok(rows["-1001"], "the row is kept, so the tuning has somewhere to live");
  const cfgPath = require.resolve("../src/group/config");
  delete require.cache[cfgPath];
  process.env.BOT_DATA_DIR = dir;
  const cfg = require("../src/group/config");
  cfg.reload();
  assert.deepStrictEqual(cfg.active(), [], "and nothing without an address is ever polled");
});

test("clearing a group that has no token says so instead of pretending to work", () => {
  const dir = withData(configured());
  assert.match(run(dir, "-1002", "--clear"), /already has no token/i);
});
