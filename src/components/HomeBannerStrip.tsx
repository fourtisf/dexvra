"use client";

// A plain, full-width homepage banner: the newest live banner booking (uploaded
// image + click-through link, managed in the admin panel's "Homepage banner"
// section) rendered as a simple clickable image strip. Renders nothing when no
// banner is live.
import { useEffect, useState } from "react";

type Banner = { imageUrl: string; linkUrl: string; title: string | null };

export function HomeBannerStrip() {
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/banners")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const b = j?.banners?.[0];
        if (alive && b?.imageUrl && b?.linkUrl) {
          setBanner({ imageUrl: b.imageUrl, linkUrl: b.linkUrl, title: b.title ?? null });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!banner) return null;
  return (
    <a
      className="home-banner"
      href={banner.linkUrl}
      target="_blank"
      rel="noopener noreferrer nofollow"
      aria-label={banner.title ?? "Sponsored banner"}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={banner.imageUrl} alt={banner.title ?? ""} />
      <span className="home-banner-tag">Ad</span>
    </a>
  );
}
