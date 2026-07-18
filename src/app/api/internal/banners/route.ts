import { NextRequest, NextResponse } from "next/server";
import { internalAuthorized, unauthorizedInternal } from "@/lib/internalAuth";
import { addBanner, allBanners, type BannerBooking } from "@/lib/banners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const URL_RE = /^(https?:\/\/[^\s]+|\/api\/media\/[a-f0-9]{24}\.(png|jpe?g|webp|gif))$/i;
const LINK_RE = /^https?:\/\/[^\s]+$/i;

// GET  /api/internal/banners → all bookings (bot/admin views).
// POST /api/internal/banners → book a paid banner slot.
export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return unauthorizedInternal();
  return NextResponse.json({ banners: await allBanners() });
}

export async function POST(req: NextRequest) {
  if (!internalAuthorized(req)) return unauthorizedInternal();
  const b = await req.json().catch(() => ({}));

  const imageUrl = String(b.imageUrl ?? "").trim();
  const linkUrl = String(b.linkUrl ?? "").trim();
  const startsAt = Number(b.startsAt);
  const endsAt = Number(b.endsAt);

  if (!URL_RE.test(imageUrl)) return NextResponse.json({ error: "Invalid imageUrl" }, { status: 400 });
  if (!LINK_RE.test(linkUrl)) return NextResponse.json({ error: "linkUrl must be a full https:// URL" }, { status: 400 });
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
    return NextResponse.json({ error: "Invalid window" }, { status: 400 });
  }

  const rec: Omit<BannerBooking, "id" | "createdAt"> = {
    slot: String(b.slot ?? "Banner").slice(0, 40),
    size: String(b.size ?? "").slice(0, 24),
    imageUrl,
    linkUrl,
    title: b.title ? String(b.title).slice(0, 60) : undefined,
    chain: b.chain ? String(b.chain).slice(0, 20) : undefined,
    address: b.address ? String(b.address).slice(0, 80) : undefined,
    startsAt: Math.round(startsAt),
    endsAt: Math.round(endsAt),
    source: "bot",
  };
  const banner = await addBanner(rec);
  return NextResponse.json({ banner });
}
