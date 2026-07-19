import type { ReactNode } from "react";
import { BRAND_NAME } from "@/config/brand";
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
      <ListingModal />
      <WalletModal />
      <Toast />
      <PwaRegister />
    </AppProvider>
  );
}
