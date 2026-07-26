// /verified sold verification for "1.5 SOL / one-time" — a price that appears
// in no package on this site and in no product in the bot, so nothing could
// quote it and nothing could collect it. And the badge it was selling is
// already included in Diamond, Gold and Platinum: a project that had just paid
// 5 SOL for Diamond read that page and concluded it owed another 1.5 SOL.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { LISTING_TIERS, tierPrice } from "./packages.ts";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const page = () => read("src/app/(site)/verified/page.tsx");
/** The file with its comments removed. The comment above the fix quotes the old
 *  copy on purpose, to tell the next reader why it went — so every assertion
 *  about what a VISITOR sees has to read the code, not the explanation. */
const rendered = () =>
  page()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("no price on the page that the bot cannot charge", () => {
  const src = rendered();
  assert.ok(!/1\.5 SOL/.test(src), "the invented standalone price is gone");
  // Every number a buyer sees must come from the shared tier table.
  assert.match(src, /tierPrice\(/, "prices are read, not written");
  assert.ok(!/\d+(\.\d+)?\s*(SOL|BNB|ETH|TON|TRX)/.test(src), "no hardcoded amount survives");
});

test("the tiers shown are exactly the ones that include the badge", () => {
  const src = rendered();
  assert.match(src, /LISTING_TIERS\.filter\(\(t\) => t\.verified\)/);
  const withBadge = LISTING_TIERS.filter((t) => t.verified).map((t) => t.key);
  assert.deepStrictEqual(withBadge, ["DIAMOND", "GOLD", "PLATINUM"], "the tiers whose blurbs promise it");
  // Their own blurbs are the source this was checked against.
  for (const t of LISTING_TIERS.filter((x) => x.verified)) {
    assert.match(t.blurb, /verified badge/i, `${t.key} claims the badge in its blurb`);
  }
  for (const t of LISTING_TIERS.filter((x) => !x.verified && !x.instant)) {
    assert.ok(!/verified badge/i.test(t.blurb), `${t.key} must not promise a badge it does not include`);
  }
});

test("the page says plainly there is no separate fee", () => {
  // The whole defect was a buyer believing they owed twice. The subtitle has to
  // remove that belief before they read a single price.
  assert.match(rendered(), /no separate fee/i);
});

test("verification is data on the tier, not inferred from its rank", () => {
  // Two pages were each deciding it with `rank <= 3`. A sixth tier, or a
  // reordering, silently changes what both of them promise.
  assert.ok(!/rank <= 3 \? "Verified badge"/.test(read("src/app/(site)/advertise/page.tsx")));
  assert.match(read("src/app/(site)/advertise/page.tsx"), /tier\.verified \? "Verified badge"/);
  for (const t of LISTING_TIERS) assert.strictEqual(typeof t.verified, "boolean", `${t.key} needs the flag`);
});

test("the site and the bot charge the same for every tier on every chain", () => {
  // They are separate files in separate runtimes; a price edited in one and not
  // the other means the page quotes what the bot will refuse to take.
  const botSrc = read("bot/src/config/packages.js");
  for (const t of LISTING_TIERS) {
    if (t.key === "FREE") continue;
    const m = new RegExp(`key: "${t.key}"[\\s\\S]*?price: \\{([^}]*)\\}`).exec(botSrc);
    assert.ok(m, `${t.key} missing from the bot's packages`);
    for (const [sym, amount] of Object.entries(t.price)) {
      const bm = new RegExp(`${sym}:\\s*([\\d.]+)`).exec(m[1]);
      assert.ok(bm, `${t.key}/${sym} missing in the bot`);
      assert.strictEqual(Number(bm[1]), amount, `${t.key}/${sym}: site ${amount}, bot ${bm[1]}`);
    }
  }
});

test("every chain the page offers has a price for every badge tier", () => {
  // An empty price renders as "—", which on a pricing page reads as broken.
  for (const t of LISTING_TIERS.filter((x) => x.verified)) {
    for (const chain of ["solana", "bsc", "ethereum", "base"]) {
      assert.ok(tierPrice(t.key, chain) != null, `${t.key} has no price on ${chain}`);
    }
  }
});
