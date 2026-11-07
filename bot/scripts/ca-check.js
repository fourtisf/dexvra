#!/usr/bin/env node
// "Will a pasted DexScreener link or pair address read as the TOKEN — from THIS
// box, right now?"
//
// "bot tidak bisa baca ca token" (2026-10-30) was a project owner pasting
// `dexscreener.com/bsc/0x…` — the POOL — and every door reading it as either
// "not a valid address" or as the token itself. helpers/caInput.js is the fix,
// and it stands on two facts nothing in this repo can settle from a sandbox:
// that DexScreener's documented pair endpoint answers THIS server, and that it
// still describes a pair the way shared/dexscreener/pair.js reads one.
//
// So this measures the promise end to end on real data, through the bot's own
// resolver (never a second copy of the question):
//
//   1. a listed token's own address must read as ITSELF — never as a pair;
//   2. the DexScreener link to that token's deepest pair must read BACK as the
//      same token — the exact paste that started this;
//   3. with --all, every listing's stored address is asked whether it is a
//      PAIR. A listing created before the fix with the pool as its contract is
//      a row no price read can ever find; this names it and the token it
//      should be. Read-only — it changes nothing.
//
// With an argument it drives that one input instead: a dexscreener.com link or
// a contract address, exactly as a person would paste it.
//
// Exit 0 when links and pairs read as their token (a token DexScreener has no
// pair for is skipped and SAID, not failed); non-zero when a round trip comes
// back wrong, a listing is stored as a pair, DexScreener cannot be asked at
// all — the state in which every pasted link is refused, for everybody — or the
// --all scan could not finish.
//
// ⚠️ "WE COULD NOT ASK" IS NOT "NOT A PAIR". The first live --all run sent four
// unpaced workers at DexScreener, drew a 429 within seconds, benched itself —
// and then resolved every remaining listing instantly "as typed" and counted
// each one as not a pair, ending on a green "✓ no listing is stored as a pair"
// over hundreds of rows it never asked about. The resolver now says when a bare
// address went unchecked (`unverified`), and nothing here counts one as clean.
//
// ⚠️ AND THE SCAN WAS SPENDING THE BOT'S ALLOWANCE. DexScreener meters per IP
// and the running bot reads it all day from this same box, so a diagnostic
// that draws a 429 backs the bot off too. One request at a time, paced to half
// of DexScreener's documented 300/min (`CA_CHECK_GAP_MS`), and it STOPS at the
// first refusal rather than keep the box refused — printing the complete line
// that resumes it from the row where it stopped.

// ⚠️ .env FIRST — config/constants freezes every value at require time.
require("../src/config/loadEnv").loadEnv();

const build = require("../src/helpers/build");
const caInput = require("../src/helpers/caInput");
const api = require("../src/api/dexvra");
const { DEXSCREENER_SLUG } = require("../src/config/chains");
const dsPair = require("../../shared/dexscreener/pair");
const dexscreener = require("../src/dexscreener");
const log = require("../src/helpers/logger");

// Half of DexScreener's documented 300 requests/min for its pair endpoints: the
// running bot shares this IP and its allowance. Blank is ABSENT (`Number('')`
// is 0); an explicit 0 is honoured, for a box that knows it is alone.
const envGap = String(process.env.CA_CHECK_GAP_MS ?? "").trim();
const GAP_MS = envGap !== "" && Number.isFinite(Number(envGap)) ? Math.max(0, Number(envGap)) : 500;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** The --all scan reports every outcome itself, with more than the resolver's
 *  one-line `[ca]` note — so those notes are held for its duration rather than
 *  printed once per listing. Restored in `finally`, warnings untouched. */
async function withCaNotesHeld(fn) {
  const info = log.info;
  log.info = (...a) => (String(a[0]).startsWith("[ca]") ? undefined : info(...a));
  try {
    return await fn();
  } finally {
    log.info = info;
  }
}

const tty = process.stdout.isTTY;
const B = tty ? "\x1b[1m" : "";
const D = tty ? "\x1b[2m" : "";
const X = tty ? "\x1b[0m" : "";
const short = (a) => {
  const s = String(a || "");
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
};

/** The deepest DexScreener pair for a token on its chain — the fixture for the
 *  round trip. Not the question under test (that is caInput), so a plain read. */
