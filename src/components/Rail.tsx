"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { BOT_URL, BRAND_NAME } from "@/config/brand";
import { chainOf } from "@/config/chains";
import { chainCounts, splitChains } from "@/lib/home";
import { ChainLogo } from "./ChainLogo";
import { Logo } from "./Logo";
import { NAV_GROUPS, type NavItem } from "./Sidebar";
import { useApp } from "./AppState";
import { CHAIN_PAGES } from "./useChainParam";

/**
 * The desktop rail — mockup A, "Tabel Terminal" ("yang ini bagus").
 *
 * Brand, search, the pages people actually move between, the CHAINS with their
 * counts, and the one primary action at the foot. Shown at ≥1101px; below that
 * the header carries the same navigation and the home page carries the chain
 * row, so nothing here is the only way to reach anything.
 *
 * ⚠️ THE SEARCH SLOT IS EMPTY ON PURPOSE. There is ONE search input on the
 * site — the header's (Topbar), with its "/" shortcut, its CA probe and its
 * dropdown — and at desktop widths CSS pins it over this slot. Rendering a
 * second input here would mean two "/" listeners and two network probes per
 * pasted contract, and two boxes that can disagree about what was typed.
 *
 * Chains are LINKS to `?chain=<id>`, not buttons holding state: the boards read
 * the same parameter (useChainParam), so the rail and the chain row below
 * 1100px are one control in two places and can never disagree — and a filtered
 * board is a URL somebody can share. On Home, Gainers & Losers and Leaderboard
 * they filter the page you are on; anywhere else they open the home board.
 */

// The rail's own short list, in the mockup's order. Every other page stays
// one tap away under "More" — read from NAV_GROUPS, so a page added there
// reaches the rail without a second edit.
const PRIMARY: { href: string; label: string }[] = [
  { href: "/", label: "Trending" },
  { href: "/new-listings", label: "New Listings" },
  { href: "/trending", label: "Gainers & Losers" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/alerts", label: "Alerts" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/advertise", label: "Advertise" },
];

const ALL_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
const iconFor = (href: string) => ALL_ITEMS.find((it) => it.href === href)?.icon ?? null;
const FLAME = (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M12 3s5 4.2 5 9.2a5 5 0 0 1-10 0c0-2.2 1.1-3.4 1.1-3.4s.2 2.8 2.2 2.8C10.3 7.4 12 3 12 3z" />
  </svg>
);

export function Rail() {
  const pathname = usePathname();
  const params = useSearchParams();
  const { data } = useApp();
  const [more, setMore] = useState(false);
  const [allChains, setAllChains] = useState(false);

  const tokens = data?.tokens ?? [];
  const counts = useMemo(() => chainCounts(tokens), [tokens]);
  const { shown, hidden } = splitChains(counts);
  // On a page whose board takes a chain filter the links filter THAT page;
  // anywhere else they lead to the home board, filtered.
  const filterable = CHAIN_PAGES.includes(pathname);
  const base = filterable ? pathname : "/";
  const activeChain = filterable ? params.get("chain") ?? "all" : null;
  // A chain picked from behind "+N more" stays listed while it filters.
  const chains = allChains || hidden.some((c) => c.id === activeChain) ? [...shown, ...hidden] : shown;

  const primary = new Set(PRIMARY.map((p) => p.href));
  const rest = ALL_ITEMS.filter((it) => !primary.has(it.href));

  return (
    <aside className="rail" aria-label="Site">
      <Link href="/" className="rail-brand" aria-label={`${BRAND_NAME} home`}>
        {/* its own gradient id: the header's copy (default id) is hidden at these
            widths and comes later — two marks sharing one id resolve to the
            first, and a hidden first one paints nothing */}
        <Logo size={30} gid="dxvRailMark" />
        <span>{BRAND_NAME}</span>
      </Link>
      <div className="rail-search-slot" aria-hidden />

      <div className="rail-scroll">
        <nav className="rail-nav" aria-label="Pages">
          {PRIMARY.map((p) => (
            <Link key={p.href} href={p.href} className={pathname === p.href ? "on" : ""}>
              {p.href === "/" ? FLAME : iconFor(p.href)}
              <span>{p.label}</span>
            </Link>
          ))}
          <button type="button" className={`rail-more ${more ? "open" : ""}`} aria-expanded={more} onClick={() => setMore((v) => !v)}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M5 12h.01M12 12h.01M19 12h.01" />
            </svg>
            <span>More</span>
            <svg className="rail-caret" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {more &&
            rest.map((it) => (
              <Link key={it.href} href={it.href} className={`rail-sub ${pathname === it.href ? "on" : ""}`}>
                {it.icon}
                <span>{it.label}</span>
              </Link>
            ))}
        </nav>

        {counts.length > 0 && (
          <>
            <div className="rail-lbl">Chains</div>
            <nav className="rail-nav rail-chains" aria-label="Filter by chain">
              <Link href={base} scroll={false} className={activeChain === "all" ? "on2" : ""}>
                {/* the chain row's own "all" glyph, so the two filters draw it alike */}
                <svg className="rail-all" viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
                </svg>
                <span>All chains</span>
                <em>{tokens.length}</em>
              </Link>
              {chains.map((c) => (
                <Link
                  key={c.id}
                  href={`${base}?chain=${encodeURIComponent(c.id)}`}
                  scroll={false}
                  className={`${activeChain === c.id ? "on2" : ""} ${c.count === 0 ? "rail-zero" : ""}`}
                >
                  <ChainLogo chain={c.id} size={16} />
                  <span>{chainOf(c.id)?.label ?? c.id}</span>
                  <em>{c.count}</em>
                </Link>
              ))}
              {hidden.length > 0 && (
                <button type="button" className="rail-more-chains" onClick={() => setAllChains((v) => !v)}>
                  {allChains ? "Fewer chains" : `+${hidden.length} more chains`}
                </button>
              )}
            </nav>
          </>
        )}
      </div>

      <a className="rail-cta" href={BOT_URL} target="_blank" rel="noopener noreferrer">
        <svg className="cta-ic" viewBox="0 0 24 24" aria-hidden>
          <path d="M13.2 2 4.6 13.4h6.1L9.8 22l8.6-11.4h-6.1L13.2 2Z" />
        </svg>
        List your token
      </a>
    </aside>
  );
}
