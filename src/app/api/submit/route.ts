import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/adminGuard";
import { buildRow } from "@/lib/adminValidate";
import { addListing } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public listing submissions land in the admin "pending" queue. Rate-limited so
// the queue can't be flooded.
const MAX = 5;
const WINDOW_MS = 10 * 60 * 1000;
const hits = new Map<string, { n: number; until: number }>();

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = hits.get(ip);
  if (rec && rec.until > now && rec.n >= MAX) {
    return NextResponse.json({ error: "Too many submissions — try again later." }, { status: 429 });
  }
  const base = rec && rec.until > now ? rec : { n: 0, until: now + WINDOW_MS };
  hits.set(ip, { n: base.n + 1, until: base.until });

  const body = await req.json().catch(() => ({}));
  // A public submitter can pick a package tier, but never self-assign a trending slot.
  const built = buildRow({ ...body, trendingRank: null });
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });

  await addListing(built.row, { status: "pending", source: "submission" });
  return NextResponse.json({ ok: true });
}
