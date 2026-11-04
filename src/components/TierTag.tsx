import type { CSSProperties } from "react";
import type { ListingTier } from "@/lib/types";
import { publicTier, tierColor, tierGlyph, tierLabel, tierRank, tierTip } from "@/lib/packages";

/** The package tag every listing carries, always — Diamond/Gold/Platinum/
 *  Silver/Bronze (ranked #1–#5) or Xpress (instant).
 *
 *  "yang free listing juga harus ada … tulis aja sesuai dengan packagenya":
 *  the tag used to vanish 48h after listing and was never drawn for FREE, so
 *  most of the board carried no package at all. `publicTier` is the one owner
 *  of the name shown (the bot's FREE auto-listing reads as Xpress); this
 *  component only draws it. */
export function TierTag({ tier, showRank = true }: { tier: ListingTier; showRank?: boolean }) {
  const shown = publicTier(tier);
  const rank = tierRank(shown);
  return (
    <span
      className={`tier-chip tier-${shown}`}
      style={{ "--tc": tierColor(shown) } as CSSProperties}
      title={tierTip(shown)}
    >
      <span className="tier-glyph">{tierGlyph(shown)}</span>
      {tierLabel(shown)}
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
