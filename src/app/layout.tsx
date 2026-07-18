import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { BRAND_NAME, BRAND_TAGLINE } from "@/config/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: `${BRAND_NAME} — ${BRAND_TAGLINE}`,
  description:
    "Multi-chain token listing & discovery. Fresh launches, trending boards, and safety scans across Solana, Base, Ethereum, BSC, TON, and Robinhood Chain.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: "/icons/apple-touch-icon.png",
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
