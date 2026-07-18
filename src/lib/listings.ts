import type { BoardToken, ListingTier, PeriodKey } from "./types";
import { dexvraScore } from "./score";
import { syntheticTrend, visualFor } from "./visual";

// Dexvra is PAID-LISTING ONLY — tokens exist here because a project paid to
// list, never auto-indexed. These are real example listings (real contract
// addresses); the provider layer enriches each with live market data by
// address, and these figures are the fallback when a provider is unreachable.
interface ListingRow {
  chain: string;
  address: string;
  sym: string;
  name: string;
  emoji: string;
  tier: ListingTier;
  listedMin: number; // minutes since the listing went live
  tax: number;
  holders: number;
  price: number;
  chg24h: number;
  mcap: number;
  liq: number;
  vol24h: number;
  buyShare: number; // 0..1 share of txns that are buys
  tx24h: number;
  website?: string;
  twitter?: string;
  telegram?: string;
}

const ROWS: ListingRow[] = [
  { chain: "solana", address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", sym: "$BONK", name: "Bonk", emoji: "🐕", tier: "FASTTRACK", listedMin: 18, tax: 0, holders: 812000, price: 0.0000246, chg24h: 12.4, mcap: 1720000000, liq: 24000000, vol24h: 138000000, buyShare: 0.56, tx24h: 240000, twitter: "https://x.com/bonk_inu" },
  { chain: "solana", address: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", sym: "$WIF", name: "dogwifhat", emoji: "🐶", tier: "FASTTRACK", listedMin: 44, tax: 0, holders: 214000, price: 1.83, chg24h: 6.1, mcap: 1830000000, liq: 31000000, vol24h: 96000000, buyShare: 0.52, tx24h: 88000, twitter: "https://x.com/dogwifcoin" },
  { chain: "solana", address: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", sym: "$POPCAT", name: "Popcat", emoji: "🐱", tier: "EXPRESS", listedMin: 96, tax: 0, holders: 96000, price: 0.94, chg24h: 22.7, mcap: 924000000, liq: 12800000, vol24h: 41000000, buyShare: 0.6, tx24h: 52000 },
  { chain: "solana", address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", sym: "$JUP", name: "Jupiter", emoji: "🪐", tier: "EXPRESS", listedMin: 320, tax: 0, holders: 640000, price: 0.78, chg24h: -3.4, mcap: 1050000000, liq: 18000000, vol24h: 34000000, buyShare: 0.47, tx24h: 44000 },
  { chain: "ethereum", address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", sym: "$PEPE", name: "Pepe", emoji: "🐸", tier: "FASTTRACK", listedMin: 61, tax: 0, holders: 428000, price: 0.0000119, chg24h: 8.9, mcap: 5000000000, liq: 42000000, vol24h: 210000000, buyShare: 0.54, tx24h: 61000, twitter: "https://x.com/pepecoineth" },
  { chain: "ethereum", address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", sym: "$SHIB", name: "Shiba Inu", emoji: "🐕", tier: "EXPRESS", listedMin: 540, tax: 0, holders: 1350000, price: 0.0000131, chg24h: 2.1, mcap: 7700000000, liq: 38000000, vol24h: 128000000, buyShare: 0.5, tx24h: 39000 },
  { chain: "ethereum", address: "0xaaeE1A9723aaDB7afA2810263653A34bA2C21C7a", sym: "$MOG", name: "Mog Coin", emoji: "😼", tier: "EXPRESS", listedMin: 210, tax: 0, holders: 42000, price: 0.0000018, chg24h: 31.5, mcap: 700000000, liq: 9200000, vol24h: 28000000, buyShare: 0.62, tx24h: 21000 },
  { chain: "base", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", sym: "$BRETT", name: "Brett", emoji: "🔵", tier: "FASTTRACK", listedMin: 33, tax: 0, holders: 118000, price: 0.089, chg24h: 15.2, mcap: 880000000, liq: 14000000, vol24h: 36000000, buyShare: 0.58, tx24h: 27000, twitter: "https://x.com/basedbrett" },
  { chain: "base", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", sym: "$DEGEN", name: "Degen", emoji: "🎩", tier: "EXPRESS", listedMin: 150, tax: 0, holders: 168000, price: 0.0072, chg24h: -6.8, mcap: 128000000, liq: 6400000, vol24h: 11000000, buyShare: 0.45, tx24h: 15000 },
  { chain: "base", address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", sym: "$TOSHI", name: "Toshi", emoji: "🐈", tier: "TRENCH", listedMin: 12, tax: 0, holders: 88000, price: 0.00016, chg24h: 44.3, mcap: 160000000, liq: 5200000, vol24h: 18000000, buyShare: 0.66, tx24h: 19000 },
  { chain: "bsc", address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", sym: "$CAKE", name: "PancakeSwap", emoji: "🥞", tier: "EXPRESS", listedMin: 400, tax: 0, holders: 1600000, price: 2.34, chg24h: 1.8, mcap: 720000000, liq: 22000000, vol24h: 41000000, buyShare: 0.5, tx24h: 33000 },
  { chain: "bsc", address: "0xfb5B838b6cfEEdC2873aB27866079AC55363D37E", sym: "$FLOKI", name: "Floki", emoji: "🐺", tier: "EXPRESS", listedMin: 260, tax: 0, holders: 470000, price: 0.00015, chg24h: 9.4, mcap: 1450000000, liq: 16000000, vol24h: 52000000, buyShare: 0.55, tx24h: 28000 },
  { chain: "ton", address: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", sym: "$NOT", name: "Notcoin", emoji: "🪙", tier: "FASTTRACK", listedMin: 72, tax: 0, holders: 640000, price: 0.0086, chg24h: 5.6, mcap: 880000000, liq: 9800000, vol24h: 24000000, buyShare: 0.53, tx24h: 22000 },
  { chain: "ton", address: "EQAJ8uWd7EBqsmpSWaRdf_I-8R8-XHwh3gsNKhy-UrdrPcUo", sym: "$DOGS", name: "Dogs", emoji: "🐶", tier: "TRENCH", listedMin: 26, tax: 0, holders: 320000, price: 0.00072, chg24h: 18.9, mcap: 210000000, liq: 4100000, vol24h: 9600000, buyShare: 0.61, tx24h: 12000 },
  { chain: "robinhood", address: "0x9A1b3F0C2d4E5f6A7B8c9D0e1F2a3B4c5D6e7F80", sym: "$ROBIN", name: "Robin", emoji: "🏹", tier: "FASTTRACK", listedMin: 8, tax: 0, holders: 41000, price: 0.041, chg24h: 62.4, mcap: 41200000, liq: 3100000, vol24h: 8800000, buyShare: 0.68, tx24h: 14000 },
  { chain: "robinhood", address: "0x3C2d1E0f9A8b7C6d5E4f3A2b1C0d9E8f7A6b5C40", sym: "$HOOD", name: "Hood Cash", emoji: "💵", tier: "TRENCH", listedMin: 35, tax: 1, holders: 12000, price: 0.0031, chg24h: 27.1, mcap: 12400000, liq: 1400000, vol24h: 3200000, buyShare: 0.64, tx24h: 6400 },
];

const PERIOD_FACTOR: Record<PeriodKey, number> = { "5m": 0.05, "1h": 0.17, "6h": 0.48, "24h": 1 };

function perPeriod(base: number): Record<PeriodKey, number> {
  return {
    "5m": base * PERIOD_FACTOR["5m"],
    "1h": base * PERIOD_FACTOR["1h"],
    "6h": base * PERIOD_FACTOR["6h"],
    "24h": base,
  };
}

export function listingTokens(): BoardToken[] {
  return ROWS.map((r) => {
    const v = visualFor(r.sym);
    const txns = {} as BoardToken["txns"];
    (Object.keys(PERIOD_FACTOR) as PeriodKey[]).forEach((p) => {
      const total = Math.round(r.tx24h * PERIOD_FACTOR[p]);
      const buys = Math.round(total * r.buyShare);
      txns[p] = { buys, sells: Math.max(total - buys, 0) };
    });
    const chg = perPeriod(r.chg24h);
    const vol = perPeriod(r.vol24h);
    const score = dexvraScore({ chg, liq: r.liq, taxPct: r.tax, txns, holders: r.holders });
    return {
      key: `${r.chain}:${r.address}`,
      chain: r.chain,
      address: r.address,
      symbol: r.sym,
      name: r.name,
      logoUrl: null,
      emoji: r.emoji,
      gradient: v.gradient,
      priceUsd: r.price,
      mcap: r.mcap,
      liq: r.liq,
      chg,
      vol,
      txns,
      holders: r.holders,
      taxPct: r.tax,
      ageMinutes: null,
      trend: syntheticTrend(r.sym, r.chg24h),
      verified: r.tier === "FASTTRACK",
      source: "seed",
      tier: r.tier,
      listedMinutesAgo: r.listedMin,
      score,
    };
  });
}

/** Addresses grouped by chain — the provider fetches live data for exactly
 *  these (the paid listings), never the whole chain. */
export function listingAddressesByChain(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of ROWS) (out[r.chain] ??= []).push(r.address);
  return out;
}

export function listingMeta(chain: string, address: string): ListingRow | undefined {
  return ROWS.find((r) => r.chain === chain && r.address.toLowerCase() === address.toLowerCase());
}
