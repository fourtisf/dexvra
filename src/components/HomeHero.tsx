"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BOT_URL, BRAND_NAME } from "@/config/brand";
import { CHAIN_IDS } from "@/config/chains";
import { fmtCap } from "@/lib/format";
import { useApp } from "./AppState";

// Client-safe fallback (mirrors PROMO_DEFAULTS in lib/promo.ts) — used until
// /api/promo loads, and if it's unreachable.
type Promo = { emoji: string; symbol: string; multiplier: string; mcap: string; ath: string; chain: string };
const PROMO_FALLBACK: Promo = {
  emoji: "⚔️", symbol: "$WARCHEST", multiplier: "412×", mcap: "$310K", ath: "$128.4M", chain: "Solana",
};

/**
 * The command deck — the hero as ONE composed surface, replacing the rotating
 * carousel ("mksud saya design front end ui ux nya juga rubah").
 *
 * A carousel is three messages taking turns; whichever one a visitor needed
 * was off-screen two-thirds of the time, and the page's opening move was
 * chrome animating itself. This puts everything on screen at once and NOTHING
 * MOVES ON ITS OWN: the pitch and the two actions on the left, the editable
 * "Pumped on Dexvra" showcase (the old slide 3, still fed by /api/promo) as a
 * framed exhibit on the right — with the ad slot folded into its footer — and
 * the market's vital signs in one strip beneath both.
 */
export function HomeHero() {
  const { data, fng } = useApp();

  // Editable showcase (admin panel → /api/promo), same contract the carousel had.
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

  // "…" until the first payload — a 0-listing, $0-volume deck about a market
  // nobody has read yet is the false-empty-state this repo forbids.
  const stats: { k: string; v: string | number }[] = [
    { k: "Listings", v: data ? data.tokens.length : "…" },
    { k: "Chains", v: CHAIN_IDS.length },
    { k: "24h volume", v: data ? fmtCap(data.trackedVol24h) : "…" },
    { k: "Fear & Greed", v: fng?.value ?? "…" },
  ];

  return (
    <section className="hero">
      <div className="hero-main">
        <div className="hero-copy">
          <span className="s-eyebrow">
            <span className="dot-live" />
            Live · {CHAIN_IDS.length} chains
          </span>
          <h1>
            Find the next <em className="hero-serif">moonshot</em> first.
          </h1>
          <p>
            Fresh launches, whale flow and on-chain signal — on {BRAND_NAME} before the crowd.
          </p>
          <div className="hero-cta">
            <a className="btn-primary hero-list" href={BOT_URL} target="_blank" rel="noopener noreferrer">
              ⚡ Express Listing
            </a>
            <Link className="hero-adv" href="/advertise">
              Advertise on {BRAND_NAME} →
            </Link>
          </div>
        </div>

        <aside className="hero-spot" aria-label={`Pumped on ${BRAND_NAME}`}>
          <svg className="hero-mark spot-mark" viewBox="0 0 220 160" aria-hidden="true">
            <path className="dim" d="M60 30 H160 L196 66 L110 146 L24 66 Z" />
            <path d="M24 66 H196 M60 30 L88 66 M160 30 L132 66 M88 66 H132 M88 66 L110 146 M132 66 L110 146" />
          </svg>
          <div className="spot-eyebrow">Pumped on {BRAND_NAME}</div>
          <div className="spot-row">
            <div className="coin spot-coin">{promo.emoji}</div>
            <div className="spot-x">{promo.multiplier}</div>
          </div>
          <div className="spot-meta">
            MCAP <b>{promo.mcap}</b> → ATH <b>{promo.ath}</b>
          </div>
          <div className="spot-id">
            <b>{promo.symbol}</b> · {promo.chain} · since listing
          </div>
          <Link className="spot-slot" href="/advertise">
            Your token here →
          </Link>
        </aside>
      </div>

      <dl className="hero-stats">
        {stats.map((s) => (
          <div className="hstat" key={s.k}>
            <dt>{s.k}</dt>
            <dd>{s.v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
