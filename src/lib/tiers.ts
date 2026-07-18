import type { ListingTier } from "./types";

// The three paid-listing tiers. A project chooses one when it pays to list on
// Dexvra — the tier decides placement/visibility, NOT the Dexvra Score (which
// is on-chain-signal only). The tag on a token shows which package it bought.
export interface TierMeta {
  key: ListingTier;
  label: string; // display label
  price: string; // listing fee
  color: string; // chip color (matches globals.css tier-* classes)
  blurb: string; // one-line what-you-get, used as tooltip
}

export const TIERS: Record<ListingTier, TierMeta> = {
  TRENCH: {
    key: "TRENCH",
    label: "Trench",
    price: "0.5 SOL",
    color: "#B79CFF",
    blurb: "Trench · 0.5 SOL — entry listing. Appears on the board and in discovery once approved.",
  },
  EXPRESS: {
    key: "EXPRESS",
    label: "Express",
    price: "2 SOL",
    color: "#4CC7D4",
    blurb: "Express · 2 SOL — priority review + higher board placement and category boosts.",
  },
  FASTTRACK: {
    key: "FASTTRACK",
    label: "Fast-Track",
    price: "5 SOL",
    color: "#E7C77A",
    blurb: "Fast-Track · 5 SOL — top placement, verified badge, homepage + Signal Feed spotlight.",
  },
};

export const tierLabel = (t: string) => TIERS[t as ListingTier]?.label ?? t;
export const tierTip = (t: string) => TIERS[t as ListingTier]?.blurb ?? "";
