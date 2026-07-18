import { NextResponse } from "next/server";
import { activeBanners } from "@/lib/banners";

export const dynamic = "force-dynamic";

// Public: currently-running banner bookings for the homepage carousel takeover
// slot + the /advertise page. Only the fields the client needs to render.
export async function GET() {
  try {
    const active = await activeBanners();
    const banners = active.map((b) => ({
      slot: b.slot,
      size: b.size,
      imageUrl: b.imageUrl,
      linkUrl: b.linkUrl,
      title: b.title ?? null,
      endsAt: b.endsAt,
    }));
    return NextResponse.json(
      { banners },
      { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=60" } },
    );
  } catch {
    return NextResponse.json({ banners: [] });
  }
}
