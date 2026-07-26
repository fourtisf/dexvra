import type { ReactNode } from "react";
import { BOT_URL, BRAND_NAME, TELEGRAM_TRENDING_URL, TELEGRAM_URL, X_URL } from "@/config/brand";
import { AppProvider } from "@/components/AppState";
import { WalletModal } from "@/components/WalletModal";
import { ListingModal } from "@/components/ListingModal";
import { PwaRegister } from "@/components/PwaRegister";
import { Sidebar } from "@/components/Sidebar";
import { Ticker } from "@/components/Ticker";
import { Toast } from "@/components/Toast";
import { Topbar } from "@/components/Topbar";

// Public site shell. Everything under (site)/ gets the sidebar/topbar chrome;
// the admin panel (/panel) lives outside this group and never renders it.
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
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
              {/* These were <a> tags with no href: they looked like links, hovered
                  like links, and went nowhere. Docs/API have no page yet, so they
                  are plain text until they do — the social ones are real. */}
              <span className="links">
                <span className="foot-soon">Docs</span>
                <span className="foot-soon">API</span>
                <a href={X_URL} target="_blank" rel="noopener noreferrer">X</a>
                <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">Telegram</a>
                <a href={TELEGRAM_TRENDING_URL} target="_blank" rel="noopener noreferrer">Trending</a>
                <a href={BOT_URL} target="_blank" rel="noopener noreferrer">Bot</a>
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
