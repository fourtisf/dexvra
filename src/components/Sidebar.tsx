"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BRAND_MARK, BRAND_NAME, BRAND_SUB } from "@/config/brand";
import { useApp } from "./AppState";

interface NavItem {
  href: string;
  label: string;
  icon: JSX.Element;
  badge?: "hot" | "new" | "live";
}

const stroke = { fill: "none" as const };

const DISCOVER: NavItem[] = [
  { href: "/", label: "Home", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10.5V20h13v-9.5" /></svg> },
  { href: "/trending", label: "Trending", badge: "hot", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg> },
  { href: "/new-pairs", label: "New Pairs", badge: "live", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /></svg> },
  { href: "/all-coins", label: "All Coins", icon: <svg viewBox="0 0 24 24" {...stroke}><circle cx="9" cy="9" r="5.5" /><path d="M15.5 8a5.5 5.5 0 1 1-7.4 7.4" /></svg> },
  { href: "/search", label: "Search", icon: <svg viewBox="0 0 24 24" {...stroke}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.8-3.8" /></svg> },
  { href: "/watchlist", label: "Watchlist", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="m12 3.5 2.5 5.2 5.7.7-4.2 4 1.1 5.6L12 16.3 6.9 19l1.1-5.6-4.2-4 5.7-.7L12 3.5z" /></svg> },
];

const TOOLS: NavItem[] = [
  { href: "/scanner", label: "Token Scanner", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3" /><path d="M8 12h8" /></svg> },
  { href: "/calculator", label: "Moon Calculator", icon: <svg viewBox="0 0 24 24" {...stroke}><rect x="5" y="3.5" width="14" height="17" rx="2.5" /><path d="M9 7.5h6M9 11h2.5M9 14.5h2.5M14.5 11v3.5" /></svg> },
  { href: "/playbook", label: "Playbook", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21V5.5z" /><path d="M8 7.5h8M8 11h5" /></svg> },
  { href: "/verified", label: "Get Verified", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M12 3 5 6v5c0 4.5 3 7.9 7 9.5 4-1.6 7-5 7-9.5V6l-7-3z" /><path d="m9 12 2.2 2.2L15.5 10" /></svg> },
  { href: "/alerts", label: "Alerts", badge: "new", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M6 9.5a6 6 0 1 1 12 0c0 4 1.6 5.3 2 6H4c.4-.7 2-2 2-6z" /><path d="M10 19a2 2 0 0 0 4 0" /></svg> },
  { href: "/advertise", label: "Advertise", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M4 10v4h3l6 4V6l-6 4H4z" /><path d="M17 9.5a4 4 0 0 1 0 5" /></svg> },
];

const APP: NavItem[] = [
  { href: "/install", label: "Install App", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M12 3v11M8 10l4 4 4-4" /><path d="M5 19h14" /></svg> },
  { href: "/account", label: "Account", icon: <svg viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20c1.4-3.4 4.1-5 7.5-5s6.1 1.6 7.5 5" /></svg> },
];

function NavGroup({ label, items, pathname }: { label: string; items: NavItem[]; pathname: string }) {
  return (
    <div style={{ width: "100%" }}>
      <div className="nav-label">{label}</div>
      <nav className="nav">
        {items.map((it) => (
          <Link key={it.href} href={it.href} title={it.label} className={pathname === it.href ? "active" : ""}>
            {it.icon}
            <span className="lbl">{it.label}</span>
            {it.badge === "hot" && <span className="badge-hot">HOT</span>}
            {it.badge === "new" && <span className="badge-new">NEW</span>}
            {it.badge === "live" && <span className="ldot" />}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { openListing } = useApp();
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">{BRAND_MARK}</div>
        <div className="brand-txt">
          <div className="brand-name">{BRAND_NAME}</div>
          <div className="brand-sub">{BRAND_SUB}</div>
        </div>
      </div>

      <button className="fasttrack" onClick={openListing}>
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M13 2 4.5 13.5H11L9.6 22 19 10h-6.6L13 2z" />
        </svg>
        <span className="lbl">List My Token</span>
      </button>

      <NavGroup label="Discover" items={DISCOVER} pathname={pathname} />
      <NavGroup label="Tools" items={TOOLS} pathname={pathname} />
      <NavGroup label="App" items={APP} pathname={pathname} />
    </aside>
  );
}
