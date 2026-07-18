import type { CSSProperties } from "react";
import type { ListingTier } from "@/lib/types";
import { tierColor, tierGlyph, tierLabel, tierRank, tierTip } from "@/lib/packages";

/** The paid-listing tag every token carries — Diamond/Gold/Platinum/Silver/
 *  Bronze (ranked #1–#5) or Xpress (instant). Color comes from the tier. */
export function TierTag({ tier, showRank = true }: { tier: ListingTier; showRank?: boolean }) {
  const rank = tierRank(tier);
  return (
    <span
      className={`tier-chip tier-${tier}`}
      style={{ "--tc": tierColor(tier) } as CSSProperties}
      title={tierTip(tier)}
    >
      <span className="tier-glyph">{tierGlyph(tier)}</span>
      {tierLabel(tier)}
      {showRank && rank > 0 && <span className="tier-rank">#{rank}</span>}
    </span>
  );
}

/** Featured-on-Trending indicator. No number shown — placement/order conveys
 *  priority (higher-tier packages rank first). */
export function TrendingBadge({ big = false }: { big?: boolean }) {
  return (
    <span className={`trend-badge ${big ? "big" : ""}`} title="Featured on the Trending board">
      🔥 Trending
    </span>
  );
}
