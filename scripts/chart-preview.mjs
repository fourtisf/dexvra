// chart:preview — DRIVE the candlestick chart and look at what it draws.
//
// The chart panel is judged by LOOKING at it: the defects this script was
// written alongside were a time label clipped to a WRONG time ("3:46" for
// 23:46, because a CSS `text-anchor` silently beat the renderer's own), a price
// label sitting underneath the last-price tag, and 160 candles smeared into
// 1.6px bodies on a phone. Every one of them passed the unit tests and passed a
// source scan.
//
// It stubs the upstreams IN THE BROWSER, so it runs on a box with no egress and
// its output does not depend on what a memecoin did this afternoon. What it
// cannot check is whether GeckoTerminal answers — `npm run trending:check` in
// the bot is the model for that, and it has to be measured on the server.
//
//   npm run build && npm start &
//   npm run chart:preview                    # → chart-shots/*.png
//   BASE_URL=http://localhost:3000 SHOT_DIR=/tmp/shots npm run chart:preview
//
// Exits non-zero if any state fails to render, so "it looked fine" is not the
// only thing standing between a broken chart and a deploy.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.SHOT_DIR ?? "chart-shots";
mkdirSync(SHOT_DIR, { recursive: true });

const CHAIN = "solana";
const ADDR = "3jiVL4dKjVBSVsnGTCd28PaYiXXynaJa2JZTLxDLq9x4";
const POOL = "PooLaddr1111111111111111111111111111111111";

const results = [];
const check = (name, ok, extra = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  return ok;
};

/** A deterministic random walk. Oldest-first, which is what /api/ohlcv returns
 *  after normalizeCandles — the client is entitled to that and does not re-sort. */
function candles(n, step) {
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  let p = 0.0009;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let i = n - 1; i >= 0; i--) {
    const o = p;
    const c = Math.max(0.00001, o * (1 + (rnd() - 0.46) * 0.09));
    out.push({
      t: now - i * step,
      o,
      h: Math.max(o, c) * (1 + rnd() * 0.03),
      l: Math.min(o, c) * (1 - rnd() * 0.03),
      c,
      v: Math.round(500 + rnd() * 9000),
    });
    p = c;
  }
  return out;
}

const TOKEN = {
  key: `${CHAIN}:${ADDR}`, chain: CHAIN, address: ADDR, symbol: "$FLOKI", name: "Floki",
  logoUrl: null, emoji: "🐶", gradient: ["#7BE8C2", "#22C39A", "#0B6E52"],
  priceUsd: 0.001186, mcap: 1190000, liq: 445,
  chg: { "5m": 1.2, "1h": -3.4, "6h": 12.5, "24h": 923 },
  vol: { "5m": 120, "1h": 900, "6h": 4200, "24h": 8300 },
  txns: { "5m": { buys: 3, sells: 1 }, "1h": { buys: 20, sells: 9 }, "6h": { buys: 90, sells: 40 }, "24h": { buys: 201, sells: 100 } },
  holders: 0, taxPct: 0, ageMinutes: 300, trend: [1, 2, 3, 4, 5], verified: true, source: "live",
  tier: "GOLD", trendingRank: null, listedMinutesAgo: 120, score: 70, poolAddress: POOL,
  links: { website: null, twitter: null, telegram: null }, overview: null,
};

const STEP = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

/** `mode` is read at request time so a test can change what the upstream says
 *  between two page loads. */
