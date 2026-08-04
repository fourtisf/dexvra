import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { BRAND_NAME, BRAND_TAGLINE } from "@/config/brand";
import { SITE_ORIGIN, OG_IMAGE } from "@/config/site";
import { SITE_DESCRIPTION, siteJsonLd, jsonLdText } from "@/lib/seo";
import "./globals.css";

export const metadata: Metadata = {
  // Without this, every relative image in openGraph/twitter resolves against
  // nothing and Next drops it — which is why the og-image that has been sitting
  // in public/brand since launch never appeared on a shared link.
  metadataBase: new URL(SITE_ORIGIN),
  // "%s · Dexvra" on every child page, and the full line on the homepage. A
  // page title that does not carry the brand cannot win a brand search, and
  // fifteen pages sharing ONE title read as one page to a crawler.
  title: {
    default: `${BRAND_NAME} — ${BRAND_TAGLINE}`,
    template: `%s · ${BRAND_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: BRAND_NAME,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: BRAND_NAME,
    title: `${BRAND_NAME} — ${BRAND_TAGLINE}`,
    description: SITE_DESCRIPTION,
    url: "/",
    images: [OG_IMAGE],
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: `${BRAND_NAME} — ${BRAND_TAGLINE}`,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE.url],
  },
  // Spelled out rather than left to the default. `max-image-preview: large` is
  // what allows a full-width thumbnail beside the result instead of a small
  // crop, and it is off unless asked for.
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  manifest: "/manifest.webmanifest",
  icons: {
    // ?v=2 cache-busts the aggressively-cached favicon (browsers pinned an old
    // one). SVG first so modern browsers use the crisp vector gem.
    icon: [
      { url: "/icons/icon.svg?v=2", type: "image/svg+xml" },
      { url: "/favicon.ico?v=2", sizes: "any" },
      { url: "/icons/icon-32.png?v=2", type: "image/png", sizes: "32x32" },
      { url: "/icons/icon-192.png?v=2", type: "image/png", sizes: "192x192" },
    ],
    apple: "/icons/apple-touch-icon.png?v=2",
  },
};

export const viewport: Viewport = {
  themeColor: "#090C12",
  width: "device-width",
  initialScale: 1,
};

// Root layout is intentionally minimal — the public chrome lives in
// (site)/layout.tsx and the admin chrome in panel/layout.tsx, so /panel never
// inherits the public sidebar/topbar.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Organization + WebSite, once per page. This is what turns the brand
            name from a string on a page into a named thing with a website and a
            known set of official accounts — the whole point of a brand query.
            In <body> rather than <head>: Google reads it from either, and a
            layout cannot inject a raw <script> into <head>. */}
        <script
          type="application/ld+json"
          // Built from our own config, and jsonLdText escapes "<" so nothing in
          // it can close this element early.
          dangerouslySetInnerHTML={{ __html: jsonLdText(siteJsonLd()) }}
        />
        {children}
      </body>
    </html>
  );
}
