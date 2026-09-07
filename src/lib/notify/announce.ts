// Server-only: the two things the bot posts. Both are best-effort — a failed
// post is logged into the return value, never thrown at the caller, because
// neither an admin approval nor a cron run should fail over a channel outage.
import type { ListingRow } from "@/lib/listings";
import type { PonsLaunchFeedItem } from "@/lib/providers/pons";
import { launchAnnouncement, listingAnnouncement } from "./messages";
import { claimListingAnnouncement } from "./state";
import { sendTelegram, telegramConfigured } from "./telegram";

/** Announces a listing that has just gone LIVE. Claims the id first, so an
 *  approve → reject → approve cycle posts once. */
export async function announceListingLive(id: string, listing: ListingRow): Promise<boolean> {
  if (!telegramConfigured()) return false;
  try {
    if (!(await claimListingAnnouncement(id))) return false;
    return await sendTelegram(listingAnnouncement(listing));
  } catch {
    return false;
  }
}

export const announceLaunch = (launch: PonsLaunchFeedItem): Promise<boolean> =>
  sendTelegram(launchAnnouncement(launch));
