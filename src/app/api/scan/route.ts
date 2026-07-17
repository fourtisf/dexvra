import { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { scanToken } from "@/lib/providers/security";

export const dynamic = "force-dynamic";

const SCAN_TTL = 10 * 60_000; // handoff: scan results 10 min

export async function GET(req: NextRequest) {
  const address = (req.nextUrl.searchParams.get("ca") ?? "").trim();
  if (address.length < 20 || address.length > 90 || /[^A-Za-z0-9:_-]/.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }
  const result = await cached(`scan:${address}`, SCAN_TTL, () => scanToken(address));
  return NextResponse.json(result);
}