const stub = async (page, mode) => {
  await page.route("**/api/tokens", (r) =>
    r.fulfill({ json: { tokens: [TOKEN], heat: [], signals: [], wire: [], trackedVol24h: 8300, live: true, updatedAt: Date.now() } }));
  await page.route("**/api/feargreed", (r) =>
    r.fulfill({ json: { value: 55, label: "Neutral", updatedMinutesAgo: 3, source: "live" } }));
  await page.route("**/api/trades**", (r) => r.fulfill({ json: { trades: [], live: false } }));
  await page.route("**/api/token-preview**", (r) =>
    r.fulfill({ json: { chain: CHAIN, token: { name: "Floki", symbol: "FLOKI", priceUsd: 0.001186, mcap: 1190000, logoUrl: null, poolAddress: POOL, source: "dexscreener" } } }));
  await page.route("**/api/ohlcv**", (r) => {
    const tf = new URL(r.request().url()).searchParams.get("tf") ?? "15m";
    const m = mode();
    if (m === "none")
      return r.fulfill({ json: { ok: false, network: CHAIN, pool: null, tf, candles: [], why: "No pool indexed for this token yet — nothing to chart." } });
    if (m === "error")
      return r.fulfill({ json: { ok: false, network: CHAIN, pool: null, tf, candles: [], why: "Couldn't read the chart just now (GeckoTerminal 429 (rate limited); DexScreener 403)." } });
    // The FALLBACK, drawn. With GeckoTerminal healthy this state never occurs
    // in a preview run, and it is the one state where the panel says something
    // extra — so it has to be looked at deliberately or the chip ships unseen.
    if (m === "dexscreener")
      return r.fulfill({
        json: {
          ok: true, network: CHAIN, pool: null, tf, candles: candles(160, STEP[tf] ?? 900), why: null,
          source: "dexscreener", sourceUrl: `https://dexscreener.com/${CHAIN}/${POOL}`,
        },
      });
    return r.fulfill({ json: { ok: true, network: CHAIN, pool: POOL, tf, candles: candles(160, STEP[tf] ?? 900), why: null, source: "geckoterminal", sourceUrl: `https://www.geckoterminal.com/${CHAIN}/pools/${POOL}` } });
  });
};

