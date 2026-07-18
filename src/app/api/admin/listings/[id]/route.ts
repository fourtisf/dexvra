import { NextRequest, NextResponse } from "next/server";
import { isAdmin, unauthorized } from "@/lib/adminGuard";
import { sanitizePatch } from "@/lib/adminValidate";
import { deleteListing, updateListing } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isAdmin(req))) return unauthorized();
  const body = await req.json().catch(() => ({}));
  const patch = sanitizePatch(body);
  const listing = await updateListing(params.id, patch);
  if (!listing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ listing });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isAdmin(req))) return unauthorized();
  const ok = await deleteListing(params.id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
