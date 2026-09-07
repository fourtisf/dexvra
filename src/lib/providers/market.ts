import type { PeriodKey, TxSplit } from "@/lib/types";

/** Normalised live market data for one token, whatever provider produced it. */
export interface LiveMarket {
  priceUsd: number;
  mcap: number | null;
  liq: number | null;
  chg: Record<PeriodKey, number>;
  vol: Record<PeriodKey, number>;
  txns: Record<PeriodKey, TxSplit>;
  ageMinutes: number | null;
  logoUrl: string | null;
  poolAddress: string | null; // top pool contract — for the chart embed
  /**
   * How far back the per-period stats are actually backed by data. Providers
   * that always return a full day omit it; the Pons provider fills its window
   * incrementally, so periods longer than this must keep their fallback value
   * rather than be published as complete.
   */
  statsCoverageMinutes?: number;
}

/** Periods whose stats this market covers, given its declared coverage. */
export const coveredPeriods = (market: LiveMarket): Set<PeriodKey> => {
  const minutes: Record<PeriodKey, number> = { "5m": 5, "1h": 60, "6h": 360, "24h": 1440 };
  const coverage = market.statsCoverageMinutes;
  const keys = Object.keys(minutes) as PeriodKey[];
  if (coverage == null) return new Set(keys);
  return new Set(keys.filter((key) => minutes[key] <= coverage));
};
