"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { StdBoard } from "@/components/TokenBoard";

export default function WatchlistPage() {
  const { data, watchlist } = useApp();

  const list = useMemo(
    () =>
      (data?.tokens ?? [])
        .filter((t) => watchlist.has(t.key))
        .sort((a, b) => b.chg["24h"] - a.chg["24h"]),
    [data, watchlist],
  );

  return (
    <section className="view">
      <PageHead icon="⭐" title="Watchlist" sub="Your starred tokens, live. Tap ★ anywhere to add more." />
      {data && list.length === 0 ? (
        <div className="panel big-empty">
          <div className="em">⭐</div>
          <p>Nothing here yet. Star any token from the board and it lands in your watchlist.</p>
          <Link href="/" className="btn-primary">
            Browse trending →
          </Link>
        </div>
      ) : (
        <StdBoard tokens={list} loading={!data} />
      )}
    </section>
  );
}