let browser;
let failed = false;
try {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  // ⚠️ The site registers a service worker, and a SW-served request never
  // reaches page.route — the stubs above would be bypassed on the second load
  // and the chart would quietly show whatever the real server said.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));

  let mode = "ok";
  await stub(page, () => mode);

  // ── the drawn chart ──────────────────────────────────────────────────────
  await page.goto(`${BASE}/token/${CHAIN}/${ADDR}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".ck-svg", { timeout: 20000 });
  const drawn = await page.locator(".ck-c").count();
  check("candles are drawn", drawn > 20, `${drawn} candles`);
  check("volume bars match the candles", (await page.locator(".ck-vol").count()) === drawn);
  check("the window change is labelled with the span it covers", /over \d+[hdmo]/.test(await page.locator(".ck-chg").innerText()));
  await page.screenshot({ path: `${SHOT_DIR}/token-page.png` });
  await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/chart.png` });

  // ⚠️ Every axis stamp must be a WHOLE time. A centred label on the first
  // candle hangs half of itself off the plot, and "23:46" shipped as "3:46".
  // textContent, not innerText: an SVG <text> has no innerText and every stamp
  // would come back blank — a check that passes on an empty string is no check.
  const stamps = await page.evaluate(() => [...document.querySelectorAll(".ck-axis-x")].map((t) => t.textContent ?? ""));
  check("no time stamp is clipped to a wrong time", stamps.every((s) => /^\d{2}:\d{2}$|^\d{1,2} \w{3}$/.test(s)), stamps.join(" · "));
  const inside = await page.evaluate(() => {
    const svg = document.querySelector(".ck-svg").getBoundingClientRect();
    return [...document.querySelectorAll(".ck-axis-x")].every((t) => {
      const r = t.getBoundingClientRect();
      return r.left >= svg.left - 0.5 && r.right <= svg.right + 0.5;
    });
  });
  check("every axis stamp is inside the plot", inside);

  // ── the readout ──────────────────────────────────────────────────────────
  const box = await page.locator(".ck-plot").boundingBox();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.4);
  await page.waitForTimeout(200);
  check("the crosshair follows the pointer", (await page.locator(".ck-cross").count()) === 1);
  const tip = await page.locator(".ck-tip").innerText();
  check("the readout carries O/H/L/C and volume", /O /.test(tip) && /H /.test(tip) && /L /.test(tip) && /C /.test(tip) && /Vol /.test(tip), tip.replace(/\n/g, " "));
  await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/chart-hover.png` });

  // ── the timeframes ───────────────────────────────────────────────────────
  for (const tf of ["5m", "1h", "1d"]) {
    // EXACT: `hasText: "5m"` also matches the 15m tab.
    await page.getByRole("tab", { name: tf, exact: true }).click();
    await page.waitForTimeout(700);
    check(`the ${tf} tab draws its own candles`, (await page.locator(".ck-c").count()) > 20 && (await page.locator(".ck-tf.on").innerText()) === tf);
  }
  await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/chart-1d.png` });

  // ── the two states with nothing to draw ──────────────────────────────────
  // They must not read the same: one is about the token, the other about us.
  for (const [m, want, file] of [["none", /No candles yet/, "chart-empty"], ["error", /Chart unavailable/, "chart-error"]]) {
    mode = m;
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".ck-empty", { timeout: 20000 });
    const text = await page.locator(".ck-empty").innerText();
    check(`the "${m}" state says which it is`, want.test(text), text.split("\n")[0]);
    await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/${file}.png` });
  }
  // ── the DexScreener fallback, drawn ──────────────────────────────────────
  //
  // A chart drawn from the second source and one drawn from GeckoTerminal are
  // identical from outside, so "the fallback works" and "the fallback never
  // fires" are the same picture — which is the reassuring reading this repo
  // keeps paying for. The chip is the only tell, and an unseen chip is how it
  // ships mispositioned, mis-cased or over the live dot.
  mode = "dexscreener";
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".ck-svg", { timeout: 20000 });
  check("the fallback still draws a full chart", (await page.locator(".ck-c").count()) > 20);
  check("…and SAYS it came from DexScreener", (await page.locator(".ck-src").count()) === 1,
    (await page.locator(".ck-src").count()) ? await page.locator(".ck-src").innerText() : "no chip");
  // The chip sits in the header row beside the ticker; if it wrapped or
  // overflowed, the header is taller than the tab strip it shares a line with.
  const fits = await page.evaluate(() => {
    const chip = document.querySelector(".ck-src");
    const head = document.querySelector(".ck-head");
    if (!chip || !head) return false;
    const c = chip.getBoundingClientRect();
    const h = head.getBoundingClientRect();
    return c.top >= h.top - 0.5 && c.bottom <= h.bottom + 0.5 && c.width > 20;
  });
  check("the source chip sits inside the header row", fits);
  await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/chart-dexscreener.png` });
  mode = "ok";

  // ── the unlisted page: NO chart, and never an embed ──────────────────────
  //
  // ⚠️ THIS CHECK WAS STALE, AND IT HAD MADE THE WHOLE SCRIPT USELESS AS A GATE.
  // It waited for `.unlisted-chart .ck-svg` and asserted "an unlisted token gets
  // the chart too" — written when it did. The chart was then deliberately
  // REMOVED on the owner's call ("Kalo token belum listing hapus chartnya"):
  // this page is reachable by pasting any contract at all, every buy-bot alert
  // links here, and each visit polled /api/ohlcv for a token nobody listed —
  // a listed customer's chart competing for GeckoTerminal's ceiling with an
  // unlisted stranger's. Charting is what a listing buys.
  //
  // So the assertion has been failing on every run since, which means this
  // script exited non-zero every time and nobody could use it to gate anything.
  // A check that asserts a deleted feature is worse than no check: it trains
  // the reader to ignore the red. It asserts the DECISION now, and
  // `unlisted.test.ts` pins the same thing from the other side.
  await page.goto(`${BASE}/token/${CHAIN}/9unknown11111111111111111111111111111111111`, { waitUntil: "networkidle" });
  await page.waitForSelector(".unlisted-wrap, .unlisted", { timeout: 20000 }).catch(() => {});
  check("an unlisted token gets NO chart — charting is what a listing buys", (await page.locator(".ck-svg").count()) === 0);
  check("…but it still shows the price it got free with the preview", /\$/.test(await page.locator("body").innerText()));
  check("and no iframe anywhere on it", (await page.locator("iframe").count()) === 0);
  await page.screenshot({ path: `${SHOT_DIR}/unlisted.png`, fullPage: true });

  // ── a phone ──────────────────────────────────────────────────────────────
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const m = await mctx.newPage();
  m.on("pageerror", (e) => errs.push(`(phone) ${e.message}`));
  await stub(m, () => "ok");
  await m.goto(`${BASE}/token/${CHAIN}/${ADDR}`, { waitUntil: "networkidle" });
  await m.waitForSelector(".ck-svg", { timeout: 20000 });
  const phone = await m.locator(".ck-c").count();
  // ⚠️ 160 candles across a 330px plot is a 1.6px body — a smear you cannot
  // read one bar out of. The window narrows to what fits.
  check("the phone window narrows to candles you can actually see", phone > 20 && phone < drawn, `${phone} of ${drawn}`);
  check("the page does not scroll sideways", !(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  await m.screenshot({ path: `${SHOT_DIR}/phone.png` });

  check("no page errors", errs.length === 0, errs.join(" | "));
} catch (err) {
  results.push(`FAIL harness — ${err.message}`);
} finally {
  await browser?.close();
}

for (const line of results) {
  if (line.startsWith("FAIL")) failed = true;
  console.log(line);
}
console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} checks · shots in ${SHOT_DIR}/`);
process.exit(failed ? 1 : 0);
