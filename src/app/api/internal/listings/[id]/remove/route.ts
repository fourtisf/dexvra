import { NextRequest, NextResponse } from "next/server";
import { internalAuthorized, unauthorizedInternal } from "@/lib/internalAuth";
import { handDeleteRefusal } from "@/lib/handDelete";
import { allListings, deleteListing } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/internal/listings/:id/remove  { address } → delete ONE listing an
// operator named by hand (`npm run listing:delete` in bot/). Unlike the bulk
// DELETE beside it this may remove a paid row — the admin console's 🗑 can, and
// this is the same decision taken from a shell. See lib/handDelete.ts for why
// the address is restated and why only one script may call it.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!internalAuthorized(req)) return unauthorizedInternal();
  const body = await req.json().catch(() => ({}));
  const row = (await allListings()).find((r) => r.id === params.id);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const refusal = handDeleteRefusal(row, body && body.address);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });
  const ok = await deleteListing(params.id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    deleted: true,
    chain: row.chain,
    address: row.address,
    sym: row.sym,
    tier: row.tier,
    source: row.source ?? null,
  });
}
