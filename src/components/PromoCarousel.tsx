"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { BRAND_MARK, BRAND_NAME } from "@/config/brand";
import { CHAIN_IDS } from "@/config/chains";
import { useApp } from "./AppState";

const N = 3;
const AUTO_MS = 5000;

// Slides 2 & 3 are ad inventory (Carousel Takeover) — kept as house ads
// until real bookings exist (Phase 3).
export function PromoCarousel() {
  const { openListing, reducedMotion } = useApp();
  const [idx, setIdx] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

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
        <div className="slide s-moon">
          <div className="mini-orbits" aria-hidden="true">
            <div className="orbit oa">
              <div className="sat top"><div className="fcoin c-gold sz36">⚔️</div></div>
              <div className="sat bot"><div className="fcoin c-cyanc sz30">💎</div></div>
            </div>
            <div className="orbit ob">
              <div className="sat top"><div className="fcoin c-green sz30">🐸</div></div>
              <div className="sat bot"><div className="fcoin c-viol sz30">🌕</div></div>
            </div>
            <div className="fcoin fcoin-main">{BRAND_MARK}</div>
          </div>
          <span className="blip-tag">$WARCHEST +412×</span>
          <span className="sparkle" style={{ right: "38%", top: "20%" }}>✦</span>
          <span className="sparkle" style={{ right: "12%", bottom: "18%", animationDelay: "1.1s" }}>✦</span>
          <div className="slide-copy">
            <span className="s-eyebrow"><span className="dot-live" />Live · Tracking {CHAIN_IDS.length} chains</span>
            <h2>
              Find the next <span className="grad">Moonshot</span> first.
            </h2>
            <p>Fresh launches, whale flow, and bundle forensics — the signal hits {BRAND_NAME} before the crowd.</p>
            <button className="btn-slide" onClick={openListing}>⚡ Express Listing</button>
          </div>
        </div>

        <div className="slide s-boost">
          <span className="wm">🚀</span>
          <div className="slide-copy">
            <span className="s-eyebrow">📢 Boost your token</span>
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
            <span className="s-eyebrow">◆ Pumped on {BRAND_NAME}</span>
            <div className="pump-inline">
              <div className="coin" style={{ background: "radial-gradient(circle at 32% 26%,#FFE9A8,#FFC53D 45%,#B57900)" }}>⚔️</div>
              <div className="pump-x">412×</div>
              <span className="chip-since">↗ SINCE LISTING</span>
            </div>
            <div className="pump-meta">
              MCAP <b>$310K</b> → ATH <b>$128.4M</b> · <b>$WARCHEST</b> · Solana
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
