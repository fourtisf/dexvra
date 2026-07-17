"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { StdBoard } from "@/components/TokenBoard";

export default function TrendingPage() {
  const { data } = useApp();
  const [mode, setMode] = useState<"gain" | "lose">("gain");

  const list = useMemo(
    () =>
      [...(data?.tokens ?? [])].sort((a, b) =>
        mode === "gain" ? b.chg["24h"] - a.chg["24h"] : a.chg["24h"] - b.chg["24h"],
      ),
    [data, mode],
  );

  return (
    <section className="view">
      <PageHead icon="🔥" title="Trending" sub="Ranked by 24h performance across every chain we track.">
        <div className="ttabs">
          <button className={`ttab ${mode === "gain" ? "active" : ""}`} onClick={() => setMode("gain")}>
            Top Gainers
          </button>
          <button className={`ttab ${mode === "lose" ? "active" : ""}`} onClick={() => setMode("lose")}>
            Top Losers
          </button>
        </div>
      </PageHead>
      <StdBoard tokens={list} loading={!data} />
    </section>
  );
}