async function topPair(row, fetchJson) {
  const slug = DEXSCREENER_SLUG[row.chain];
  if (!slug) return { ok: true, pair: null, why: `DexScreener does not index ${row.chain}` };
  const q = /^0x[0-9a-f]+$/i.test(row.address) ? row.address.toLowerCase() : row.address;
  const r = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(q)}`, { timeoutMs: 8000 });
  if (!r.ok) return { ok: false, pair: null, why: r.why };
  const pairs = ((r.body && r.body.pairs) || []).filter(
    (p) => p && p.chainId === slug && p.pairAddress && dsPair.sameAddress(p.baseToken && p.baseToken.address, row.address),
  );
  pairs.sort((a, b) => (Number(b.liquidity && b.liquidity.usd) || 0) - (Number(a.liquidity && a.liquidity.usd) || 0));
  return { ok: true, pair: pairs[0] || null, slug, why: pairs.length ? null : "no pair on DexScreener yet" };
}

/** Newest first, one per chain before seconds — a sample that covers networks. */
function sample(rows, n) {
  const live = rows.filter((r) => r && r.address && r.chain && (r.status || "approved") === "approved");
  live.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const out = [];
  const seen = new Set();
  for (const r of live) if (!seen.has(r.chain) && out.length < n) (seen.add(r.chain), out.push(r));
  for (const r of live) if (!out.includes(r) && out.length < n) out.push(r);
  return out;
}

async function run({
  argv = process.argv.slice(2),
  print = console.log,
  fetchJson = dsPair.defaultFetchJson,
  getListings = api.getListings,
  gapMs = GAP_MS,
  sleep = sleepMs,
} = {}) {
  const all = argv.includes("--all");
  const fromArg = argv.find((a) => /^--from=\d+$/.test(a));
  const from = fromArg ? Number(fromArg.slice(7)) : 0;
  const arg = argv.find((a) => !a.startsWith("--"));
  print(`\n${B}Contract input — does a DexScreener link or pair read as the TOKEN?${X}   ${D}build ${build.stamp()}${X}\n`);
  const faults = [];
  let asked = 0;
  let unread = 0;

  if (arg) {
    const r = await caInput.resolveInput(arg);
    if (!r) {
      print(`  ✗ that is neither a contract address on a supported chain nor a dexscreener.com link`);
      return { code: 1, faults: ["not an address or a link"] };
    }
    if (r.refused) {
      print(`  ✗ refused — ${r.refused}`);
      return { code: 1, faults: [r.refused] };
    }
    print(`  ✓ reads as ${r.address}${r.chain ? ` on ${r.chain}` : ""}  ${D}(${r.via})${X}`);
    if (r.pair) print(`    ${D}that was the pair ${r.pair.pairAddress} (${r.pair.dexId || "dex"}) — every flow stores the token above, and the buy bot watches the pair${X}`);
    else if (r.via === "plain") print(`    ${D}not a pair DexScreener knows — taken as the token it was typed as${X}`);
    return { code: 0, faults };
  }

  let rows;
  try {
    rows = await getListings();
  } catch (e) {
    print(`  ✗ could not read the listings API: ${e.message}`);
    return { code: 1, faults: ["listings API"] };
  }
  const picks = sample(rows, 8);
  print(`${B}1 · Round trip on ${picks.length} real listing(s)${X}  ${D}a token reads as itself; its DexScreener link reads back as it${X}`);
  for (const row of picks) {
    const label = `${row.sym || "$?"} ${row.chain}/${short(row.address)}`;
    const self = await caInput.resolveInput(row.address, { chain: row.chain });
    asked++;
    if (self && self.pair) {
      faults.push(`${label} is STORED AS A PAIR`);
      print(`  ✗ ${label} — the listing's own address is a DexScreener PAIR; its token is ${self.address}`);
      continue;
    }
    if (self && self.unverified) {
      unread++;
      print(`  ⚠ ${label} — could not ask DexScreener whether its own address is a pair: ${self.unverified}`);
      continue;
    }
    // The fixture read below is not the resolver's transport, so it would ask a
    // host this process has just been told to leave alone.
    const held = dexscreener.benched();
    if (held) {
      unread++;
      print(`  ⚠ ${label} — not asked for its pair: ${held}`);
      continue;
    }
    const tp = await topPair(row, fetchJson);
    if (!tp.ok) {
      unread++;
      print(`  ⚠ ${label} — could not ask DexScreener for its pair: ${tp.why}`);
      continue;
    }
    if (!tp.pair) {
      print(`  · ${label} — ${tp.why}; nothing to round-trip`);
      continue;
    }
    const link = `https://dexscreener.com/${tp.slug}/${tp.pair.pairAddress}`;
    const back = await caInput.resolveInput(link);
    asked++;
    if (back && back.refused) {
      if (/couldn't read/.test(back.refused)) unread++;
      else faults.push(`${label} link refused`);
      print(`  ${/couldn't read/.test(back.refused) ? "⚠" : "✗"} ${label} — its link was refused: ${back.refused}`);
      continue;
    }
    if (!back || !dsPair.sameAddress(back.address, row.address)) {
      faults.push(`${label} link read as ${back && back.address}`);
      print(`  ✗ ${label} — its DexScreener link read as ${back ? back.address : "nothing"}, not the token`);
      continue;
    }
    print(`  ✓ ${label} — link to its pair ${short(tp.pair.pairAddress)} reads back as the token`);
  }

  if (all) {
    // Oldest first, so a listing added between two runs lands at the END and a
    // printed --from still points at the row where the last run stopped.
    const live = rows
      .filter((r) => r && r.address && r.chain && DEXSCREENER_SLUG[r.chain])
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || `${a.chain}:${a.address}`.localeCompare(`${b.chain}:${b.address}`));
    const start = Math.min(from, live.length);
    const todo = live.length - start;
    print(
      `\n${B}2 · Every listing (${live.length}) — is any STORED as a pair?${X}  ${D}read-only · one at a time, ${gapMs}ms apart${start ? ` · from row ${start}` : ""}${X}`,
    );
    const stored = [];
    const unchecked = new Map(); // reason → count
    let checked = 0;
    let stoppedAt = null;
    let stoppedWhy = null;
    await withCaNotesHeld(async () => {
      // No bench check up here: a benched host answers the resolver without a
      // request, as `unverified`, and the check below stops on that same row.
      for (let k = start; k < live.length; k++) {
        if (k > start && gapMs > 0) await sleep(gapMs);
        const row = live[k];
        const r = await caInput.resolveInput(row.address, { chain: row.chain }).catch((e) => ({ unverified: `the lookup threw: ${e.message}` }));
        if (!r || r.unverified) {
          const why = r ? r.unverified : "not an address on its own chain";
          // A refusal benched the host: stop HERE, with this row unchecked, so
          // the resume line starts on it. Anything else (a timeout, a 5xx) is
          // one row, said, and the scan goes on.
          if (dexscreener.benched()) {
            stoppedAt = k;
            stoppedWhy = why;
            break;
          }
          unchecked.set(why, (unchecked.get(why) || 0) + 1);
          continue;
        }
        checked++;
        if (r.pair) stored.push({ row, token: r.address });
        if (checked % 50 === 0) print(`  ${D}… ${k + 1 - start}/${todo}${X}`);
      }
    });
    for (const st of stored) {
      faults.push(`${st.row.chain}/${st.row.address} is stored as a pair`);
      print(`  ✗ ${st.row.sym || "$?"} ${st.row.chain}/${st.row.address} is a PAIR — the token is ${st.token}`);
    }
    if (stored.length) {
      // The contract is not an editable field (adminValidate refuses it), and a
      // listing is public and paid for — so this names the rows and stops. What
      // to do with one is an admin's decision: 🗑 in the admin panel, then list
      // the token above.
      print(`  ${D}these rows can never be priced as they stand; replacing one is an admin decision in the panel${X}`);
    }
    const skipped = [...unchecked.values()].reduce((a, b) => a + b, 0);
    if (skipped) {
      faults.push(`${skipped} listing(s) could not be asked`);
      for (const [why, n] of unchecked) print(`  ⚠ ${n} listing(s) not checked — ${why}`);
    }
    if (stoppedAt != null) {
      faults.push(`--all stopped after ${checked} of ${todo}`);
      print(`  ⚠ stopped after ${checked} of ${todo} — ${stoppedWhy}`);
      print(`    ${D}the running bot reads DexScreener from this same server, so the scan stops rather than keep it refused${X}`);
      print(`    continue from where it stopped, once DexScreener answers again:`);
      print(`    cd /opt/dexvra/bot && npm run ca:check -- --all --from=${stoppedAt}`);
    }
    if (!stored.length) {
      if (stoppedAt == null && !skipped) print(`  ✓ no listing is stored as a pair  ${D}(${checked} checked)${X}`);
      else print(`  · none of the ${checked} checked is stored as a pair — ${todo - checked} were NOT checked, so this says nothing about them`);
    }
  }

  print("");
  if (asked && unread >= asked) faults.push("DexScreener did not answer");
  if (!faults.length) {
    print(`${B}✓ A pasted DexScreener link or pair reads as the token it trades, from this box.${X}`);
    if (unread) print(`  ${D}${unread} read(s) could not ask DexScreener — a pasted link is refused (never guessed) while that lasts.${X}`);
    return { code: 0, faults };
  }
  print(`${B}✗ ${faults.length} problem(s):${X}`);
  for (const f of faults) print(`  · ${f}`);
  if (faults.includes("DexScreener did not answer")) {
    print(`  ${D}Every pasted link is refused while DexScreener does not answer this server; a bare contract still works.${X}`);
    print(`  ${D}pm2 logs dexvra-bot --lines 300 --nostream | grep -F '[ca]'  names the reason the bot itself saw.${X}`);
  }
  return { code: 1, faults };
}

module.exports = { run, sample, topPair };

if (require.main === module) {
  run()
    .then((r) => process.exit(r.code))
    .catch((e) => {
      console.error(`ca:check failed: ${e && e.stack ? e.stack : e}`);
      process.exit(1);
    });
}
