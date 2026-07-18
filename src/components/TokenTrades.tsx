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

// Deterministic demo trades from the token, so the panel is never empty in
// demo/offline; replaced by live GeckoTerminal trades when available.
function demoTrades(t: BoardToken): Trade[] {
  const now = Math.floor(Date.now() / 1000);
  const out: Trade[] = [];
  let seed = 0;
  for (const ch of t.symbol) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const buyShare = t.txns["24h"].buys / Math.max(1, t.txns["24h"].buys + t.txns["24h"].sells);
  for (let i = 0; i < 12; i++) {
    const buy = rnd() < buyShare;
    const usd = 5 + rnd() * 900;
    const price = t.priceUsd * (1 + (rnd() - 0.5) * 0.01);
    out.push({
      ts: now - Math.floor(i * (18 + rnd() * 60)),
      kind: buy ? "buy" : "sell",
      usd,
      amount: usd / (price || 1),
      price,
      trader: "0x" + Math.floor(rnd() * 0xffffff).toString(16).padStart(6, "0"),
    });
  }
  return out;
}

const POLL_MS = 12_000;
const tradeKey = (tr: Trade) => `${tr.ts}:${tr.trader}:${tr.usd.toFixed(2)}`;

export function TokenTrades({ t }: { t: BoardToken }) {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [live, setLive] = useState(false);
  const network = CHAINS[t.chain]?.geckoNetwork ?? null;
  const canLive = Boolean(network && t.poolAddress);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setTrades(null);
    setLive(false);

    if (!canLive) {
      setTrades(demoTrades(t));
      return;
    }

    const url = `/api/trades?chain=${encodeURIComponent(t.chain)}&pool=${encodeURIComponent(
      t.poolAddress as string,
    )}`;

    const tick = async () => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        const j = (await r.json()) as { trades?: Trade[] };
        if (stop) return;
        if (j.trades && j.trades.length) {
          setTrades(j.trades);
          setLive(true);
        } else {
          // Never blank the panel — keep demo only until real trades arrive.
          setTrades((prev) => (prev && prev.length ? prev : demoTrades(t)));
        }
      } catch {
        if (!stop) setTrades((prev) => (prev && prev.length ? prev : demoTrades(t)));
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
        <span className={`trades-live ${live ? "on" : ""}`}>
          <span className="dot-live" /> {live ? "Live" : "Recent"}
        </span>
      </div>
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
