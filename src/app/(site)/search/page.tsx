"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { StdBoard } from "@/components/TokenBoard";

export default function SearchPage() {
  const { data } = useApp();
  const [q, setQ] = useState("");

  const suggestions = useMemo(
    () => [...(data?.tokens ?? [])].sort((a, b) => b.vol["24h"] - a.vol["24h"]).slice(0, 6),
    [data],
  );

  const query = q.trim().toLowerCase();
  const results = useMemo(
    () =>
      query
        ? (data?.tokens ?? []).filter((t) =>
            (t.symbol + t.name + t.address).toLowerCase().includes(query),
          )
        : [],
    [data, query],
  );

  return (
    <section className="view">
      <PageHead icon="🔎" title="Search" sub="Find any token by name, ticker, or contract address." />
      <label className="search" style={{ maxWidth: 560 }}>
        <svg viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.8-3.8" />
        </svg>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Try $TRENCHCAT, robin, or paste a CA…"
        />
      </label>
      <div className="tagrow">
        {suggestions.map((t) => (
          <button key={t.key} className="qtag" onClick={() => setQ(t.symbol)}>
            {t.emoji} {t.symbol}
          </button>
        ))}
      </div>
      {query && (
        <StdBoard tokens={results} loading={!data} emptyText="No tokens match that search." />
      )}
    </section>
  );
}
