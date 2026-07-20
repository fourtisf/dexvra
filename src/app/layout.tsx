import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { BRAND_NAME, BRAND_TAGLINE } from "@/config/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: `${BRAND_NAME} — ${BRAND_TAGLINE}`,
  description:
    "Multi-chain token listing & discovery. Fresh launches, trending boards, and safety scans across Solana, Base, Ethereum, BSC, TON, Tron, and Robinhood Chain.",
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
      <body>{children}</body>
    </html>
  );
}
