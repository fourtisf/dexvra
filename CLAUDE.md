# Dexvra — working notes

## Repo layout

| Path | What it is | Runs as |
| --- | --- | --- |
| `src/`, root `package.json` | Next.js 14 web app (dexvra.io) | PM2 `dexvra`, port 3005 |
| `bot/` | Telegram bot — listings, trending, banners, group buy bot, raids | PM2 `dexvra-bot` **and** `dexvra-adminbot` |
| `tradebot/` | The trade bot, a separate process in the same repo | its own PM2 process |

Production server: the repo is checked out at **`/opt/dexvra`**. Never write
`/path/to/dexvra` in an instruction — it has been pasted literally into a live
shell before.

## Release flow — `main` is what the server runs

**Every change ends up on `main`, and the server only ever deploys `main`.**
Feature branches exist to build and review on; they are never the thing a
server checks out.

1. Build on a branch (`claude/<topic>`), commit there.
2. Run the full suite for whatever you touched — **it must be green before the
   merge, not after**:
   ```bash
   cd bot && npm test          # bot/       (~930 tests)
   npm test                    # web app, from the repo root
   cd tradebot && npm test     # tradebot/
   ```
3. Merge into `main` and push `main`.
4. Deploy on the server **from `main`** — see [`bot/DEPLOY.md`](bot/DEPLOY.md).

A branch left unmerged after it is deployed is the failure mode this rule
exists to prevent: the server sits on a branch, the next change is cut from
`main`, and the two silently diverge.

If a pull request for a branch has already been merged, do not add commits to
that branch — restart it from the current `main` and open a new one.

## Two bot processes, one config

`bot/` runs **two** PM2 processes: `dexvra-bot` (`main.js`) and
`dexvra-adminbot` (`adminbot.js`). Always restart via the ecosystem file:

```bash
cd /opt/dexvra/bot && pm2 restart ecosystem.config.js --update-env && pm2 ls
```

`pm2 restart dexvra-bot` leaves the admin bot on the old code. It fails
silently and confusingly — the main bot shows a new feature working while
@dexvraadminbot has no menu entry for it, which reads as "the feature is
missing" rather than "that process is stale". Confirm both are `online`.

## Admin-editable templates beat code defaults

`bot/src/templates.js` holds a built-in default for every message; anything an
admin saved in @dexvraadminbot lives in `data/templates.json` and **wins**.
So changing a default in code does nothing on a box where that template was
edited. Say so when shipping copy changes: the operator has to hit
**♻️ Reset default** on that template to pick the new copy up.

The same applies to `data/` generally — it is gitignored, lives only on the
server, and survives `git pull`. So do `.env` and `.keys/`.

## What does not need a web rebuild

If a change touches only `bot/`, there is no `npm run build` and no
`pm2 restart dexvra`. Check before telling anyone to rebuild:

```bash
git diff --name-only <base>..HEAD | grep -v '^bot/'
```

Empty output means bot-only.

## Conventions

- Tests live beside the code they cover, in `bot/test/`, `tradebot/*.test.js`
  and `src/**/*.test.ts`. A behaviour change without a test that would have
  caught the old behaviour is not finished.
- Comments explain **why**, and name the failure the code is shaped around.
  Match the density of the file you are editing.
- Operator-facing strings in @dexvraadminbot are **Indonesian**; user-facing
  bot copy and channel posts are English.
