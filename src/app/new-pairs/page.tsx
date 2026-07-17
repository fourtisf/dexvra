"use client";

import { useMemo } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { NpBoard } from "@/components/TokenBoard";

export default function NewPairsPage() {
  const { data } = useApp();

  const list = useMemo(
    () =>
      [...(data?.tokens ?? [])]
        .filter((t) => t.ageMinutes != null)
        .sort((a, b) => a.ageMinutes! - b.ageMinutes!),
    [data],
  );

  return (
    <section className="view">
      <PageHead icon="🛰️" title="New Pairs" sub="Freshest launches first — straight from the trenches.">
        <span className="live-pill">● LIVE</span>
      </PageHead>
      <NpBoard tokens={list} loading={!data} />
    </section>
  );
}
