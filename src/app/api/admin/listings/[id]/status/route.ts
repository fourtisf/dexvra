import { NextRequest, NextResponse } from "next/server";
import { isAdmin, unauthorized } from "@/lib/adminGuard";
import { setStatus, type ListingStatus } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID: ListingStatus[] = ["approved", "pending", "rejected"];

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isAdmin(req))) return unauthorized();
  const body = await req.json().catch(() => ({}));
  const status = body?.status as ListingStatus;
  if (!VALID.includes(status)) return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  const listing = await setStatus(params.id, status);
  if (!listing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ listing });
}
