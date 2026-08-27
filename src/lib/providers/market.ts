import type { PeriodKey, TxSplit } from "@/lib/types";

/** The contract every market-data provider fulfils. DexScreener is primary;
 *  GeckoTerminal implements the same shape as the fallback, so the merge in
 *  `providers/index.ts` never branches on which one answered. */
export interface LiveMarket {
  priceUsd: number;
  mcap: number | null;
  liq: number | null;
  chg: Record<PeriodKey, number>;
  vol: Record<PeriodKey, number>;
  txns: Record<PeriodKey, TxSplit>;
  ageMinutes: number | null;
  logoUrl: string | null;
  /** Top AMM pool/pair contract — the chart embed and the trades feed are both
   *  keyed by this, never by the token address. */
  poolAddress: string | null;
  /** Project links the provider knows about; each null when it doesn't. */
  links: { website: string | null; twitter: string | null; telegram: string | null };
}

/** Signature shared by `dexscreener.fetchListedMarket` and the GeckoTerminal
 *  fallback: live data for specific listed addresses on one chain, keyed by
 *  lowercased address. Throws on network/HTTP failure (caller falls back). */
export type MarketFetcher = (chainId: string, addresses: string[]) => Promise<Map<string, LiveMarket>>;

export const EMPTY_LINKS: LiveMarket["links"] = { website: null, twitter: null, telegram: null };

/** Numeric coercion shared by the providers — both hand back stringy numbers. */
export const num = (s: unknown): number | null => {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
