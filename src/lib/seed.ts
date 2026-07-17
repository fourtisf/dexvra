import type { BoardToken, PeriodKey } from "./types";
import { syntheticTrend } from "./visual";

// The prototype's 20 mock tokens, kept as a fallback dataset so every page
// stays demoable when market-data providers are unreachable. The prototype
// only carries 24h figures and scales them per period; we reproduce that.
const PERIOD_FACTOR: Record<PeriodKey, number> = {
  "5m": 0.05,
  "1h": 0.17,
  "6h": 0.48,
  "24h": 1,
};

interface SeedRow {
  sym: string;
  name: string;
  emoji: string;
  g: [string, string, string];
  price: number;
  chg: number;
  mcap: number;
  vol: number;
  liq: number;
  tx: number;
  buys: number;
  tax: number;
  holders: number;
  age: number;
  chain: string;
}

const ROWS: SeedRow[] = [
  { sym: "$TRENCHCAT", name: "Trench Cat", emoji: "🐈‍⬛", g: ["#C9D4FF", "#6D8BFF", "#2A3FB8"], price: 0.000281, chg: 203.4, mcap: 280900, vol: 428540, liq: 96200, tx: 61260, buys: 36330, tax: 0, holders: 1204, age: 320, chain: "solana" },
  { sym: "$WARCHEST", name: "War Chest", emoji: "⚔️", g: ["#FFE9A8", "#FFC53D", "#B57900"], price: 0.04127, chg: 64.2, mcap: 41200000, vol: 2140000, liq: 830000, tx: 18400, buys: 11200, tax: 0, holders: 18904, age: 44640, chain: "solana" },
  { sym: "$ROBIN", name: "Robin", emoji: "🏹", g: ["#E6FFB0", "#CCFF00", "#7FA300"], price: 0.00381, chg: 38.9, mcap: 412600, vol: 188300, liq: 96400, tx: 2540, buys: 1570, tax: 0, holders: 812, age: 14, chain: "robinhood" },
  { sym: "$GIGAFROG", name: "Giga Frog", emoji: "🐸", g: ["#B8FFD0", "#3DF59F", "#0B9E5E"], price: 0.00842, chg: 91.7, mcap: 8420000, vol: 1260000, liq: 412000, tx: 9840, buys: 6100, tax: 0, holders: 6420, age: 2880, chain: "base" },
  { sym: "$MOONVAULT", name: "Moon Vault", emoji: "🌕", g: ["#E2CCFF", "#A97CFF", "#6524C9"], price: 1.284, chg: -12.4, mcap: 64100000, vol: 3810000, liq: 2100000, tx: 22100, buys: 9400, tax: 2, holders: 31200, age: 129600, chain: "ethereum" },
  { sym: "$SOLPUP", name: "Sol Pup", emoji: "🐶", g: ["#FFD9B8", "#FF9D5C", "#C25C00"], price: 0.01293, chg: 12.1, mcap: 12930000, vol: 941000, liq: 388000, tx: 7420, buys: 4100, tax: 0, holders: 8930, age: 10080, chain: "solana" },
  { sym: "$NIGHTOWL", name: "Night Owl", emoji: "🦉", g: ["#D4CCFF", "#8F7CFF", "#4A35C9"], price: 0.2241, chg: 2.9, mcap: 22410000, vol: 764000, liq: 912000, tx: 5210, buys: 2700, tax: 1, holders: 14100, age: 86400, chain: "ethereum" },
  { sym: "$DIAMONDTON", name: "Diamond TON", emoji: "💎", g: ["#B0F2FF", "#22D3EE", "#0A7F96"], price: 0.06618, chg: 18.6, mcap: 6610000, vol: 502000, liq: 274000, tx: 4180, buys: 2600, tax: 0, holders: 5240, age: 7200, chain: "ton" },
  { sym: "$CAKEDOG", name: "Cake Dog", emoji: "🍰", g: ["#FFD0E4", "#FF7CB8", "#C22A72"], price: 0.000914, chg: 7.3, mcap: 914000, vol: 216000, liq: 88000, tx: 1920, buys: 1050, tax: 2, holders: 2210, age: 4320, chain: "bsc" },
  { sym: "$BASEGOD", name: "Base God", emoji: "🗿", g: ["#C9DCFF", "#5C9DFF", "#1F57C2"], price: 0.00477, chg: -4.8, mcap: 4770000, vol: 352000, liq: 198000, tx: 3140, buys: 1400, tax: 0, holders: 4020, age: 20160, chain: "base" },
  { sym: "$FOMOFUEL", name: "Fomo Fuel", emoji: "⛽", g: ["#FFC7A8", "#FF8A3D", "#C24D00"], price: 0.00188, chg: -8.7, mcap: 1880000, vol: 143000, liq: 74000, tx: 1480, buys: 610, tax: 0, holders: 1890, age: 1440, chain: "solana" },
  { sym: "$ORBITON", name: "Orbiton", emoji: "🛰️", g: ["#B8FFF2", "#35E8C2", "#0A8F74"], price: 0.03349, chg: 24.5, mcap: 3340000, vol: 298000, liq: 161000, tx: 2760, buys: 1700, tax: 0, holders: 3110, age: 5760, chain: "ton" },
  { sym: "$SEAWEED", name: "Seaweed", emoji: "🌿", g: ["#C4FFD9", "#4DE8A0", "#0E7A4C"], price: 0.00092, chg: 44.1, mcap: 920000, vol: 210000, liq: 64000, tx: 2210, buys: 1500, tax: 0, holders: 940, age: 38, chain: "base" },
  { sym: "$KETUPAT", name: "Ketupat", emoji: "🍙", g: ["#FFF3C4", "#FFD966", "#B8860B"], price: 0.00034, chg: 128.6, mcap: 340000, vol: 184000, liq: 41000, tx: 3050, buys: 2200, tax: 0, holders: 610, age: 22, chain: "bsc" },
  { sym: "$BLASTOFF", name: "Blastoff", emoji: "🚀", g: ["#FFD1C4", "#FF7A5C", "#B03A1F"], price: 0.0121, chg: -3.1, mcap: 1210000, vol: 98000, liq: 87000, tx: 880, buys: 400, tax: 1, holders: 1310, age: 55, chain: "ethereum" },
  { sym: "$PIXELPUP", name: "Pixel Pup", emoji: "👾", g: ["#E0C4FF", "#B06CFF", "#5C1FB0"], price: 0.00219, chg: 17.4, mcap: 2190000, vol: 156000, liq: 99000, tx: 1440, buys: 900, tax: 0, holders: 1720, age: 130, chain: "solana" },
  { sym: "$MOONMILK", name: "Moon Milk", emoji: "🥛", g: ["#EAF4FF", "#BFD9F2", "#5C7A99"], price: 0.00461, chg: 9.8, mcap: 4610000, vol: 230000, liq: 150000, tx: 1980, buys: 1150, tax: 0, holders: 2540, age: 410, chain: "ton" },
  { sym: "$VOLTAGE", name: "Voltage", emoji: "⚡", g: ["#FFF9C4", "#FFE24D", "#A38B00"], price: 0.0087, chg: 61.3, mcap: 870000, vol: 340000, liq: 72000, tx: 4100, buys: 2900, tax: 0, holders: 1180, age: 8, chain: "base" },
  { sym: "$HODLBEAR", name: "Hodl Bear", emoji: "🐻", g: ["#E8D4C4", "#C29A6B", "#7A5326"], price: 0.0332, chg: -6.9, mcap: 3320000, vol: 120000, liq: 210000, tx: 760, buys: 300, tax: 1, holders: 2980, age: 2160, chain: "ethereum" },
  { sym: "$RENDANG", name: "Rendang", emoji: "🍛", g: ["#FFD9B0", "#E8873D", "#8A4A12"], price: 0.00057, chg: 33.7, mcap: 570000, vol: 145000, liq: 52000, tx: 1620, buys: 1050, tax: 0, holders: 820, age: 95, chain: "solana" },
];

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function fakeCa(sym: string): string {
  let seed = 0;
  for (const c of sym) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  let ca = "";
  for (let k = 0; k < 42; k++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    ca += B58[seed % B58.length];
  }
  return ca;
}

