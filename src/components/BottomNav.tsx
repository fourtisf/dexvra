"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Event the header's ⋮ menu listens for. ONE menu owns the full page list
 *  (Topbar, fed by NAV_GROUPS); "More" here opens it rather than growing a
 *  second copy of every link that could drift from the first. */
export const OPEN_MENU_EVENT = "dexvra:open-menu";

const ITEMS: { href: string; label: string; d: string }[] = [
  { href: "/", label: "Home", d: "M3 11.5 12 4l9 7.5M5.5 10.5V20h13v-9.5" },
  { href: "/trending", label: "Gainers", d: "M3 17l6-6 4 4 8-8M15 7h6v6" },
  { href: "/new-listings", label: "New", d: "M12 3v3M12 18v3M3 12h3M18 12h3M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z" },
  { href: "/watchlist", label: "Watchlist", d: "m12 3.5 2.5 5.2 5.7.7-4.2 4 1.1 5.6L12 16.3 6.9 19l1.1-5.6-4.2-4 5.7-.7L12 3.5z" },
];

/** The phone's thumb bar — mockup A. Shown ≤720px only. */
export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="bnav" aria-label="Quick navigation">
      {ITEMS.map((it) => (
        <Link key={it.href} href={it.href} className={pathname === it.href ? "on" : ""}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d={it.d} />
          </svg>
          <span>{it.label}</span>
        </Link>
      ))}
      <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_MENU_EVENT))}>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        <span>More</span>
      </button>
    </nav>
  );
}
