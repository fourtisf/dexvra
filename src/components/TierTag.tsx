import type { CSSProperties } from "react";
import type { ListingTier } from "@/lib/types";
import { tierColor, tierGlyph, tierLabel, tierRank, tierTip } from "@/lib/packages";

// Tier badges are a LAUNCH perk — shown only for the first 48h after listing,
// then the token blends into the board like any other (no permanent tier).
export const TIER_TAG_MAX_MIN = 48 * 60;

/** The paid-listing tag a token carries for its first 48h — Diamond/Gold/
 *  Platinum/Silver/Bronze (ranked #1–#5) or Xpress (instant). Pass
 *  `ageMinutes` (minutes since listing) and the tag auto-hides after 48h. */
export function TierTag({
  tier,
  showRank = true,
  ageMinutes,
}: {
  tier: ListingTier;
  showRank?: boolean;
  ageMinutes?: number | null;
}) {
  if (ageMinutes != null && ageMinutes >= TIER_TAG_MAX_MIN) return null;
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
