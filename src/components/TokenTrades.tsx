"use client";

import { useEffect, useMemo, useState } from "react";
import type { BoardToken, Trade } from "@/lib/types";
import { CHAINS } from "@/config/chains";
import { fmtNum, fmtPrice } from "@/lib/format";

function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

// ⚠️ THERE IS NO DEMO DATA HERE ANY MORE, AND THERE MUST NEVER BE AGAIN.
//
// This file used to carry `demoTrades(t)`: twelve deterministic buys and sells
// with invented USD amounts, invented token amounts, a price jittered ±0.5%
// around the card's, and invented trader addresses ("0x" + random hex). It was
// drawn whenever the feed could not be read — and the only thing separating it
// from real trades was a 10px label reading "Recent" instead of "Live" beside a
// dot at 40% opacity. A visitor could not tell, and on a box being rate-limited
// by GeckoTerminal that was EVERY token page.
//
// This repo's whole doctrine is that an unreadable reading is a blank, never a
// fabricated number — a printed `0.00%` is refused on the trending board, and a
// hash-generated price curve was just deleted from this very page. Twelve made
// up transactions with trader addresses is the same lie with more rows.
//
// So: real trades, or a sentence saying which of the two reasons there are none.

const POLL_MS = 12_000;
const tradeKey = (tr: Trade) => `${tr.ts}:${tr.trader}:${tr.usd.toFixed(2)}`;

export function TokenTrades({ t }: { t: BoardToken }) {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [live, setLive] = useState(false);
  /** Why there are none — the panel's whole answer when the list is empty. */
  const [why, setWhy] = useState<string | null>(null);
  const network = CHAINS[t.chain]?.geckoNetwork ?? null;
  const canLive = Boolean(network && t.poolAddress);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setTrades(null);
    setLive(false);
    setWhy(null);

    if (!canLive) {
      // A token with no indexed pool has no trade feed. That is a fact about
      // the token, and saying it is the entire job here.
      setTrades([]);
      setWhy("No indexed pool for this token yet, so there are no trades to show.");
      return;
    }

    const url = `/api/trades?chain=${encodeURIComponent(t.chain)}&pool=${encodeURIComponent(
      t.poolAddress as string,
    )}`;

    const tick = async () => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        const j = (await r.json()) as { trades?: Trade[]; why?: string | null };
        if (stop) return;
        if (j.trades && j.trades.length) {
          setTrades(j.trades);
          setLive(true);
          setWhy(null);
        } else {
          // A poll that fails never blanks a panel that already has REAL
          // trades — the pool did not stop trading because one request did not
          // land. But it does stop claiming to be live.
          setLive(false);
          setTrades((prev) => (prev && prev.length ? prev : []));
          setWhy(j.why ?? "Couldn't read recent trades just now.");
        }
      } catch {
        if (stop) return;
        setLive(false);
        setTrades((prev) => (prev && prev.length ? prev : []));
        setWhy("Couldn't read recent trades just now.");
      } finally {
        if (!stop) timer = setTimeout(tick, POLL_MS);
      }
    };
    tick();

    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.chain, t.poolAddress]);

  const sym = useMemo(() => t.symbol.replace(/^\$/, ""), [t.symbol]);

  return (
    <div className="trades panel" style={{ padding: 0 }}>
      <div className="trades-head">
        Transactions
        {/* "Recent" used to be the only tell that the rows below were made up.
            With the fabricator gone the rows are always real, so the marker
            says whether the feed is CURRENT — and stops pulsing when it is
            not. A live dot over a stale panel is the reassuring reading. */}
        <span className={`trades-live ${live ? "on" : ""}`}>
          <span className="dot-live" /> {live ? "Live" : trades && trades.length ? "Stale" : "—"}
        </span>
      </div>
      {/* Real rows, but not current ones: the reader is looking at the last
          good read and is told so, rather than being left to trust a feed that
          silently stopped moving. */}
      {why && trades && trades.length > 0 && <div className="trades-stale">{why}</div>}
      <div className="trades-scroll">
        <div className="trades-row trades-hd">
          <div>Time</div>
          <div>Type</div>
          <div className="c-num">USD</div>
          <div className="c-num tr-amt">{sym}</div>
          <div className="c-num">Price</div>
          <div className="tr-trader">Trader</div>
        </div>
        {trades == null ? (
          <div className="board-loading"><span className="dot-live" /> Loading trades…</div>
        ) : trades.length === 0 ? (
          // The state that used to be filled with invented rows. It says which
          // of the two reasons it is — a token with no pool and a feed we could
          // not read need different reactions from the reader.
          <div className="trades-none">{why ?? "No trades to show."}</div>
        ) : (
          trades.map((tr) => (
            <div className={`trades-row ${tr.kind}`} key={tradeKey(tr)}>
              <div className="tr-time">{ago(tr.ts)} ago</div>
              <div className={`tr-type ${tr.kind}`}>{tr.kind === "buy" ? "▲ Buy" : "▼ Sell"}</div>
              <div className="c-num tr-usd">${fmtNum(tr.usd)}</div>
              <div className="c-num tr-amt">{fmtNum(tr.amount)}</div>
              <div className="c-num">{fmtPrice(tr.price)}</div>
              <div className="tr-trader">{short(tr.trader)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
