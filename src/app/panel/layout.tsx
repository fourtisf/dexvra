import type { Metadata } from "next";
import type { ReactNode } from "react";

// The admin panel never renders the public sidebar/topbar and must never be
// indexed by search engines.
export const metadata: Metadata = {
  title: "Dexvra Admin",
  robots: { index: false, follow: false, nocache: true },
};

export default function PanelLayout({ children }: { children: ReactNode }) {
  return <div className="admin-root">{children}</div>;
}
