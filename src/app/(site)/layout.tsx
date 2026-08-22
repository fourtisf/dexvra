import type { ReactNode } from "react";
import Link from "next/link";
import { BOT_URL, BRAND_NAME, TELEGRAM_TRENDING_URL, TELEGRAM_URL, X_LISTING_URL, X_URL } from "@/config/brand";
import { AppProvider } from "@/components/AppState";
import { WalletModal } from "@/components/WalletModal";
import { ListingModal } from "@/components/ListingModal";
import { PwaRegister } from "@/components/PwaRegister";
import { Ticker } from "@/components/Ticker";
import { Toast } from "@/components/Toast";
import { Topbar } from "@/components/Topbar";

// Public site shell — top-navigation, one column. The sidebar was the old
// identity's strongest structural signature; navigation lives in the header
// now (primary links inline, everything else behind the ⋮ menu, which
// Sidebar.tsx still feeds via NAV_GROUPS). The admin panel (/panel) lives
// outside this group and never renders any of it.
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <div className="app">
        <div className="main">
          <Topbar />
          <Ticker />
          <main className="content">
            {children}
            <footer className="foot">
              <span>© 2026 {BRAND_NAME} · DYOR — nothing here is financial advice.</span>
              {/* These were <a> tags with no href: they looked like links, hovered
                  like links, and went nowhere. Docs/API have no page yet, so they
                  are plain text until they do — the social ones are real. */}
              <span className="links">
                <span className="foot-soon">Docs</span>
                <span className="foot-soon">API</span>
                <a href={X_LISTING_URL} target="_blank" rel="noopener noreferrer">Listing alerts on X</a>
                <a href={X_URL} target="_blank" rel="noopener noreferrer">X</a>
                <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">Telegram</a>
                <a href={TELEGRAM_TRENDING_URL} target="_blank" rel="noopener noreferrer">Trending</a>
                <a href={BOT_URL} target="_blank" rel="noopener noreferrer">Bot</a>
                <Link href="/community">All channels</Link>
              </span>
            </footer>
          </main>
        </div>
      </div>
      <ListingModal />
      <WalletModal />
      <Toast />
      <PwaRegister />
    </AppProvider>
  );
}
