#!/usr/bin/env bash
#
# Deploy the checkout this script lives in. Run it ON the server:
#
#   bash /opt/dexvra/scripts/deploy.sh
#
# There is no path to fill in and no host to name: the repo root is derived
# from this file's own location, so the script cannot be pointed at the wrong
# tree by a typo. Add --with-bots to restart the bot suite too.
#
# Idempotent — running it twice in a row is a no-op after the first, except
# that it verifies the running build again.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WITH_BOTS=0
for arg in "$@"; do
  case "$arg" in
    --with-bots) WITH_BOTS=1 ;;
    *) echo "unknown option: $arg (only --with-bots is supported)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ── 1. Refuse to deploy on top of uncommitted work ────────────────────────
# A deploy that stashes or clobbers an operator's edit is how a hotfix made on
# the box disappears without anyone noticing it is gone.
step "Checking the working tree"
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "the working tree has changes — commit, stash or discard them first"
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BEFORE="$(git rev-parse --short HEAD)"
echo "on $BRANCH at $BEFORE"

# ── 2. Fast-forward only ──────────────────────────────────────────────────
step "Fetching origin/$BRANCH"
git fetch origin "$BRANCH"
git merge --ff-only "origin/$BRANCH" || die "cannot fast-forward — the box has commits origin does not; resolve by hand"
AFTER="$(git rev-parse --short HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "already at $AFTER — nothing new to pull"
else
  echo "$BEFORE → $AFTER"
  git --no-pager log --oneline "$BEFORE..$AFTER" | head -20
fi

# ── 3. Dependencies ───────────────────────────────────────────────────────
# `npm ci` from the lockfile, never `npm install`: a deploy must install the
# versions that were tested, not resolve new ones on the box.
#
# WITH devDependencies, deliberately. `--omit=dev` looks right for a server and
# is wrong here: the build happens ON this box, and next build needs typescript
# and the @types packages to compile at all. Omitting them fails the build with
# a message about TypeScript not being installed, several minutes in.
step "Installing dependencies"
npm ci --no-audit --no-fund
for pkg in bot tradebot; do
  if [ -f "$pkg/package-lock.json" ]; then
    echo "· $pkg"
    (cd "$pkg" && npm ci --no-audit --no-fund)
  fi
done

# ── 4. Tests before build ─────────────────────────────────────────────────
# Both suites are offline, so a box with egress blocked still runs them, and a
# red test stops the deploy here while the old build is still the one serving.
#
# ⚠️ BOTH NEED NODE 22, AND PRODUCTION RUNS 18. They are `node --test` over
# `.ts` files, which needs --experimental-strip-types (22.6+). Running them
# unconditionally makes the script abort on the one box it is written for — a
# deploy tool that cannot run on the server is "apt-get install is not a fix,
# it is a request", one feature over. So the box's Node decides, and a skip is
# LOUD: a silent one would read as a suite that passed.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 6 ]; }; then
  step "Running the test suites"
  npm test
  npm run test:pons
else
  step "Skipping the test suites"
  printf 'node %s cannot strip types — both suites need 22.6+.\n' "$(node -v)"
  printf 'They are the MERGE gate, not the deploy gate: run them where you develop.\n'
fi

# ── 5. Build ──────────────────────────────────────────────────────────────
# `npm run build` stamps NEXT_PUBLIC_BUILD from HEAD; step 7 reads it back out
# of the running server, which is the only way to tell a deployed build from a
# stale one.
step "Building"
npm run build

# ── 6. Restart ────────────────────────────────────────────────────────────
step "Restarting"
command -v pm2 >/dev/null || die "pm2 is not on PATH"
pm2 restart dexvra --update-env
if [ "$WITH_BOTS" = "1" ]; then
  # ⚠️ THE ECOSYSTEM FILE, NOT THE TWO NAMES. CLAUDE.md: bot/ runs BOTH
  # dexvra-bot and dexvra-adminbot, and restarting one by name leaves the other
  # on the old code — which fails silently and reads as a missing feature
  # rather than a stale process.
  if [ -f bot/ecosystem.config.js ]; then
    echo "· bot/ (dexvra-bot + dexvra-adminbot)"
    (cd bot && pm2 restart ecosystem.config.js --update-env)
  fi
  # The tradebot is its own process and its name differs between boxes, so an
  # absent one is skipped rather than failing the deploy.
  for proc in dexvra-tradebot dexvra-trade; do
    if pm2 describe "$proc" >/dev/null 2>&1; then
      echo "· $proc"
      pm2 restart "$proc" --update-env
    fi
  done
fi

# ── 7. Verify the running build is the one just built ─────────────────────
# Not "did it 200" — a stale process answers 200 perfectly well. This asks the
# server which commit it is serving and compares it to HEAD.
step "Verifying"
EXPECTED="$(git rev-parse --short HEAD)"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  SERVED="$(curl -fsS --max-time 5 http://127.0.0.1:3005/ 2>/dev/null | grep -o 'NEXT_PUBLIC_BUILD[^,}]*' | grep -o '[0-9a-f]\{7,\}' | head -1 || true)"
  [ -n "$SERVED" ] && break
  sleep 2
done

if [ -z "${SERVED:-}" ]; then
  echo "could not read the build stamp — checking the server answers at all"
  curl -fsS --max-time 5 -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3005/ \
    || die "the app is not answering on port 3005 — pm2 logs dexvra"
  echo "it answers, but the stamp was not readable; confirm with: pm2 logs dexvra --lines 40"
elif [ "$SERVED" = "$EXPECTED" ]; then
  printf '\033[32m✓ serving %s\033[0m\n' "$SERVED"
else
  die "the server is serving $SERVED but HEAD is $EXPECTED — the restart did not take"
fi

printf '\n\033[32m✓ deployed %s\033[0m\n' "$EXPECTED"
echo "logs: pm2 logs dexvra --lines 40"
