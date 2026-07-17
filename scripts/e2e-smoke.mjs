// Smoke test for the Phase 1 UI: drives every view and the behavior
// checklist from docs/HANDOFF.md section 7 against a running server.
//   BASE_URL=http://localhost:3000 CHROMIUM_PATH=... node scripts/e2e-smoke.mjs
// Note: "1h %" header check reads innerText, which is uppercased by CSS —
// compared case-insensitively for that reason.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
import { mkdirSync } from "node:fs";
const SHOT_DIR = process.env.SHOT_DIR ?? "e2e-shots";
mkdirSync(SHOT_DIR, { recursive: true });
const SHOT = (n) => `${SHOT_DIR}/${n}.png`;
const results = [];
const check = (name, ok, extra = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
};

let browser;
try {
browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => results.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") results.push(`CONSOLE-ERROR: ${m.text().slice(0, 200)}`); });

// ---------- HOME ----------
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector(".board .row:not(.head)", { timeout: 15000 });
check("home board rows render", (await page.locator(".board .row:not(.head)").count()) >= 10);
check("ticker items render", (await page.locator(".tick-item").count()) >= 8);
check("carousel present", await page.locator(".promo").isVisible());
check("pulse heat cells", (await page.locator(".heat-cell").count()) === 3);
check("fear&greed gauge", await page.locator(".fg-num").isVisible());
check("wire items", (await page.locator(".wire-item").count()) >= 1);
check("demo pill shown (no egress)", await page.locator(".src-pill.demo").isVisible());
await page.screenshot({ path: SHOT("01-home"), fullPage: false });

// period tab changes column header
await page.click('.ttabs .ttab:has-text("1h")');
const chgHead = await page.locator(".row.head .sortable").nth(1).innerText();
check("period tab changes header to 1h %", chgHead.toLowerCase().includes("1h %"), chgHead.replace(/\n/g, " "));

// chain filter
await page.click('.tabs .tab:has-text("Solana")');
const chainRows = await page.locator(".board .row:not(.head)").count();
check("solana filter reduces rows", chainRows > 0 && chainRows < 20, `rows=${chainRows}`);
await page.click('.tabs .tab:has-text("All chains")');

// sorting: click Price header → sorted desc by price
await page.click('.row.head .sortable:has-text("Price")');
const firstPrice = await page.locator(".board .row:not(.head)").first().locator(".price").innerText();
check("sort by price puts $1+ token first", firstPrice.startsWith("$1."), firstPrice);

// star does NOT open modal (stopPropagation)
await page.locator(".board .row:not(.head)").first().locator(".star").click();
await page.waitForTimeout(400);
check("star click doesn't open detail modal", (await page.locator(".modal-ov.on").count()) === 0);
check("toast shows on star", (await page.locator(".toast.on").innerText()).includes("watchlist"));

// row click opens detail modal
await page.locator(".board .row:not(.head)").first().click();
await page.waitForSelector(".modal-ov.on", { timeout: 3000 });
check("row click opens detail modal", await page.locator(".detail-head").isVisible());
check("detail has CA box", await page.locator(".ca-box code").isVisible());
const buyHref = await page.locator(".modal-ov.on a.btn-primary").getAttribute("href");
check("buy is a deeplink", !!buyHref && buyHref.startsWith("https://"), buyHref ?? "");
await page.screenshot({ path: SHOT("02-detail-modal") });
await page.click(".modal-x");

// ---------- WATCHLIST ----------
await page.click('.nav a[href="/watchlist"]');
await page.waitForSelector(".view");
await page.waitForTimeout(600);
check("watchlist has starred token", (await page.locator(".board .row:not(.head)").count()) === 1);
await page.screenshot({ path: SHOT("03-watchlist") });
// unstar → empty state
await page.locator(".board .row:not(.head) .star").click();
await page.waitForTimeout(400);
check("watchlist empty state", await page.locator(".big-empty").isVisible());

// ---------- NEW PAIRS ----------
await page.click('.nav a[href="/new-pairs"]');
await page.waitForSelector(".board.np .row:not(.head)");
const ages = await page.locator(".age-chip").allInnerTexts();
check("new pairs age chips", ages.length >= 10 && /⏱ \d+(m|h|d)/.test(ages[0]), ages.slice(0, 3).join(","));
await page.screenshot({ path: SHOT("04-newpairs") });

// ---------- TRENDING ----------
await page.click('.nav a[href="/trending"]');
await page.waitForSelector(".board .row:not(.head)");
await page.click('.ttab:has-text("Top Losers")');
const firstChg = await page.locator(".board .row:not(.head)").first().locator(".chg").innerText();
check("top losers shows negative first", firstChg.startsWith("-"), firstChg);

// ---------- ALL COINS ----------
await page.click('.nav a[href="/all-coins"]');
await page.waitForSelector(".board .row:not(.head)");
await page.fill('input[placeholder="Filter by name or ticker…"]', "frog");
await page.waitForTimeout(300);
check("all coins filter works", (await page.locator(".board .row:not(.head)").count()) === 1);

// ---------- SEARCH ----------
await page.click('.nav a[href="/search"]');
await page.click(".qtag >> nth=0");
await page.waitForTimeout(300);
check("search qtag fills results", (await page.locator(".board .row:not(.head)").count()) >= 1);

// ---------- SCANNER ----------
await page.click('.nav a[href="/scanner"]');
await page.click('button:has-text("Try a demo CA")');
await page.waitForSelector(".verdict", { timeout: 15000 });
const verdict = await page.locator(".verdict").innerText();
check("scanner returns verdict with DYOR framing", verdict.includes("DYOR"), verdict);
await page.screenshot({ path: SHOT("05-scanner") });

// ---------- CALCULATOR ----------
await page.click('.nav a[href="/calculator"]');
const mult = await page.locator(".calc-out .co .v").first().innerText();
check("calculator default 33.3x", mult === "33.3×", mult);
await page.fill('.frow input[type="number"] >> nth=0', "1000");
const val = await page.locator(".calc-out .co .v.dim").innerText();
check("calculator reacts to input", val === "$33,333", val);

// ---------- LISTING FLOW ----------
await page.click(".fasttrack");
await page.waitForSelector(".modal-ov.on");
// step 1 validation: empty submit
await page.click('button:has-text("Choose tier →")');
check("listing validates empty form", (await page.locator(".toast.on").innerText()).includes("Fill in"));
await page.fill('input[placeholder="e.g. Trench Cat"]', "Test Token");
await page.fill('input[placeholder="e.g. TRENCHCAT"]', "TEST");
await page.fill('input[placeholder="Paste CA…"]', "badaddress123456789012345");
await page.click('button:has-text("Choose tier →")');
check("listing validates CA per chain", (await page.locator(".toast.on").innerText()).includes("Solana address"));
await page.fill('input[placeholder="Paste CA…"]', "7xKqDF3PaGbTVrN8mJcE2WqHs5uYtRvKnZpXeAd9fQ");
await page.click('button:has-text("Choose tier →")');
await page.waitForSelector(".tier-grid", { timeout: 3000 });
check("listing step 2 tiers visible", (await page.locator(".tier-grid .tier").count()) === 3);
await page.click('.tier:has-text("Fast-Track")');
await page.click('button:has-text("Review →")');
check("review shows tier", (await page.locator(".check-list").innerText()).includes("Fast-Track"));
await page.click('button:has-text("Pay & submit ⚡")');
await page.waitForSelector(".success-wrap");
check("listing success step", await page.locator(".success-ic").isVisible());
await page.screenshot({ path: SHOT("06-listing-success") });
await page.click('button:has-text("View my listings →")');
await page.waitForURL("**/account");
check("account shows listing IN REVIEW", (await page.locator(".mini-listing").innerText()).includes("IN REVIEW"));
await page.screenshot({ path: SHOT("07-account") });

// ---------- ALERTS ----------
await page.click('.nav a[href="/alerts"]');
await page.click('button:has-text("Create alert")');
await page.waitForTimeout(300);
check("alert created", (await page.locator(".alert-item").count()) === 1);

// ---------- TOPBAR SEARCH + "/" KEY ----------
await page.keyboard.press("/");
const focused = await page.evaluate(() => document.activeElement?.getAttribute("placeholder"));
check("'/' focuses topbar search", focused === "Search token, pair, or paste CA…", focused ?? "none");
await page.keyboard.type("warchest");
await page.waitForURL(BASE + "/");
await page.waitForTimeout(400);
check("topbar search navigates home and filters", (await page.locator(".board .row:not(.head)").count()) === 1);

// ---------- MOBILE ----------
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(BASE, { waitUntil: "networkidle" });
await mob.waitForSelector(".board .row:not(.head)");
check("mobile: sidebar hidden", !(await mob.locator(".sidebar").isVisible()));
check("mobile: topbar brand shown", await mob.locator(".brand-top").isVisible());
const hasHScroll = await mob.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
check("mobile: no horizontal scroll", !hasHScroll);
await mob.screenshot({ path: SHOT("08-mobile-home"), fullPage: false });

// ---------- REDUCED MOTION ----------
const rm = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
await rm.goto(BASE, { waitUntil: "networkidle" });
await rm.waitForSelector(".board .row:not(.head)");
const anim = await rm.evaluate(() => getComputedStyle(document.querySelector(".ticker-track")).animationName);
check("reduced motion kills ticker animation", anim === "none", anim);

// ---------- PWA ----------
const mf = await page.evaluate(async () => (await fetch("/manifest.webmanifest")).status);
check("manifest served", mf === 200);
const sw = await page.evaluate(async () => (await fetch("/sw.js")).status);
check("service worker served", sw === 200);

} catch (e) { results.push("SCRIPT-ERROR: " + e.message.split("\n")[0]); }
if (browser) await browser.close();
console.log(results.join("\n"));
process.exitCode = results.some(r => r.startsWith("FAIL") || r.startsWith("SCRIPT-ERROR")) ? 1 : 0;
