import { CHAINS } from "@/config/chains";
import type { ListingRow } from "./listings";
import type { ListingTier } from "./types";

export const TIER_KEYS: ListingTier[] = ["DIAMOND", "GOLD", "PLATINUM", "SILVER", "BRONZE", "XPRESS"];
const isTier = (x: unknown): x is ListingTier => typeof x === "string" && (TIER_KEYS as string[]).includes(x);

const URL_RE = /^https?:\/\/[^\s]+$/i;
const NUM_FIELDS = ["tax", "holders", "price", "chg24h", "mcap", "liq", "vol24h", "buyShare", "tx24h", "listedMin"] as const;

const num = (x: unknown, d: number): number => (Number.isFinite(Number(x)) ? Number(x) : d);
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

export interface ListingInput {
  chain?: string;
  address?: string;
  sym?: string;
  name?: string;
  emoji?: string;
  tier?: string;
  trendingRank?: number | null;
  website?: string;
  twitter?: string;
  telegram?: string;
  tax?: number;
  holders?: number;
  price?: number;
  chg24h?: number;
  mcap?: number;
  liq?: number;
  vol24h?: number;
  buyShare?: number;
  tx24h?: number;
  listedMin?: number;
}

type BuildResult = { ok: true; row: ListingRow } | { ok: false; error: string };

/** Validate + normalize a full new listing (admin add or public submission). */
export function buildRow(input: ListingInput): BuildResult {
  const chain = String(input.chain ?? "").trim();
  if (!CHAINS[chain]) return { ok: false, error: "Unknown chain" };

  const address = String(input.address ?? "").trim();
  if (!CHAINS[chain].addressPattern.test(address)) {
    return { ok: false, error: `Invalid ${CHAINS[chain].label} contract address` };
  }

  const symRaw = String(input.sym ?? "").trim().replace(/^\$+/, "").toUpperCase();
  // Restrict to a safe ticker charset (no markup/whitespace) — these render on
  // the public site and, escaped, in the signal wire.
  if (!symRaw || symRaw.length > 24 || !/^[A-Z0-9._-]+$/.test(symRaw)) {
    return { ok: false, error: "Invalid ticker" };
  }

  for (const [v, label] of [
    [input.website, "website"],
    [input.twitter, "X"],
    [input.telegram, "Telegram"],
  ] as const) {
    if (v && !URL_RE.test(String(v))) return { ok: false, error: `${label} must be a full https:// URL` };
  }

  const row: ListingRow = {
    chain,
    address,
    sym: `$${symRaw}`,
    name: String(input.name ?? "").trim().slice(0, 60) || symRaw,
    emoji: String(input.emoji ?? "").trim().slice(0, 4) || "🪙",
    tier: isTier(input.tier) ? input.tier : "BRONZE",
    trendingRank:
      input.trendingRank == null ? undefined : Math.max(1, Math.round(num(input.trendingRank, 1))),
    listedMin: Math.max(0, Math.round(num(input.listedMin, 0))),
    tax: clamp(num(input.tax, 0), 0, 100),
    holders: Math.max(0, Math.round(num(input.holders, 0))),
    price: Math.max(0, num(input.price, 0)),
    chg24h: num(input.chg24h, 0),
    mcap: Math.max(0, num(input.mcap, 0)),
    liq: Math.max(0, num(input.liq, 0)),
    vol24h: Math.max(0, num(input.vol24h, 0)),
    buyShare: clamp(num(input.buyShare, 0.5), 0, 1),
    tx24h: Math.max(0, Math.round(num(input.tx24h, 0))),
    website: input.website ? String(input.website) : undefined,
    twitter: input.twitter ? String(input.twitter) : undefined,
    telegram: input.telegram ? String(input.telegram) : undefined,
  };
  return { ok: true, row };
}

/** Sanitize a partial edit (admin PATCH). chain/address are immutable here. */
export function sanitizePatch(body: Record<string, unknown>): Partial<ListingRow> {
  const out: Partial<ListingRow> = {};
  if (typeof body.name === "string") out.name = body.name.trim().slice(0, 60);
  if (typeof body.emoji === "string") out.emoji = body.emoji.trim().slice(0, 4) || "🪙";
  if (isTier(body.tier)) out.tier = body.tier;

  if (body.trendingRank === null || body.trendingRank === "") {
    out.trendingRank = undefined;
  } else if (body.trendingRank != null && Number.isFinite(Number(body.trendingRank))) {
    out.trendingRank = Math.max(1, Math.round(Number(body.trendingRank)));
  }

  for (const k of ["website", "twitter", "telegram"] as const) {
    const v = body[k];
    if (typeof v === "string") {
      if (v === "") out[k] = undefined;
      else if (URL_RE.test(v)) out[k] = v;
    }
  }

  for (const k of NUM_FIELDS) {
    const v = body[k];
    if (v != null && Number.isFinite(Number(v))) {
      (out as Record<string, number>)[k] = Number(v);
    }
  }
  return out;
}
