// Preview every Top-Gainers banner template → /tmp (or $OUT_DIR).
//
//   node scripts/gainers-preview.js            # sample data, all templates
//   node scripts/gainers-preview.js --live     # LIVE data from the real sources
//   node scripts/gainers-preview.js --live list5
//
// Sample mode needs no network, no DB and no bot token — it is the fastest way
// to see what a layout change did. --live goes through gainers.topGainers(), so
// it also tells you whether the data side is healthy on this box.
// .env before anything reaches config/constants — `loadEnv()` is the one owner
// of that (repo root, bot/, cwd). A diagnostic that reads a different
// configuration from the bot's is a diagnostic about nothing.
require("../src/config/loadEnv").loadEnv();

const fs = require("node:fs");
const path = require("node:path");
const gb = require("../src/gainersBanner");
const gainers = require("../src/gainers");

const OUT = process.env.OUT_DIR || "/tmp";
const args = process.argv.slice(2);
const live = args.includes("--live");
const only = args.filter((a) => !a.startsWith("--"));

// Real tokens, believable figures — a preview should look like a real board.
const SAMPLE = [
  { chain: "solana", address: "So1", symbol: "HOODRAT", name: "Hood Rat", pct: 204.4, price: 0.001266, mcap: 12_400_000, liq: 840_000, x: "hoodrat_coin" },
  { chain: "bsc", address: "0x2", symbol: "KOMA", name: "Koma Inu", pct: 96.8, price: 0.0421, mcap: 8_900_000, liq: 610_000, x: "komabnb" },
  { chain: "solana", address: "So3", symbol: "GTAVI", name: "Grand Theft Auto VI", pct: 46.8, price: 0.00089, mcap: 4_200_000, liq: 320_000, x: "solana_gtavi" },
  { chain: "base", address: "0x4", symbol: "ESPRESSO", name: "Espresso Systems", pct: 35.5, price: 0.62, mcap: 3_100_000, liq: 280_000, x: "espressosys" },
  { chain: "ethereum", address: "0x5", symbol: "IF", name: "What If On Hood", pct: 27.7, price: 0.0000119, mcap: 2_400_000, liq: 190_000 },
  { chain: "solana", address: "So6", symbol: "CUBEMAN", name: "Cubeman", pct: 22.1, price: 0.0056, mcap: 1_900_000, liq: 150_000 },
  { chain: "tron", address: "T7", symbol: "SUNDOG", name: "Sundog", pct: 18.4, price: 0.11, mcap: 1_500_000, liq: 120_000 },
  { chain: "ton", address: "EQ8", symbol: "RESISTANCE", name: "Resistance Dog", pct: 12.9, price: 0.0031, mcap: 980_000, liq: 90_000 },
  { chain: "sui", address: "0x9", symbol: "BLUB", name: "Blub", pct: 8.2, price: 0.00024, mcap: 720_000, liq: 70_000 },
  { chain: "plasma", address: "0xA", symbol: "XPLAY", name: "Plasma Play", pct: 4.6, price: 0.019, mcap: 540_000, liq: 55_000 },
];

(async () => {
  if (!gb.available()) return console.error("canvas unavailable — install @napi-rs/canvas");
  const ids = only.length ? only.filter(gb.isTemplate) : gb.TEMPLATE_IDS;
  if (!ids.length) return console.error(`unknown template — try: ${gb.TEMPLATE_IDS.join(", ")}`);
  const dateText = gainers.dateText(process.env.GAINERS_TZ || "Asia/Jakarta");

  for (const id of ids) {
    const n = gb.countOf(id);
    let coins;
    if (live) {
      const res = await gainers.topGainers({ limit: n });
      if (!res.coins.length) {
        console.error(`${id}: no live gainers — ${res.notes.join(" ")}`);
        continue;
      }
      console.log(`${id}: ${gainers.summary(res)}`);
      coins = res.coins;
    } else {
      coins = SAMPLE.slice(0, n).map((c) => ({ ...c, url: `https://dexvra.io/token/${c.chain}/${c.address}` }));
    }
    const buf = await gb.render({ template: id, coins, dateText, bgPath: process.env.GAINERS_BG || "" });
    if (!buf) {
      console.error(`${id}: render returned null`);
      continue;
    }
    const out = path.join(OUT, `gainers-${id}.png`);
    fs.writeFileSync(out, buf);
    console.log(`rendered ${out} (${(buf.length / 1024).toFixed(0)} KB, ${gb.labelOf(id)})`);
  }
})();
