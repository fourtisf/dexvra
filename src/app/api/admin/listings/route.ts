import { NextRequest, NextResponse } from "next/server";
import { isAdmin, unauthorized } from "@/lib/adminGuard";
import { buildRow } from "@/lib/adminValidate";
import { addListing, allListings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();
  return NextResponse.json({ listings: await allListings() });
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();
  const body = await req.json().catch(() => ({}));
  const built = buildRow(body);
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });
  // Admin-created listings go live immediately.
  const listing = await addListing(built.row, { status: "approved", source: "admin" });
  return NextResponse.json({ listing });
}
