#!/usr/bin/env node
// Dexvra Raid: which X metric source actually answers from THIS server?
//
// WHY THIS SCRIPT EXISTS
// A raid never fails loudly. If no X source answers it launches crew-only and
// carries on, which is the right behaviour and also means a broken key, an
// exhausted prepaid balance or an IP block all look identical from the group:
// a raid with no like counts. This asks each source in turn and says which one
// answered, so the difference is one command instead of an afternoon.
//
//     cd bot && npm run raid:check
//     cd bot && npm run raid:check -- https://x.com/dexvraio/status/123456
//
// Read-only: it fetches public post metrics and nothing else.
require("dotenv").config();

const xMetrics = require("../src/raid/xMetrics");
const xEmbed = require("../src/raid/xEmbed");
const xGuest = require("../src/raid/xGuest");

// Jack Dorsey's first tweet — public, permanent, and a useful control: if this
// fails, the problem is this server's access, not the post you were raiding.
const DEFAULT_POST = "20";

/**
 * Resolve the argument to a post id.
 *
 * Deliberately LOOSER than xMetrics.parseTweetId for a BARE numeric argument.
 * That parser requires 5-25 digits because it runs on messages typed into a
 * group chat, where a stray "42" must not be mistaken for a post. Here the
 * argument is unambiguous — someone ran this script and passed a number — and
 * being strict would reject the one id most worth probing with: early-Twitter
 * ids are short, and the control post above is two digits. (The reference
 * implementation shipped exactly this bug: its diagnostic answered "no post id"
 * and exited before making a single request.)
 */
function resolvePostId(arg) {
  const s = String(arg || "").trim();
  if (/^\d{1,25}$/.test(s)) return s;
  return xMetrics.parseTweetId(s);
}

const line = () => console.log("─".repeat(64));

async function tryOne(name, enabled, why, fn) {
  if (!enabled) {
    console.log(`   ${name.padEnd(22)} off        ${why}`);
    return null;
  }
  const res = await fn();
  if (res.ok) {
    const reposts = res.retweets == null ? "n/a" : res.retweets;
    console.log(`   ${name.padEnd(22)} ✅ ok      likes ${res.likes} · replies ${res.replies} · reposts ${reposts}`);
    if (res.retweets == null) {
      console.log(`   ${"".padEnd(22)}            (this source cannot see reposts — a repost goal would be dropped)`);
    }
    return res;
  }
  console.log(`   ${name.padEnd(22)} ❌ ${res.gone ? "gone" : "failed"}  ${res.error}`);
  if (res.advice) console.log(`   ${"".padEnd(22)}            ${res.advice}`);
  return null;
}

async function main() {
  const arg = process.argv[2] || DEFAULT_POST;
  const id = resolvePostId(arg);

  console.log("Dexvra Raid — X metrics check");
  line();
  if (!id) {
    console.log(`Could not read a post id out of: ${arg}`);
    console.log("Pass a full X post URL (it contains /status/) or a bare numeric id.");
    process.exit(2);
  }
  console.log(`post          : ${xMetrics.tweetUrl(id)}${arg === DEFAULT_POST ? "  (control post)" : ""}`);

  const raw = String(process.env.X_BEARER_TOKEN || "").trim();
  const token = xMetrics.apiToken();
  let tokenState;
  if (!raw) tokenState = "not set — raids will run crew-only unless a keyless source is on";
  else if (!token && /^A+$/.test(raw)) tokenState = "set, but it is the .env.example PLACEHOLDER — treated as absent, so it cannot arm a 401 backoff";
  else if (!token) tokenState = "set, but too short to be a real token — treated as absent";
  else tokenState = `set (${raw.length} chars)`;
  console.log(`X_BEARER_TOKEN: ${tokenState}`);
  line();

  console.log("\nSources, in the order the resolver tries them:\n");
  const api = await tryOne("paid API", !!token, "X_BEARER_TOKEN is not usable", async () => {
    // Go through the resolver so the cooldown and error mapping are the real ones.
    const res = await xMetrics.fetchTweetMetrics(id, { force: true });
    return res.source === "api" || !xGuest.isEnabled() ? res : { ok: false, error: "not reached" };
  });
  const guest = api
    ? null
    : await tryOne("guest GraphQL", xGuest.isEnabled(), "RAID_GUEST_METRICS=0", () => xGuest.fetchGuestMetrics(id));
  const embed = api || guest
    ? null
    : await tryOne("embed endpoint", xEmbed.isEnabled(), "RAID_FREE_METRICS=0", () => xEmbed.fetchEmbedMetrics(id));

  line();
  const winner = api || guest || embed;
  if (winner) {
    console.log(`\n✅ Raids on this server CAN read X (via the ${winner.source} source).`);
    if (winner.retweets == null) {
      console.log("   Reposts are not measurable from this source — set a paid X_BEARER_TOKEN if you need them.");
    }
    process.exit(0);
  }

  console.log("\n⚠️  No X source answered. Raids will still work — the 🤝 Crew goal needs no key at all —");
  console.log("   but likes/replies/reposts will be unavailable and the card will say so.");
  console.log("\n   To fix, pick one:");
  console.log("   • set a real X_BEARER_TOKEN (≈ half a cent per raid; reads are billed per post per day)");
  console.log("   • RAID_GUEST_METRICS=1 — keyless, includes reposts, blocked on many datacenter IPs");
  console.log("   • RAID_FREE_METRICS=1  — keyless, no reposts, and its reply count is the whole conversation");
  console.log("\n   If a keyless source is already on and failing, it is almost always this server's IP.");
  console.log("   A repeated 404 from the guest source instead means X rotated its GraphQL hash — set a");
  console.log("   current X_GUEST_QUERY_ID in .env and restart.");
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n❌ check failed: ${e && e.message}`);
  process.exit(1);
});
