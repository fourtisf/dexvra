import { NextResponse } from "next/server";
import { getTokensPayload } from "@/lib/providers";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await getTokensPayload();
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=30" },
  });
}
