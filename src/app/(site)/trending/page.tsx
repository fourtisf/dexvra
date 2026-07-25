"use client";

import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { StdBoard } from "@/components/TokenBoard";
import type { CSSProperties } from "react";
import { Coin } from "@/components/Coin";
import { TierTag } from "@/components/TierTag";
import { ChainLogo } from "@/components/ChainLogo";
import { fmtPrice } from "@/lib/format";
import { tierColor, tierRank } from "@/lib/packages";
import { chainOf } from "@/config/chains";
import type { PeriodKey } from "@/lib/types";

// Sort priority for the Trending rail: higher-tier package first (Diamond #1 →
// Bronze #5). Xpress (rank 0) sits after the ranked tiers.
const trendPriority = (tier: string): number => {
  const r = tierRank(tier);
  return r === 0 ? 90 : r;
};

const FRAMES: PeriodKey[] = ["1h", "6h", "24h"];

export default function TrendingPage() {
  const { data, openDetail } = useApp();
  const [mode, setMode] = useState<"gain" | "lose">("gain");
  const [frame, setFrame] = useState<PeriodKey>("24h");
  const [chain, setChain] = useState<string>("all");

  // Chains actually present in the data, most-populated first — so the picker
  // only offers chains that have tokens (no dead filters).
  const chains = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of data?.tokens ?? []) counts.set(t.chain, (counts.get(t.chain) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [data]);
  const inChain = useMemo(() => (c: string) => chain === "all" || c === chain, [chain]);
  // If the selected chain disappears from the data (delisted / dropped from a
  // later poll), fall back to "all" — otherwise the picker unmounts and the
  // board would be stuck filtering to zero rows with no way to reset.
  useEffect(() => {
    if (chain !== "all" && !chains.includes(chain)) setChain("all");
  }, [chain, chains]);

  const list = useMemo(
    () =>
      [...(data?.tokens ?? [])]
        .filter((t) => inChain(t.chain))
        .sort((a, b) => (mode === "gain" ? b.chg[frame] - a.chg[frame] : a.chg[frame] - b.chg[frame])),
    [data, mode, frame, inChain],
  );

  // Paid Trending slots — ordered by the package booked: Diamond first, then
  // Gold, Platinum, Silver, Bronze, Xpress. No numbering; order shows priority.
  const featured = useMemo(
    () =>
      [...(data?.tokens ?? [])]
        .filter((t) => t.trendingRank != null && inChain(t.chain))
        .sort(
          (a, b) =>
            trendPriority(a.tier) - trendPriority(b.tier) ||
            (a.trendingRank ?? 99) - (b.trendingRank ?? 99),
        ),
    [data, inChain],
  );

  return (
    <section className="view">
      {chains.length > 1 && (
        <div className="chain-pick" role="group" aria-label="Filter by chain">
          <button
            className={`chain-chip ${chain === "all" ? "active" : ""}`}
            onClick={() => setChain("all")}
            aria-pressed={chain === "all"}
          >
            🌐 All chains
          </button>
          {chains.map((id) => (
            <button
              key={id}
              className={`chain-chip ${chain === id ? "active" : ""}`}
              onClick={() => setChain(id)}
              aria-pressed={chain === id}
            >
              <ChainLogo chain={id} size={15} />
              {chainOf(id)?.label ?? id}
            </button>
          ))}
        </div>
      )}
      {featured.length > 0 && (
        <div className="feat-trend">
          <div className="feat-head">🔥 Trending Now <span className="feat-sub">Paid featured slots</span></div>
          <div className="feat-rail">
            {featured.map((t) => {
              const up = t.chg["24h"] >= 0;
              return (
                <button
                  className="feat-card"
                  key={t.key}
                  onClick={() => openDetail(t)}
                  style={{ "--tc": tierColor(t.tier) } as CSSProperties}
                >
                  <Coin token={t} size={38} fontSize={17} />
                  <div className="feat-id">
                    <div className="feat-sym">{t.symbol}</div>
                    <TierTag tier={t.tier} showRank={false} ageMinutes={t.listedMinutesAgo} />
                  </div>
                  <div className="feat-px">
                    <div>{fmtPrice(t.priceUsd)}</div>
                    <div className={up ? "feat-up" : "feat-dn"}>{up ? "+" : ""}{t.chg["24h"].toFixed(1)}%</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <PageHead
        icon="🔥"
        title="Gainers & Losers"
        sub="Biggest movers among paid listings — pick your timeframe."
      >
        <div className="ttabs">
          <button className={`ttab ${mode === "gain" ? "active" : ""}`} onClick={() => setMode("gain")}>
            Top Gainers
          </button>
          <button className={`ttab ${mode === "lose" ? "active" : ""}`} onClick={() => setMode("lose")}>
            Top Losers
          </button>
        </div>
        <div className="ttabs">
          {FRAMES.map((f) => (
            <button key={f} className={`ttab ${frame === f ? "active" : ""}`} onClick={() => setFrame(f)}>
              {f}
            </button>
          ))}
        </div>
      </PageHead>
      <StdBoard tokens={list} period={frame} loading={!data} />
    </section>
  );
}
