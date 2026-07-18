"use client";

import { useRouter, usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { BRAND_NAME } from "@/config/brand";
import { fmtCap } from "@/lib/format";
import { Logo } from "./Logo";
import { useApp } from "./AppState";

export function Topbar() {
  const { data, wallet, toggleWallet, openListing, homeQuery, setHomeQuery } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);

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

  return (
    <header className="topbar">
      <div className="brand-top">
        <div className="brand-logo sm"><Logo size={32} /></div>
        <div className="brand-name">{BRAND_NAME}</div>
      </div>
      <label className="search">
        <svg viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.8-3.8" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search token, pair, or paste CA…"
          value={homeQuery}
          onChange={(e) => {
            setHomeQuery(e.target.value);
            if (pathname !== "/") router.push("/");
          }}
        />
        <kbd>/</kbd>
      </label>
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
