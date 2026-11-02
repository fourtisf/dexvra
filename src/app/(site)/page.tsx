"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { PulseStrip } from "@/components/PulseStrip";
import { HomeBannerStrip } from "@/components/HomeBannerStrip";
import { ChainFilter } from "@/components/ChainFilter";
import { MarketMovers } from "@/components/MarketMovers";
import { MarketStats } from "@/components/MarketStats";
import { Spotlight } from "@/components/Spotlight";
import { StdBoard, type SortKey } from "@/components/TokenBoard";
import { TopCoinsBoard } from "@/components/TopCoins";
import { useChainParam } from "@/components/useChainParam";
import { HOME_BOARD_ROWS, HOME_TRENDING_MAX, chainCounts, inChain, resolveChain, spotlight } from "@/lib/home";
import { chainOf } from "@/config/chains";
import type { PeriodKey } from "@/lib/types";

const PERIODS: PeriodKey[] = ["5m", "1h", "6h", "24h"];

/** The board's "Rank by" presets. Each is a SORT of the same table — never a
 *  link to another page — so the control does exactly one kind of thing, and
 *  its lit state is read from the board's own sort: a header tap that replaces
 *  the sort un-lights the preset instead of leaving it claiming a ranking the
 *  table no longer shows. */
const RANK_BY: { key: SortKey; label: string }[] = [
  { key: "chg", label: "Trending" },
  { key: "mcap", label: "Top" },
  { key: "vol", label: "Volume" },
  { key: "age", label: "New" },
];

/**
 * Mockup A, "Tabel Terminal" ("yang ini bagus"), with the spotlight the
 * operator asked for on top of it ("minimal 9 atau 10"):
 *
 *   market line     (below 1100px — the header carries it above that)
 *   chain row       (below 1100px — the rail carries it above that)
 *   Spotlight       ten trending listings: booked slots, then the ranking
 *   banner row      the paid placements, full width
 *   Trending        timeframe + Rank by over the dense terminal table
 *   Market Movers   what moved — gainers, losers, what just listed
 *   Pulse           per-chain heat · Fear & Greed · Signals
 *   Top Coins       what is actually big here
 *
 * ONE chain filter governs the whole market area, and it lives in the URL
 * (`?chain=`, see useChainParam): the rail's chain links and the phone's chain
 * row are the same control in two places, so they cannot disagree, and a
 * filtered board is a link somebody can share.
 */
export default function HomePage() {
  const { data, homeQuery } = useApp();
  const [period, setPeriod] = useState<PeriodKey>("24h");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "chg", dir: -1 });
  const [chain, setChain] = useChainParam();

  const tokens = data?.tokens ?? [];
  const counts = useMemo(() => chainCounts(tokens), [tokens]);
  // A chain the registry has never heard of falls back to All, or the board is
  // stuck at zero rows with nothing on screen to reset it.
  const active = resolveChain(chain, counts);

  const onChain = useMemo(() => tokens.filter(inChain(active)), [tokens, active]);
  const spot = useMemo(() => spotlight(onChain), [onChain]);

  const q = homeQuery.trim().toLowerCase();
  const list = useMemo(
    () => onChain.filter((t) => !q || (t.symbol + t.name + t.address).toLowerCase().includes(q)),
    [onChain, q],
  );

  return (
    <section className="view">
      <MarketStats className="home-stats" />
      <ChainFilter counts={counts} value={active} onChange={setChain} total={tokens.length} />

      {/* A search is a lookup, not a ranking — the spotlight steps aside for it
          like the movers do. */}
      {!q && <Spotlight tokens={spot} loading={!data} />}
      <HomeBannerStrip />

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
          {data && !data.live && <span className="src-pill demo">demo data</span>}
          {data?.live && <span className="src-pill live">live</span>}
        </div>

        <div className="board-tools">
          <div className="ttabs trend-frames" role="group" aria-label="Timeframe">
            {PERIODS.map((p) => (
              <button
                key={p}
                className={`ttab ${p === period ? "active" : ""}`}
                aria-pressed={p === period}
                onClick={() => setPeriod(p)}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="ttabs rank-by" role="group" aria-label="Rank by">
            {RANK_BY.map((r) => (
              <button
                key={r.key}
                className={`ttab ${sort.key === r.key ? "active" : ""}`}
                aria-pressed={sort.key === r.key}
                onClick={() => setSort({ key: r.key, dir: -1 })}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Opens on ten so the sections under it are reachable without a long
            scroll, and grows to fifteen in place. Anything past fifteen keeps
            its way through to the full board. */}
        <StdBoard
          tokens={list}
          period={period}
          sortable
          variant="terminal"
          sort={sort}
          onSortChange={setSort}
          onPeriod={setPeriod}
          loading={!data}
          emptyText={
            active !== "all" && onChain.length === 0
              ? `Nothing listed on ${chainOf(active)?.label ?? active} yet — be the first to list here.`
              : undefined
          }
          limit={HOME_BOARD_ROWS}
          expandTo={HOME_TRENDING_MAX}
          expandNoun="trending"
          viewAllHref="/trending"
        />
      </div>

      {!q && <MarketMovers tokens={onChain} updatedAt={data?.updatedAt} loading={!data} />}

      <PulseStrip />

      <div className="sec-block">
        <TopCoinsBoard tokens={list} period={period} loading={!data} />
      </div>
    </section>
  );
}
