import { NextResponse } from "next/server";
import { getFearGreed } from "@/lib/providers";

export const dynamic = "force-dynamic";

export async function GET() {
  const fng = await getFearGreed();
  return NextResponse.json(fng, {
    headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" },
  });
}
