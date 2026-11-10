"use client";

import { useMemo } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { StdBoard } from "@/components/TokenBoard";
import { ChainFilter } from "@/components/ChainFilter";
import { useChainParam } from "@/components/useChainParam";
import { chainCounts, resolveChain } from "@/lib/home";

export default function LeaderboardPage() {
  const { data } = useApp();
  // The one chain filter (useChainParam). This page used to draw every chain
  // in the registry as its own chip — twenty-three, wrapped into three rows
  // over the table — in a second design of the row the home already had.
  const [chainParam, setChain] = useChainParam();
  const counts = useMemo(() => chainCounts(data?.tokens ?? []), [data]);
  const chain = resolveChain(chainParam, counts);

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
      <ChainFilter counts={counts} value={chain} onChange={setChain} total={data?.tokens.length ?? 0} />
      <StdBoard tokens={list} loading={!data} emptyText="No listings on this chain yet." />
    </section>
  );
}
