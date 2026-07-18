import type { BoardToken } from "./types";

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

/**
 * Dexvra Score (0–100) — Dexvra ranks by ON-CHAIN SIGNAL, not paid votes.
 * A transparent blend of momentum, liquidity depth, tax, buy pressure and
 * holder base, computed from data we already have. Deterministic.
 */
export function dexvraScore(t: {
  chg: BoardToken["chg"];
  liq: number | null;
  taxPct: number | null;
  txns: BoardToken["txns"];
  holders: number | null;
}): number {
  const momentum = clamp((t.chg["24h"] + 20) / 240); // -20%..+220% → 0..1
  const liquidity = clamp(Math.log10((t.liq ?? 0) + 1) / 6.5); // ~$3M+ tops out
  const safety = t.taxPct == null ? 0.6 : t.taxPct === 0 ? 1 : clamp(1 - t.taxPct / 10);
  const tx = t.txns["24h"];
  const total = tx.buys + tx.sells;
  const buyPressure = total > 0 ? clamp(tx.buys / total) : 0.5;
  const community = t.holders == null ? 0.5 : clamp(Math.log10(t.holders + 1) / 5);

  const raw =
    momentum * 0.3 + liquidity * 0.25 + safety * 0.15 + buyPressure * 0.15 + community * 0.15;
  return Math.round(clamp(raw) * 100);
}

export function scoreTier(score: number): { label: string; color: string } {
  if (score >= 80) return { label: "ALPHA", color: "#3DDC97" };
  if (score >= 60) return { label: "STRONG", color: "#7CE0B0" };
  if (score >= 40) return { label: "MIXED", color: "#E7C77A" };
  if (score >= 20) return { label: "WEAK", color: "#EDA765" };
  return { label: "RISKY", color: "#F76A85" };
}
