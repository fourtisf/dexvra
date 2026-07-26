// The footer shipped <a>X</a> and <a>Telegram</a> with no href — they looked
// like links, hovered like links, and went nowhere. Anyone who wanted to follow
// the project from the site simply could not.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { BOT_URL, TELEGRAM_URL, TELEGRAM_LISTING_URL, TELEGRAM_TRENDING_URL, X_URL } from "./brand.ts";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

test("every social constant is an absolute https URL", () => {
  for (const [name, url] of Object.entries({ BOT_URL, TELEGRAM_URL, TELEGRAM_LISTING_URL, TELEGRAM_TRENDING_URL, X_URL })) {
    assert.match(url, /^https:\/\//, `${name} must be absolute — a relative one resolves against dexvra.io`);
    assert.doesNotMatch(url, /\s|@$/, `${name} looks malformed: ${url}`);
  }
});

test("the handles match the accounts the bot actually posts from", () => {
  // The bot's CHANNELS config and the channel artwork both name these. Three
  // places quoting one account is how a rename leaves a dead link behind.
  assert.strictEqual(TELEGRAM_URL, "https://t.me/dexvraio");
  assert.strictEqual(TELEGRAM_LISTING_URL, "https://t.me/dexvralisting");
  assert.strictEqual(TELEGRAM_TRENDING_URL, "https://t.me/dexvratrending");
  assert.strictEqual(BOT_URL, "https://t.me/dexvrabot");
});

test("the footer's social links have a real href and open safely", () => {
  const src = read("src/app/(site)/layout.tsx");
  for (const v of ["TELEGRAM_URL", "X_URL", "BOT_URL", "TELEGRAM_TRENDING_URL"]) {
    assert.ok(src.includes(`href={${v}}`), `the footer must link ${v}`);
  }
  // target=_blank without noopener hands the opened tab a window.opener handle.
  const anchors = src.match(/<a [^>]*target="_blank"[^>]*>/g) || [];
  assert.ok(anchors.length >= 4);
  for (const a of anchors) assert.match(a, /rel="noopener noreferrer"/, a);
});

test("nothing that is not a link still looks like one", () => {
  // Docs and API have no page yet. They stay as plain text rather than as
  // anchors that do nothing when clicked.
  const src = read("src/app/(site)/layout.tsx");
  assert.ok(!/<a>\s*(Docs|API|X|Telegram)\s*<\/a>/.test(src), "an <a> with no href is a lie");
  assert.match(src, /foot-soon">Docs</);
  assert.match(src, /foot-soon">API</);
  assert.match(read("src/app/globals.css"), /\.foot \.foot-soon\{/, "…and it is styled as inert");
});

test("the sidebar carries the community links too", () => {
  // The footer sits below the fold on every long board; the sidebar is where
  // someone looks for "where do I follow this".
  const src = read("src/components/Sidebar.tsx");
  assert.ok(src.includes("href={TELEGRAM_URL}"));
  assert.ok(src.includes("href={X_URL}"));
  assert.match(src, /className="side-soc"/);
  assert.match(read("src/app/globals.css"), /\.side-soc\{/, "the row must be styled, not inherit nav spacing");
});

test("Get Verified sends the applicant somewhere real", () => {
  // It was a button that popped "Verification request sent ✓ — reviewed within
  // 24h" and sent nothing anywhere. The applicant walked away believing they
  // had applied, and nobody was ever told.
  const src = read("src/app/(site)/verified/page.tsx");
  // The comment above the fix quotes the old string on purpose, so match the
  // CALL, not the words.
  assert.ok(!/toast\(["'][^"']*Verification request sent/.test(src), "the page must not claim something it did not do");
  assert.ok(!src.includes("useApp"), "…and no longer needs the toast at all");
  assert.match(src, /href=\{BOT_URL\}/, "the CTA goes to the bot, exactly like /advertise");
  assert.match(src, /href=\{TELEGRAM_URL\}/, "and Dexvra is reachable before paying 1.5 SOL");
  assert.match(src, /href=\{X_URL\}/);
});

test("no page fakes an action with a toast", () => {
  // One page doing it is a bug; the pattern spreading is a habit. This fails
  // the moment another "sent ✓" button appears anywhere under (site).
  const dir = path.join(process.cwd(), "src/app/(site)");
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : [];
    });
  for (const file of walk(dir)) {
    const src = fs.readFileSync(file, "utf8");
    assert.ok(
      !/onClick=\{\(\) => toast\(["'][^"']*(sent|submitted|request)/i.test(src),
      `${path.relative(process.cwd(), file)} pretends an action succeeded without doing it`,
    );
  }
});
