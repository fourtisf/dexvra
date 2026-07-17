"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { StdBoard } from "@/components/TokenBoard";
import { BRAND_NAME } from "@/config/brand";

export default function AllCoinsPage() {
  const { data } = useApp();
  const [q, setQ] = useState("");

  const list = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (data?.tokens ?? [])
      .filter((t) => !query || (t.symbol + t.name).toLowerCase().includes(query))
      .sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0));
  }, [data, q]);

  return (
    <section className="view">
      <PageHead
        icon="🪙"
        title="All Coins"
        sub={data ? `${list.length} of ${data.tokens.length} tokens listed on ${BRAND_NAME}.` : "Loading…"}
      />
      <label className="search" style={{ maxWidth: 380 }}>
        <svg viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.8-3.8" />
        </svg>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or ticker…" />
      </label>
      <StdBoard tokens={list} loading={!data} />
    </section>
  );
}
