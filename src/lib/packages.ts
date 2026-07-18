import type { ListingTier } from "./types";

// ─────────────────────────────────────────────────────────────────────────
// Dexvra paid-listing packages — priced 1:1 with the Fourtis model, billed in
// each chain's NATIVE coin (pay on SOL → SOL, on BSC → BNB, on ETH/Base → ETH).
// TON has no Fourtis reference, so its figures are extrapolated and easy to
// tune here without touching UI.
// ─────────────────────────────────────────────────────────────────────────

/** Settlement currency per chain. */
export const NATIVE: Record<string, string> = {
  solana: "SOL",
  ethereum: "ETH",
  base: "ETH",
  bsc: "BNB",
  ton: "TON",
  robinhood: "ETH",
};
export const nativeOf = (chain: string): string => NATIVE[chain] ?? "SOL";

// ── Listing tiers ─────────────────────────────────────────────────────────
// The tag every listed token carries. Ranked #1 (Diamond) → #5 (Bronze);
// the top three include an @announcement post. Xpress is a separate instant
// listing (no rank). Prices keyed by native symbol.
export interface ListingTierMeta {
  key: ListingTier;
  rank: number; // 1 = Diamond … 5 = Bronze; 0 = Xpress (unranked)
  label: string;
  glyph: string;
  color: string;
  announce: boolean;
  instant: boolean;
  price: Record<string, number>; // by native symbol
  blurb: string;
}

export const LISTING_TIERS: ListingTierMeta[] = [
  {
    key: "DIAMOND", rank: 1, label: "Diamond", glyph: "◆", color: "#8FE3FF",
    announce: true, instant: false,
    price: { BNB: 1.5, SOL: 5, ETH: 0.26, TON: 250 },
    blurb: "Diamond · Tier #1 — top listing placement, verified badge, announcement post.",
  },
  {
    key: "GOLD", rank: 2, label: "Gold", glyph: "★", color: "#E7C77A",
    announce: true, instant: false,
    price: { BNB: 1.25, SOL: 4.5, ETH: 0.24, TON: 225 },
    blurb: "Gold · Tier #2 — high placement, verified badge, announcement post.",
  },
  {
    key: "PLATINUM", rank: 3, label: "Platinum", glyph: "◈", color: "#D8DEE9",
    announce: true, instant: false,
    price: { BNB: 1.15, SOL: 4, ETH: 0.22, TON: 200 },
    blurb: "Platinum · Tier #3 — priority placement, verified badge, announcement post.",
  },
  {
    key: "SILVER", rank: 4, label: "Silver", glyph: "●", color: "#AAB2BD",
    announce: false, instant: false,
    price: { BNB: 1, SOL: 3.5, ETH: 0.2, TON: 175 },
    blurb: "Silver · Tier #4 — standard listing on the board & discovery.",
  },
  {
    key: "BRONZE", rank: 5, label: "Bronze", glyph: "●", color: "#CB8E5E",
    announce: false, instant: false,
    price: { BNB: 0.75, SOL: 3, ETH: 0.18, TON: 150 },
    blurb: "Bronze · Tier #5 — entry listing on the board & discovery.",
  },
  {
    key: "XPRESS", rank: 0, label: "Xpress", glyph: "⚡", color: "#4CC7D4",
    announce: false, instant: true,
    price: { ETH: 0.06, SOL: 1, BNB: 0.25, TON: 40 },
    blurb: "Xpress — instant activation, listed live on TG + trending board, priority verification.",
  },
];

const TIER_MAP: Record<string, ListingTierMeta> = Object.fromEntries(
  LISTING_TIERS.map((t) => [t.key, t]),
);