function perPeriod(base: number): Record<PeriodKey, number> {
  return {
    "5m": base * PERIOD_FACTOR["5m"],
    "1h": base * PERIOD_FACTOR["1h"],
    "6h": base * PERIOD_FACTOR["6h"],
    "24h": base,
  };
}

export function seedTokens(): BoardToken[] {
  return ROWS.map((r) => {
    const address = fakeCa(r.sym);
    const txns = {} as BoardToken["txns"];
    (Object.keys(PERIOD_FACTOR) as PeriodKey[]).forEach((p) => {
      const total = Math.round(r.tx * PERIOD_FACTOR[p]);
      const buys = Math.round(r.buys * PERIOD_FACTOR[p]);
      txns[p] = { buys, sells: Math.max(total - buys, 0) };
    });
    return {
      key: `${r.chain}:${address}`,
      chain: r.chain,
      address,
      symbol: r.sym,
      name: r.name,
      logoUrl: null,
      emoji: r.emoji,
      gradient: r.g,
      priceUsd: r.price,
      mcap: r.mcap,
      liq: r.liq,
      chg: perPeriod(r.chg),
      vol: perPeriod(r.vol),
      txns,
      holders: r.holders,
      taxPct: r.tax,
      ageMinutes: r.age,
      trend: syntheticTrend(r.sym, r.chg),
      verified: r.sym === "$WARCHEST",
      source: "seed",
    };
  });
}
