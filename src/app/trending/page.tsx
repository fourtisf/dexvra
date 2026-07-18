"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { StdBoard } from "@/components/TokenBoard";
import { Coin } from "@/components/Coin";
import { TierTag } from "@/components/TierTag";
import { fmtPrice } from "@/lib/format";
import type { PeriodKey } from "@/lib/types";

const FRAMES: PeriodKey[] = ["1h", "6h", "24h"];

export default function TrendingPage() {
  const { data, openDetail } = useApp();
  const [mode, setMode] = useState<"gain" | "lose">("gain");
  const [frame, setFrame] = useState<PeriodKey>("24h");

  const list = useMemo(
    () =>
      [...(data?.tokens ?? [])].sort((a, b) =>
        mode === "gain" ? b.chg[frame] - a.chg[frame] : a.chg[frame] - b.chg[frame],
      ),
    [data, mode, frame],
  );

  // Paid Trending slots — sorted by their booked rank (No.1 first).
  const featured = useMemo(
    () =>
      [...(data?.tokens ?? [])]
        .filter((t) => t.trendingRank != null)
        .sort((a, b) => (a.trendingRank ?? 99) - (b.trendingRank ?? 99)),
    [data],
  );

  return (
    <section className="view">
      {featured.length > 0 && (
        <div className="feat-trend">
          <div className="feat-head">🔥 Trending Now <span className="feat-sub">Paid featured slots</span></div>
          <div className="feat-rail">
            {featured.map((t) => {
              const up = t.chg["24h"] >= 0;
              return (
                <button className="feat-card" key={t.key} onClick={() => openDetail(t)}>
                  <span className="feat-rank">No.{t.trendingRank}</span>
                  <Coin token={t} size={38} fontSize={17} />
                  <div className="feat-id">
                    <div className="feat-sym">{t.symbol}</div>
                    <TierTag tier={t.tier} showRank={false} />
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
