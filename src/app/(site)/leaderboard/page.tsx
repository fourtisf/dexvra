"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { StdBoard } from "@/components/TokenBoard";
import { CHAINS, CHAIN_IDS } from "@/config/chains";
import { ChainLogo } from "@/components/ChainLogo";

export default function LeaderboardPage() {
  const { data } = useApp();
  const [chain, setChain] = useState("all");

  const list = useMemo(
    () =>
      (data?.tokens ?? [])
        .filter((t) => chain === "all" || t.chain === chain)
        .sort((a, b) => b.score - a.score),
    [data, chain],
  );

  return (
    <section className="view">
      <PageHead
        icon="🏆"
        title="Leaderboard"
        sub="Ranked by Dexvra Score — pure on-chain signal, never paid votes."
      />
      <div className="tabs">
        <button className={`tab ${chain === "all" ? "active" : ""}`} onClick={() => setChain("all")}>
          🌐 All chains
        </button>
        {CHAIN_IDS.map((id) => (
          <button key={id} className={`tab ${chain === id ? "active" : ""}`} onClick={() => setChain(id)}>
            <ChainLogo chain={id} size={15} />
            {CHAINS[id].label}
          </button>
        ))}
      </div>
      <StdBoard tokens={list} loading={!data} emptyText="No listings on this chain yet." />
    </section>
  );
}
