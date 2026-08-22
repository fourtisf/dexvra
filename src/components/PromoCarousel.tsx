"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { BOT_URL, BRAND_NAME } from "@/config/brand";
import { CHAIN_IDS } from "@/config/chains";
import { useApp } from "./AppState";

const N = 3;
const AUTO_MS = 5000;

// Client-safe fallback (mirrors PROMO_DEFAULTS in lib/promo.ts) — used until
// /api/promo loads, and if it's unreachable.
type Promo = { emoji: string; symbol: string; multiplier: string; mcap: string; ath: string; chain: string };
const PROMO_FALLBACK: Promo = {
  emoji: "⚔️", symbol: "$WARCHEST", multiplier: "412×", mcap: "$310K", ath: "$128.4M", chain: "Solana",
};

// Slides 2 & 3 are ad inventory (Carousel Takeover) — kept as house ads
// until real bookings exist (Phase 3).
export function PromoCarousel() {
  const { openListing, reducedMotion } = useApp();
  void openListing;
  const [idx, setIdx] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // The uploaded/booked ad banner renders as a dedicated plain strip on the
  // homepage (HomeBannerStrip) — slide 2 here stays the house "Boost your token"
  // promo so the same creative never shows twice.

  // Editable "Pumped on Dexvra" showcase (admin panel → /api/promo).
  const [promo, setPromo] = useState<Promo>(PROMO_FALLBACK);
  useEffect(() => {
    let alive = true;
    fetch("/api/promo")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j && j.symbol) setPromo({ ...PROMO_FALLBACK, ...j });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const stop = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (reducedMotion) return;
    stop();
    timer.current = setInterval(() => setIdx((i) => (i + 1) % N), AUTO_MS);
  }, [reducedMotion, stop]);

  useEffect(() => {
    start();
    return stop;
  }, [start, stop]);

  const go = (i: number) => {
    setIdx(((i % N) + N) % N);
    start();
  };

  return (
    <div className="promo" onMouseEnter={stop} onMouseLeave={start}>
      <div className="promo-track" style={{ transform: `translateX(-${idx * 100}%)` }}>
        {/* Typography-led, deliberately. The emoji coins orbiting a badge, the
            rocket watermark and the sparkles read as template clip-art — the
            single loudest "cheap" signal on the page (operator: "design ulang
            semuanya yang clean elegan premium"). What a slide keeps is a
            field, a headline, one proof point and one action; the brand mark
            appears once, as line GEOMETRY, not a sticker. */}
        <div className="slide s-moon">
          <svg className="hero-mark" viewBox="0 0 220 160" aria-hidden="true">
            <path className="dim" d="M60 30 H160 L196 66 L110 146 L24 66 Z" />
            <path d="M24 66 H196 M60 30 L88 66 M160 30 L132 66 M88 66 H132 M88 66 L110 146 M132 66 L110 146" />
          </svg>
          <span className="blip-tag">{promo.symbol} +{promo.multiplier}</span>
          <div className="slide-copy">
            <span className="s-eyebrow"><span className="dot-live" />Live · {CHAIN_IDS.length} chains</span>
            <h2>
              Find the next <em className="hero-serif">moonshot</em> first.
            </h2>
            <p>Fresh launches, whale flow and on-chain signal — on {BRAND_NAME} before the crowd.</p>
            <a className="btn-slide" href={BOT_URL} target="_blank" rel="noopener noreferrer">Express Listing</a>
          </div>
        </div>

        <div className="slide s-boost">
          <div className="slide-copy">
            <span className="s-eyebrow">Boost your token</span>
            <h2>Get featured across the {BRAND_NAME} network</h2>
            <p>Homepage spotlight, ticker priority, and reach on every {BRAND_NAME} tool.</p>
            <Link href="/advertise" className="boost-btn">Boost now →</Link>
          </div>
        </div>

        <div className="slide s-pump">
          <svg className="wm" viewBox="0 0 260 120" preserveAspectRatio="none">
            <path d="M0,108 L42,96 L84,102 L126,70 L168,54 L210,22 L260,6" fill="none" stroke="#02180B" strokeWidth="9" strokeLinecap="round" />
          </svg>
          <div className="slide-copy">
            <span className="s-eyebrow">Pumped on {BRAND_NAME}</span>
            <div className="pump-inline">
              <div className="coin" style={{ background: "rgba(255,255,255,.08)" }}>{promo.emoji}</div>
              <div className="pump-x">{promo.multiplier}</div>
              <span className="chip-since">↗ SINCE LISTING</span>
            </div>
            <div className="pump-meta">
              MCAP <b>{promo.mcap}</b> → ATH <b>{promo.ath}</b> · <b>{promo.symbol}</b> · {promo.chain}
            </div>
          </div>
        </div>
      </div>

      <div className="promo-dots">
        {[0, 1, 2].map((i) => (
          <button
            key={i}
            className={`pdot ${i === idx ? "active" : ""}`}
            aria-label={`Slide ${i + 1}`}
            onClick={() => go(i)}
          />
        ))}
      </div>
      <div className="promo-nav">
        <button className="pbtn" aria-label="Previous" onClick={() => go(idx - 1)}>‹</button>
        <button className="pbtn" aria-label="Next" onClick={() => go(idx + 1)}>›</button>
      </div>
    </div>
  );
}
