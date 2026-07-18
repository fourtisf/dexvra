"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { PromoCarousel } from "@/components/PromoCarousel";
import { PulseStrip } from "@/components/PulseStrip";
import { StdBoard } from "@/components/TokenBoard";
import { ChainLogo } from "@/components/ChainLogo";
import { CHAINS, CHAIN_IDS } from "@/config/chains";
import type { PeriodKey } from "@/lib/types";

const PERIODS: PeriodKey[] = ["5m", "1h", "6h", "24h"];

export default function HomePage() {
  const { data, homeQuery } = useApp();
  const [period, setPeriod] = useState<PeriodKey>("24h");
  const [chain, setChain] = useState("all");

  const list = useMemo(() => {
    const q = homeQuery.trim().toLowerCase();
    return (data?.tokens ?? [])
      .filter((t) => chain === "all" || t.chain === chain)
      .filter((t) => !q || (t.symbol + t.name + t.address).toLowerCase().includes(q));
  }, [data, chain, homeQuery]);

  return (
    <section className="view">
      <PromoCarousel />
      <PulseStrip />

      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <div className="sec-head">
          <div className="sec-title">
            <div className="flame">🔥</div>
            <h2>Trending Listings</h2>
          </div>
          <div className="ttabs">
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

        <div className="tabs">
          <button className={`tab ${chain === "all" ? "active" : ""}`} onClick={() => setChain("all")}>
            🌐 All chains
          </button>
          {CHAIN_IDS.map((id) => (
            <button
              key={id}
              className={`tab ${chain === id ? "active" : ""}`}
              onClick={() => setChain(id)}
            >
              <ChainLogo chain={id} size={15} />
              {CHAINS[id].label}
            </button>
          ))}
        </div>

        <StdBoard tokens={list} period={period} sortable loading={!data} />
      </div>
    </section>
  );
}