export const tierMeta = (key: string): ListingTierMeta | undefined => TIER_MAP[key];
export const tierLabel = (key: string): string => TIER_MAP[key]?.label ?? key;
export const tierTip = (key: string): string => TIER_MAP[key]?.blurb ?? "";
export const tierColor = (key: string): string => TIER_MAP[key]?.color ?? "#AAB2BD";
export const tierGlyph = (key: string): string => TIER_MAP[key]?.glyph ?? "●";
export const tierRank = (key: string): number => TIER_MAP[key]?.rank ?? 0;

/** Native-coin price of a tier on a given chain, e.g. Diamond on Solana → 5. */
export const tierPrice = (key: string, chain: string): number | null => {
  const m = TIER_MAP[key];
  if (!m) return null;
  return m.price[nativeOf(chain)] ?? null;
};

// ── Trending packages ─────────────────────────────────────────────────────
// Time-boxed featured slots on the Trending board. Prices per native coin and
// duration exactly as published; longer runs discount. 24H & 48H are posted to
// the announcement channel.
export interface TrendingRow {
  duration: string;
  price: number;
  discount: number; // %
}

export const TRENDING: Record<string, TrendingRow[]> = {
  BNB: [
    { duration: "3H", price: 0.25, discount: 0 },
    { duration: "6H", price: 0.5, discount: 0 },
    { duration: "12H", price: 0.9, discount: 10 },
    { duration: "18H", price: 1.2, discount: 20 },
    { duration: "24H", price: 1.5, discount: 25 },
    { duration: "48H", price: 2.8, discount: 30 },
  ],
  ETH: [
    { duration: "6H", price: 0.1, discount: 0 },
    { duration: "12H", price: 0.18, discount: 10 },
    { duration: "16H", price: 0.23, discount: 15 },
    { duration: "18H", price: 0.24, discount: 20 },
    { duration: "24H", price: 0.3, discount: 25 },
    { duration: "48H", price: 0.56, discount: 30 },
  ],
  SOL: [
    { duration: "6H", price: 1.25, discount: 0 },
    { duration: "12H", price: 2.25, discount: 10 },
    { duration: "18H", price: 3.2, discount: 15 },
    { duration: "24H", price: 4, discount: 20 },
    { duration: "48H", price: 7.5, discount: 25 },
  ],
  // Extrapolated (no Fourtis TON reference) — tune freely.
  TON: [
    { duration: "6H", price: 40, discount: 0 },
    { duration: "12H", price: 72, discount: 10 },
    { duration: "18H", price: 100, discount: 15 },
    { duration: "24H", price: 130, discount: 20 },
    { duration: "48H", price: 240, discount: 25 },
  ],
};

export const trendingForChain = (chain: string): TrendingRow[] =>
  TRENDING[nativeOf(chain)] ?? TRENDING.SOL;

// ── Banner ads ────────────────────────────────────────────────────────────
// Rotating homepage banner slots, billed in USD by run length.
export interface BannerRow {
  duration: string;
  usd: number;
  discount: number;
}
export interface BannerPack {
  name: string;
  size: string;
  rows: BannerRow[];
}

export const BANNERS: BannerPack[] = [
  {
    name: "Standard Banner",
    size: "728 × 90",
    rows: [
      { duration: "1 Day", usd: 225, discount: 10 },
      { duration: "3 Days", usd: 670, discount: 20 },
      { duration: "7 Days", usd: 1220, discount: 30 },
    ],
  },
  {
    name: "Wide Banner",
    size: "1022 × 115",
    rows: [
      { duration: "1 Day", usd: 400, discount: 10 },
      { duration: "3 Days", usd: 1080, discount: 20 },
      { duration: "7 Days", usd: 2205, discount: 30 },
    ],
  },
];

// ── Formatting helpers ────────────────────────────────────────────────────
/** Trim float noise: 0.5 → "0.5", 5 → "5", 0.26 → "0.26". */
export const fmtAmount = (n: number): string =>
  Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));

export const fmtNative = (n: number, sym: string): string => `${fmtAmount(n)} ${sym}`;
export const fmtUsd = (n: number): string => `$${n.toLocaleString("en-US")}`;
