"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { BoardToken, PeriodKey } from "@/lib/types";
import { fmtAge, fmtCap } from "@/lib/format";
import { freshness, movers, type MoverKind } from "@/lib/home";
import { useApp } from "./AppState";
import { Coin } from "./Coin";
import { Spark } from "./Spark";

const FRAMES: PeriodKey[] = ["1h", "6h", "24h"];

interface Deck {
  kind: MoverKind;
  title: string;
  accent: string;
  href: string;
  icon: JSX.Element;
  /** What an EMPTY card says. "No data" would be a lie — the board is full,
   *  nothing on it is moving that way on this timeframe, and that is itself
   *  the reading somebody came for. */
  empty: string;
}

const ic = (d: string) => (
  <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d.split("|").map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);

const DECKS: Deck[] = [
  {
    kind: "gainers",
    title: "Top Gainers",
    accent: "mint",
    href: "/trending",
    icon: ic("M3 17l6-6 4 4 8-8|M15 7h6v6"),
    empty: "Nothing is up on this timeframe.",
  },
  {
    kind: "losers",
    title: "Top Losers",
    accent: "red",
    href: "/trending",
    icon: ic("M3 7l6 6 4-4 8 8|M15 17h6v-6"),
    empty: "Nothing is down on this timeframe.",
  },
  {
    kind: "fresh",
    title: "New Listings",
    accent: "cyan",
    href: "/new-listings",
    icon: ic("M12 3v3M12 18v3M3 12h3M18 12h3|M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"),
    empty: "No listings yet.",
  },
];

function MoverRow({ t, i, frame, kind }: { t: BoardToken; i: number; frame: PeriodKey; kind: MoverKind }) {
  const { openDetail } = useApp();
  const chg = t.chg[frame];
  const up = chg >= 0;
  return (
    <button className="mv-row" onClick={() => openDetail(t)} title={`${t.symbol} — ${t.name}`}>
      <span className="mv-rank">{i + 1}</span>
      <Coin token={t} size={28} fontSize={13} />
      <span className="mv-id">
        <span className="mv-sym">{t.symbol}</span>
        <span className="mv-nm">{t.name}</span>
      </span>
      {kind === "fresh" ? (
        <span className="mv-age">⏱ {fmtAge(t.listedMinutesAgo)}</span>
      ) : (
        <Spark points={t.trend} up={up} />
      )}
      <span className={`mv-pct ${up ? "up" : "dn"}`}>
        {up ? "▲" : "▼"} {Math.abs(chg).toFixed(1)}%
      </span>
    </button>
  );
}

/**
 * Top Gainers · Top Losers · New Listings — the three questions somebody opens
 * a listing site with, answered above the fold.
 *
 * The cards SCROLL INSIDE THEMSELVES: ten rows each behind a short card, so the
 * three fit on one screen and the page below them is still reachable. A card
 * that grows to its content pushes the trending board off the fold, and the
 * board is the inventory this site sells.
 */
export function MarketMovers({ tokens, updatedAt }: { tokens: BoardToken[]; updatedAt?: number }) {
  const [frame, setFrame] = useState<PeriodKey>("24h");
  const lists = useMemo(
    () => DECKS.map((d) => ({ deck: d, rows: movers(tokens, d.kind, frame) })),
    [tokens, frame],
  );
  const vol = useMemo(() => tokens.reduce((s, t) => s + t.vol[frame], 0), [tokens, frame]);

  return (
    <div className="movers">
      <div className="sec-head">
        <div className="sec-title">
          <div className="sec-ic mv-ic">
            {ic("M22 12h-4l-3 9L9 3l-3 9H2")}
          </div>
          <h2>Market Movers</h2>
        </div>
        <span className="live-pill">● LIVE</span>
        <span className="mv-stamp">
          {freshness(updatedAt)} · <b>{fmtCap(vol)}</b> traded
        </span>
        <div className="ttabs mv-frames">
          {FRAMES.map((f) => (
            <button key={f} className={`ttab ${f === frame ? "active" : ""}`} onClick={() => setFrame(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="mv-grid">
        {lists.map(({ deck, rows }) => (
          <section className={`mv-card acc-${deck.accent}`} key={deck.kind}>
            <header className="mv-head">
              <span className="mv-badge">{deck.icon}</span>
              <h3>{deck.title}</h3>
              <Link className="mv-all" href={deck.href}>
                View all
                <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 12h13M13 6l6 6-6 6" />
                </svg>
              </Link>
            </header>
            <div className="mv-list">
              {rows.length === 0 ? (
                <p className="mv-empty">{deck.empty}</p>
              ) : (
                rows.map((t, i) => (
                  <MoverRow key={t.key} t={t} i={i} frame={frame} kind={deck.kind} />
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
