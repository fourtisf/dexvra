"use client";

import { useMemo } from "react";
import { fmtCap, fmtNum } from "@/lib/format";
import { marketTotals } from "@/lib/home";
import { useApp } from "./AppState";

/**
 * The market line: 24h volume · 24h txns · listed tokens · Fear & Greed.
 *
 * Rendered twice by design — in the header on desktop and as a row at the top
 * of the home page below 1100px, where the header has no room — and it is pure
 * display (no effect, no fetch), so two instances cost two renders and can
 * never disagree: both read the same payload through the same rule.
 *
 * Nothing here prints a number nobody measured: an unread total is a dash, and
 * a gauge that has not answered yet is a dash, not a "0 · Extreme Fear".
 */
export function MarketStats({ className = "" }: { className?: string }) {
  const { data, fng } = useApp();
  const totals = useMemo(() => marketTotals(data?.tokens ?? []), [data]);
  const fgTone = fng == null ? "" : fng.value >= 55 ? "up" : fng.value <= 45 ? "dn" : "";
  return (
    <div className={`mstats ${className}`} aria-label="Market overview">
      <div className="mstat">
        <small>24H Volume</small>
        <b>{data ? fmtCap(data.trackedVol24h) : "—"}</b>
      </div>
      <div className="mstat">
        <small>24H Txns</small>
        <b>{totals.txns24h == null ? "—" : fmtNum(totals.txns24h)}</b>
      </div>
      <div className="mstat">
        <small>Listed Tokens</small>
        <b>{data ? fmtNum(totals.listed) : "—"}</b>
      </div>
      <div className="mstat">
        <small>Fear &amp; Greed</small>
        <b className={fgTone}>{fng ? `${fng.value} · ${fng.label}` : "—"}</b>
      </div>
    </div>
  );
}
