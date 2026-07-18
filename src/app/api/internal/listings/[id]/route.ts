import { NextRequest, NextResponse } from "next/server";
import { internalAuthorized, unauthorizedInternal } from "@/lib/internalAuth";
import { sanitizePatch } from "@/lib/adminValidate";
import { updateListing } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /api/internal/listings/:id → partial field update (tier, logoUrl,
// socials, trendingRank, trendStart/trendExp). chain/address are immutable.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!internalAuthorized(req)) return unauthorizedInternal();
  const body = await req.json().catch(() => ({}));
  const patch = sanitizePatch(body);
  const listing = await updateListing(params.id, patch);
  if (!listing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ listing });
}
