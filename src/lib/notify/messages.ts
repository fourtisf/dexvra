// Channel post bodies. Pure string building, no I/O — the shapes are asserted
// in scripts/test-pons.mjs, including that on-chain metadata gets escaped.
import { PONS } from "@/config/pons";
import { fmtAge, fmtCap, fmtPrice } from "@/lib/format";
import type { PonsLaunchFeedItem } from "@/lib/providers/pons";
import type { ListingRow } from "@/lib/listings";
import { tierLabel } from "@/lib/packages";
import { clip, escapeHtml } from "./telegram";

const e = (value: string | null | undefined, max = 48): string => escapeHtml(clip(value, max));

export const siteUrl = (): string =>
  (process.env.SITE_URL ?? "https://dexvra.io").trim().replace(/\/+$/, "");

/** "🏹 New Pons launch" — an auto-discovered launch, explicitly not a listing. */
export function launchAnnouncement(launch: PonsLaunchFeedItem): string {
  const ticker = launch.symbol ? `$${e(launch.symbol, 24)}` : "New token";
  const name = e(launch.name, 48);
  const price = launch.priceUsd != null ? fmtPrice(launch.priceUsd) : "—";
  const mcap = launch.mcapUsd != null ? fmtCap(launch.mcapUsd) : "—";
  const stage = launch.graduated
    ? "graduated to Uniswap V4 · liquidity locked"
    : `bonding curve ${(launch.progressPct ?? 0).toFixed(0)}%`;

  return [
    `🏹 <b>New Pons launch</b>`,
    `<b>${ticker}</b>${name ? ` — ${name}` : ""}`,
    `Robinhood Chain · ${stage}`,
    `Price ${escapeHtml(price)} · MCAP ${escapeHtml(mcap)} · ${escapeHtml(fmtAge(launch.ageMinutes))} old`,
    `<code>${e(launch.address, 64)}</code>`,
    `<a href="${escapeHtml(launch.ponsUrl)}">Open on Pons</a> · <a href="${escapeHtml(launch.explorerUrl)}">Explorer</a>`,
    `<i>Auto-discovered, not a Dexvra listing. DYOR.</i>`,
  ].join("\n");
}

/** "✅ Now live on Dexvra" — a paid listing an admin has approved. */
export function listingAnnouncement(listing: ListingRow): string {
  const chainLabel = listing.chain === PONS.chain ? "Robinhood Chain" : listing.chain;
  const token = `${e(listing.sym, 24)}`;
  const path = `${siteUrl()}/token/${encodeURIComponent(listing.chain)}/${encodeURIComponent(listing.address)}`;
  return [
    `✅ <b>Now live on Dexvra</b>`,
    `<b>${token}</b> — ${e(listing.name, 48)}`,
    `${escapeHtml(chainLabel)} · ${escapeHtml(tierLabel(listing.tier))} listing`,
    `<code>${e(listing.address, 64)}</code>`,
    `<a href="${escapeHtml(path)}">View on Dexvra</a>`,
  ].join("\n");
}
