#!/usr/bin/env node
// One-time interactive GramJS login — creates the string-session file the bot
// uses to post premium emoji to channels. Run ON THE SERVER with the Telegram
// PREMIUM account you want posting to the channels:
//
//   cd /opt/dexvra/bot && node scripts/gramjs-login.js
//
// Requires API_ID + API_HASH in .env (create at https://my.telegram.org/apps —
// log in with the SAME premium account). The account must be able to post in
// every channel (@dexvraio / @dexvratrending / @dexvralisting).
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const readline = require("node:readline");
const fs = require("node:fs/promises");
const { API_ID, API_HASH, GRAMJS_SESSION_FILE } = require("../src/config/constants");

function ask(question, { hidden } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (hidden && rl.output) {
      // mask password input
      const onData = () => {
        readline.moveCursor(rl.output, -1, 0);
        rl.output.write("*");
      };
      process.stdin.on("data", onData);
      rl.question(question, (a) => {
        process.stdin.off("data", onData);
        rl.close();
        process.stdout.write("\n");
        resolve(a.trim());
      });
    } else {
      rl.question(question, (a) => {
        rl.close();
        resolve(a.trim());
      });
    }
  });
}

(async () => {
  if (!API_ID || !API_HASH) {
    console.error("✗ API_ID / API_HASH missing. Add them to .env first (https://my.telegram.org/apps).");
    process.exit(1);
  }
  const { TelegramClient } = require("telegram");
  const { StringSession } = require("telegram/sessions");
  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 5 });
  console.log("Logging in to Telegram (use the PREMIUM account that posts to the channels)…");
  await client.start({
    phoneNumber: () => ask("Phone number (with country code, e.g. +62…): "),
    phoneCode: () => ask("Code you received: "),
    password: () => ask("2FA password (empty if none): ", { hidden: true }),
    onError: (e) => console.error("  !", e.message),
  });
  const session = client.session.save();
  await fs.writeFile(GRAMJS_SESSION_FILE, session, { mode: 0o600 });
  const me = await client.getMe();
  console.log(`\n✓ Logged in as ${me.username ? "@" + me.username : me.firstName}${me.premium ? " (PREMIUM ✓)" : " (NOT premium — emoji will fall back to unicode!)"}`);
  console.log(`✓ Session saved to ${GRAMJS_SESSION_FILE}`);
  // Back the fresh session up to Mongo immediately (best-effort) so a container
  // reset auto-recovers this login without re-running this script.
  try {
    const mongo = require("../src/db/mongo");
    if (mongo.configured() && (await mongo.connect())) {
      await require("../src/db/mediaMirror").mirrorSession();
      console.log("✓ Session backed up to MongoDB");
    }
    await mongo.close();
  } catch (e) {
    console.warn(`  (session Mongo backup skipped: ${e && e.message})`);
  }
  console.log("\nNext: make sure this account can post in the channels, then restart the bot:");
  console.log("  pm2 restart dexvra-bot");
  await client.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("✗ Login failed:", e.message);
  process.exit(1);
});
