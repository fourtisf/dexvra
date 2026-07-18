"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND_NAME } from "@/config/brand";
import { CHAINS } from "@/config/chains";
import { fmtCap, fmtPrice } from "@/lib/format";
import { Coin } from "./Coin";
import { Logo } from "./Logo";
import { useApp } from "./AppState";

export function Topbar() {
  const { data, wallet, toggleWallet, openListing, openDetail, homeQuery, setHomeQuery } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);

  // "/" focuses the topbar search from anywhere (prototype behavior)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (e.key === "/" && !["input", "select", "textarea"].includes(tag)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const q = homeQuery.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [];
    return (data?.tokens ?? [])
      .filter((t) => (t.symbol + t.name + t.address).toLowerCase().includes(q))
      .slice(0, 8);
  }, [data, q]);

  const go = (t: (typeof matches)[number]) => {
    setHomeQuery("");
    setOpen(false);
    openDetail(t);
  };

  return (
    <header className="topbar">
      <Link href="/" className="brand-top" aria-label={`${BRAND_NAME} home`}>
        <div className="brand-logo sm spin"><Logo size={32} /></div>
        <div className="brand-name">{BRAND_NAME}</div>
      </Link>
      <div className="search-wrap">
        <label className="search">
          <svg viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.8-3.8" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search token, name, or paste CA…"
            value={homeQuery}
            onChange={(e) => {
              setHomeQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) go(matches[0]);
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <kbd>/</kbd>
        </label>
        {open && q && (
          <div className="search-dd">
            {matches.length === 0 ? (
              <div className="sdd-empty">No token matches “{homeQuery.trim()}”.</div>
            ) : (
              matches.map((t) => {
                const up = t.chg["24h"] >= 0;
                return (
                  <button key={t.key} className="sdd-item" onMouseDown={(e) => { e.preventDefault(); go(t); }}>
                    <Coin token={t} size={30} fontSize={14} />
                    <div className="sdd-id">
                      <div className="sdd-sym">{t.symbol}</div>
                      <div className="sdd-nm">{t.name} · {CHAINS[t.chain]?.label ?? t.chain}</div>
                    </div>
                    <div className="sdd-px">
                      <div>{fmtPrice(t.priceUsd)}</div>
                      <div className={up ? "sdd-up" : "sdd-dn"}>{up ? "+" : ""}{t.chg["24h"].toFixed(1)}%</div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
      <div className="top-stat">
        <span className="dot-live" />
        24H TRACKED <b>{data ? fmtCap(data.trackedVol24h) : "…"}</b>
      </div>
      <button className={`btn-wallet ${wallet ? "connected" : ""}`} onClick={toggleWallet}>
        <svg viewBox="0 0 24 24">
          <rect x="3" y="6" width="18" height="13" rx="3" />
          <path d="M16 12h.01M3 10h18" />
        </svg>
        <span className="lbl">{wallet ?? "Connect Wallet"}</span>
      </button>
      <button className="btn-primary" onClick={openListing}>
        ⚡ <span className="lbl">List Token</span>
      </button>
    </header>
  );
}
