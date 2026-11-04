"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { StdBoard } from "@/components/TokenBoard";
import type { CSSProperties } from "react";
import { Coin } from "@/components/Coin";
import { TierTag } from "@/components/TierTag";
import { ChainFilter } from "@/components/ChainFilter";
import { useChainParam } from "@/components/useChainParam";
import { byChange, chainCounts, changeReading, featuredSlots, figureReading, resolveChain } from "@/lib/home";
import { fmtPrice } from "@/lib/format";
import { publicTier, tierColor } from "@/lib/packages";
import type { PeriodKey } from "@/lib/types";

const FRAMES: PeriodKey[] = ["1h", "6h", "24h"];

export default function TrendingPage() {
  const { data, openDetail } = useApp();
  const [mode, setMode] = useState<"gain" | "lose">("gain");
  const [frame, setFrame] = useState<PeriodKey>("24h");
  // The one chain filter, in the URL — the rail's chain links land here too.
  const [chainParam, setChain] = useChainParam();
  const counts = useMemo(() => chainCounts(data?.tokens ?? []), [data]);
  // A registered chain with no listings stays a legal (honestly empty)
  // selection; only an id the registry has never heard of falls back to All.
  const chain = resolveChain(chainParam, counts);
  const inChain = useMemo(() => (c: string) => chain === "all" || c === chain, [chain]);

  // ⚠️ THROUGH `byChange`, NOT THE RAW FIELD. This sort used to read
  // `b.chg[frame] - a.chg[frame]` — so the one page whose whole heading is
  // "Top Gainers" went through NEITHER gate the rest of the site uses: a
  // five-million-percent figure off a near-dead pool could lead it, and
  // `$MRNA +465%` on five cents of 24h volume took its 🥇 medal. One owner
  // now, shared with the home board's comparator, and an unrankable row sinks
  // on the LOSERS tab too rather than being crowned by it.
  const list = useMemo(
    () => byChange((data?.tokens ?? []).filter((t) => inChain(t.chain)), frame, mode === "gain" ? -1 : 1),
    [data, mode, frame, inChain],
  );

  // Paid Trending slots — ordered by the package booked: Diamond first, then
  // Gold, Platinum, Silver, Bronze, Xpress. No numbering; order shows priority.
  // `featuredSlots` is the ONE comparator — the home spotlight reads it too.
  const featured = useMemo(
    () => featuredSlots((data?.tokens ?? []).filter((t) => inChain(t.chain))),
    [data, inChain],
  );

  return (
    <section className="view">
      <ChainFilter counts={counts} value={chain} onChange={setChain} total={data?.tokens.length ?? 0} />
      {featured.length > 0 && (
        <div className="feat-trend">
          {/* no emoji glyph — the head joins the microlabel voice, like every
              section marker since the rebuild */}
          <div className="feat-head">Trending Now <span className="feat-sub">Paid featured slots</span></div>
          <div className="feat-rail">
            {featured.map((t) => {
              // Through the readers every board cell uses: the raw fields
              // printed "$0" and "+0.0%" for a token nobody had priced — a
              // measured-looking zero over a market nobody measured.
              const chg = changeReading(t, "24h");
              const up = chg != null && chg >= 0;
              return (
                <button
                  className="feat-card"
                  key={t.key}
                  onClick={() => openDetail(t)}
                  style={{ "--tc": tierColor(publicTier(t.tier)) } as CSSProperties}
                >
                  <Coin token={t} size={38} fontSize={17} />
                  <div className="feat-id">
                    <div className="feat-sym">{t.symbol}</div>
                    <TierTag tier={t.tier} showRank={false} />
                  </div>
                  <div className="feat-px">
                    <div>{fmtPrice(figureReading(t, t.priceUsd))}</div>
                    {chg != null ? (
                      <div className={up ? "feat-up" : "feat-dn"}>{up ? "+" : ""}{chg.toFixed(1)}%</div>
                    ) : (
                      <div className="feat-none" title="No 24h reading yet">—</div>
                    )}
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
