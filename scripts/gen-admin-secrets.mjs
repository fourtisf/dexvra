#!/usr/bin/env node
// Generate the admin panel secrets. Run on the VPS, then paste the printed
// lines into .env.local (never commit them).
//
//   node scripts/gen-admin-secrets.mjs <username> <password>
//
// Regenerates ADMIN_PATH + ADMIN_SESSION_SECRET each run; pass the same
// username/password to keep your login stable.

import { scryptSync, randomBytes } from "node:crypto";

const [, , username = "admin", password] = process.argv;

if (!password) {
  console.error("Usage: node scripts/gen-admin-secrets.mjs <username> <password>");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32);
const passHash = `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
const sessionSecret = randomBytes(32).toString("hex");
const adminPath = `admin-${randomBytes(16).toString("hex")}`;

console.log(`
# ── Dexvra admin (.env.local — do NOT commit) ──────────────────────────
ADMIN_USER=${username}
ADMIN_PASS_HASH=${passHash}
ADMIN_SESSION_SECRET=${sessionSecret}
ADMIN_PATH=${adminPath}
ADMIN_HOSTS=dexvra.fun,www.dexvra.fun

# Your admin URL:
#   https://dexvra.fun/${adminPath}
`);
