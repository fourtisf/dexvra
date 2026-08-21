"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { PromoCarousel } from "@/components/PromoCarousel";
import { PulseStrip } from "@/components/PulseStrip";
import { HomeBannerStrip } from "@/components/HomeBannerStrip";
import { ChainFilter } from "@/components/ChainFilter";
import { MarketMovers } from "@/components/MarketMovers";
import { StdBoard } from "@/components/TokenBoard";
import { TopCoinsBoard } from "@/components/TopCoins";
import { HOME_BOARD_ROWS, HOME_TRENDING_MAX, chainCounts, inChain, resolveChain } from "@/lib/home";
import type { PeriodKey } from "@/lib/types";

const PERIODS: PeriodKey[] = ["5m", "1h", "6h", "24h"];

/**
 * The market area reads top-down as three different questions:
 *
 *   Trending        what is being pushed right now — the paid inventory, and
 *                   the reason this site exists, so it leads
 *   Market Movers   what moved — gainers, losers, what just listed
 *   Top Coins       what is actually big here
 *
 * ONE chain filter governs all three. Repeating a chain row per section is
 * three controls that can disagree with each other, on a page whose first
 * problem was already too much chrome above the first token.
 */
export default function HomePage() {
  const { data, homeQuery } = useApp();
  const [period, setPeriod] = useState<PeriodKey>("24h");
  const [chain, setChain] = useState("all");

  const tokens = data?.tokens ?? [];
  const counts = useMemo(() => chainCounts(tokens), [tokens]);
  // A chain that drops out of a later poll falls back to All, or the picker
  // unmounts and the board is stuck at zero rows with nothing left to tap.
  const active = resolveChain(chain, counts);

  const onChain = useMemo(() => tokens.filter(inChain(active)), [tokens, active]);

  const q = homeQuery.trim().toLowerCase();
  const list = useMemo(
    () => onChain.filter((t) => !q || (t.symbol + t.name + t.address).toLowerCase().includes(q)),
    [onChain, q],
  );

  return (
    <section className="view">
      <PromoCarousel />
      <PulseStrip />
      <HomeBannerStrip />

      <ChainFilter counts={counts} value={active} onChange={setChain} total={tokens.length} />

      <div className="sec-block">
        <div className="sec-head">
          <div className="sec-title">
            <div className="flame">
              <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M23 6l-9.5 9.5-5-5L1 18" />
                <path d="M17 6h6v6" />
              </svg>
            </div>
            <h2>Trending Listings</h2>
          </div>
          <div className="ttabs trend-frames">
            {PERIODS.map((p) => (
              <button
                key={p}
                className={`ttab ${p === period ? "active" : ""}`}
                onClick={() => setPeriod(p)}
              >
                {p}
              </button>
            ))}
          </div>
          {data && !data.live && <span className="src-pill demo">demo data</span>}
          {data?.live && <span className="src-pill live">live</span>}
          <button className="filter-btn">
            <svg viewBox="0 0 24 24">
              <path d="M4 6h16M7 12h10M10 18h4" />
            </svg>
            Filter
          </button>
        </div>

        {/* Opens on ten so the two sections under it are reachable without a
            long scroll, and grows to fifteen in place. Anything past fifteen
            keeps its way through to the full board. */}
        <StdBoard
          tokens={list}
          period={period}
          sortable
          loading={!data}
          limit={HOME_BOARD_ROWS}
          expandTo={HOME_TRENDING_MAX}
          expandNoun="trending"
          viewAllHref="/trending"
        />
      </div>

      {/* A search is a lookup, not a ranking. "Top Gainers matching PLUM" is
          not a top-gainers list, and leaving it market-wide would put two
          different datasets on one screen under one query. */}
      {!q && <MarketMovers tokens={onChain} updatedAt={data?.updatedAt} />}

      <div className="sec-block">
        <TopCoinsBoard tokens={list} period={period} />
      </div>
    </section>
  );
}
