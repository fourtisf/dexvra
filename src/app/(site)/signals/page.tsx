"use client";

import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { CHAINS } from "@/config/chains";
import { fmtAge } from "@/lib/format";
import { ChainLogo } from "@/components/ChainLogo";

const KIND_LABEL: Record<string, string> = {
  whale: "WHALE FLOW",
  lock: "LIQUIDITY",
  volume: "MOMENTUM",
  listing: "NEW LISTING",
  score: "TOP SCORE",
};

export default function SignalsPage() {
  const { data } = useApp();
  const signals = data?.signals ?? [];

  return (
    <section className="view">
      <PageHead
        icon="⚡"
        title="Signal Feed"
        sub="Algorithmic on-chain signals — whale flow, liquidity, momentum, fresh listings. No human votes."
      >
        <span className="live-pill">● LIVE</span>
      </PageHead>

      {!data ? (
        <div className="board-loading">
          <span className="dot-live" /> Reading the chain…
        </div>
      ) : signals.length === 0 ? (
        <div className="panel big-empty">
          <div className="em">📡</div>
          <p>No signals right now — check back in a moment.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 760 }}>
          {signals.map((s, i) => (
            <div key={i} className="signal-row">
              <span className="sig-dot" style={{ background: s.color, boxShadow: `0 0 10px ${s.color}` }} />
              <span className="sig-kind" style={{ color: s.color, borderColor: s.color }}>
                {KIND_LABEL[s.kind] ?? s.kind}
              </span>
              <span className="sig-chain">
                <ChainLogo chain={s.chain} size={16} />
              </span>
              <span className="sig-text">
                <b>{s.symbol}</b> <span dangerouslySetInnerHTML={{ __html: s.text }} />
              </span>
              <span className="sig-time">{fmtAge(s.minutesAgo)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="hint" style={{ maxWidth: 760 }}>
        Signals are derived from live on-chain data across {Object.keys(CHAINS).length} chains — momentum, liquidity, and buy pressure — not community votes.
      </p>
    </section>
  );
}
