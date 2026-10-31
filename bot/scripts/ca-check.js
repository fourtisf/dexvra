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
// back wrong, a listing is stored as a pair, or DexScreener cannot be asked at
// all — the state in which every pasted link is refused, for everybody.

// ⚠️ .env FIRST — config/constants freezes every value at require time.
require("../src/config/loadEnv").loadEnv();

const build = require("../src/helpers/build");
const caInput = require("../src/helpers/caInput");
const api = require("../src/api/dexvra");
const { DEXSCREENER_SLUG } = require("../src/config/chains");
const dsPair = require("../../shared/dexscreener/pair");

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

async function run({ argv = process.argv.slice(2), print = console.log, fetchJson = dsPair.defaultFetchJson, getListings = api.getListings } = {}) {
  const all = argv.includes("--all");
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
    const live = rows.filter((r) => r && r.address && r.chain && DEXSCREENER_SLUG[r.chain]);
    print(`\n${B}2 · Every listing (${live.length}) — is any STORED as a pair?${X}  ${D}read-only${X}`);
    let i = 0;
    const stored = [];
    const worker = async () => {
      while (i < live.length) {
        const row = live[i++];
        const r = await caInput.resolveInput(row.address, { chain: row.chain }).catch(() => null);
        if (r && r.pair) stored.push({ row, token: r.address });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    for (const s of stored) {
      faults.push(`${s.row.chain}/${s.row.address} is stored as a pair`);
      print(`  ✗ ${s.row.sym || "$?"} ${s.row.chain}/${s.row.address} is a PAIR — the token is ${s.token}`);
    }
    if (stored.length) {
      // The contract is not an editable field (adminValidate refuses it), and a
      // listing is public and paid for — so this names the rows and stops. What
      // to do with one is an admin's decision: 🗑 in the admin panel, then list
      // the token above.
      print(`  ${D}these rows can never be priced as they stand; replacing one is an admin decision in the panel${X}`);
    } else print(`  ✓ no listing is stored as a pair`);
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
