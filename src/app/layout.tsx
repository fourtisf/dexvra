import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { BRAND_NAME, BRAND_TAGLINE } from "@/config/brand";
import { AppProvider } from "@/components/AppState";
import { ListingModal } from "@/components/ListingModal";
import { PwaRegister } from "@/components/PwaRegister";
import { Sidebar } from "@/components/Sidebar";
import { Ticker } from "@/components/Ticker";
import { Toast } from "@/components/Toast";
import { TokenDetailModal } from "@/components/TokenDetailModal";
import { Topbar } from "@/components/Topbar";
import "./globals.css";

export const metadata: Metadata = {
  title: `${BRAND_NAME} — ${BRAND_TAGLINE}`,
  description:
    "Multi-chain token listing & discovery. Fresh launches, trending boards, and safety scans across Solana, Base, Ethereum, BSC, TON, and Robinhood Chain.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icons/icon.svg", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: "#090C12",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppProvider>
          <div className="app">
            <Sidebar />
            <div className="main">
              <Topbar />
              <Ticker />
              <main className="content">
                {children}
                <footer className="foot">
                  <span>© 2026 {BRAND_NAME} · DYOR — nothing here is financial advice.</span>
                  <span className="links">
                    <a>Docs</a>
                    <a>API</a>
                    <a>X</a>
                    <a>Telegram</a>
                  </span>
                </footer>
              </main>
            </div>
          </div>
          <TokenDetailModal />
          <ListingModal />
          <Toast />
          <PwaRegister />
        </AppProvider>
      </body>
    </html>
  );
}
