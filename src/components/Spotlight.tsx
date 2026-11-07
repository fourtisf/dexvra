"use client";

import { changeReading, figureReading, SPOTLIGHT_SIZE, spotlightTier } from "@/lib/home";
import { fmtCap, fmtPrice } from "@/lib/format";
import { chainOf } from "@/config/chains";
import type { BoardToken } from "@/lib/types";
import { Coin } from "./Coin";
import { TierTag } from "./TierTag";
import { useApp } from "./AppState";

/**
 * The Trending Spotlight — ten cards over the terminal table
 * ("harus ada trending listing yang spotlight, masa cuma 3 — minimal 9 atau 10").
 *
 * WHAT fills it is decided in lib/home.ts `spotlight()`: the booked Trending
 * slots first, in package order, then the board's own 24h ranking for whatever
 * is left. This component only draws it.
 *
 * Each card names its PACKAGE (Diamond, Gold, Platinum… Xpress) where it used
 * to say "Featured" — `spotlightTier` decides when, and the chip is the board's
 * own TierTag, so a package looks the same here as on its row.
 *
 * Deliberately NO sparkline. A token's `trend` points are synthesised from its
 * ticker and its 24h change (lib/visual `syntheticTrend`); at 34px on a mover
 * row that is decoration, at card size it is a price history nobody measured —
 * the reason the token page's fabricated area chart was deleted. The bar at the
 * foot is a real reading: the share of the day's trades that were buys.
 */
export function Spotlight({ tokens, loading = false }: { tokens: BoardToken[]; loading?: boolean }) {
  const { openDetail } = useApp();
  if (!loading && tokens.length === 0) return null;

  return (
    <div className="spot">
      <div className="spot-head">
        <div className="sec-title">
          <div className="flame">
            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3s5 4.2 5 9.2a5 5 0 0 1-10 0c0-2.2 1.1-3.4 1.1-3.4s.2 2.8 2.2 2.8C10.3 7.4 12 3 12 3z" />
            </svg>
          </div>
          <h2>Trending Spotlight</h2>
        </div>
      </div>

      <div className="spot-grid" aria-busy={loading || undefined}>
        {loading
          ? Array.from({ length: SPOTLIGHT_SIZE }, (_, i) => (
              <div className="spot-card spot-sk" key={i} aria-hidden>
                <span className="sk sk-coin" />
                <span className="sk sk-line" style={{ width: "46%" }} />
                <span className="sk sk-line thin" style={{ width: "70%" }} />
              </div>
            ))
          : tokens.map((t, i) => <SpotCard key={t.key} t={t} i={i} onOpen={() => openDetail(t)} />)}
      </div>
    </div>
  );
}

function SpotCard({ t, i, onOpen }: { t: BoardToken; i: number; onOpen: () => void }) {
  const pkg = spotlightTier(t);
  const price = figureReading(t, t.priceUsd);
  const mcap = figureReading(t, t.mcap);
  const vol = figureReading(t, t.vol["24h"]);
  const chg = changeReading(t, "24h");
  const { buys, sells } = t.txns["24h"];
  const tx = figureReading(t, buys + sells);
  // The pressure bar is only drawn over trades somebody measured; with none,
  // an even 50/50 bar would be a reading of a market that did not trade.
  const buyShare = tx != null && tx > 0 ? (buys / tx) * 100 : null;

  return (
    <button type="button" className={`spot-card ${i < 3 ? `spot-top${i + 1}` : ""}`} onClick={onOpen}>
      <div className="spot-row1">
        <span className="spot-rank">#{i + 1}</span>
        {pkg && <TierTag tier={pkg} showRank={false} />}
      </div>
      <div className="spot-id">
        <Coin token={t} size={38} fontSize={15} />
        <div className="spot-idt">
          <div className="spot-sym">{t.symbol}</div>
          <div className="spot-nm">
            {t.name} · {chainOf(t.chain)?.label ?? t.chain}
          </div>
        </div>
      </div>
      <div className="spot-px">
        <b>{fmtPrice(price)}</b>
        {chg != null ? (
          <span className={`spot-chg ${chg >= 0 ? "up" : "dn"}`}>
            {chg >= 0 ? "+" : ""}
            {chg.toFixed(1)}%
          </span>
        ) : (
          <span className="spot-chg none" title="No 24h reading yet">—</span>
        )}
      </div>
      <div className="spot-meta">
        <span>
          MC <b>{fmtCap(mcap)}</b>
        </span>
        <span>
          Vol <b>{fmtCap(vol)}</b>
        </span>
      </div>
      <div className="spot-bs" title={buyShare == null ? "No trades measured in 24h" : `${Math.round(buyShare)}% of 24h trades were buys`}>
        {buyShare != null && <i style={{ width: `${buyShare}%` }} />}
      </div>
    </button>
  );
}
