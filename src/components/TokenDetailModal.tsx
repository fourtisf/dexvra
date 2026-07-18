"use client";

import { useEffect, useState } from "react";
import { CHAINS } from "@/config/chains";
import { fmtAge, fmtCap, fmtNum, fmtPrice, pathFrom } from "@/lib/format";
import { scoreTier } from "@/lib/score";
import type { BoardToken } from "@/lib/types";
import { useApp } from "./AppState";
import { Coin } from "./Coin";

type ChartState = { network: string; poolAddress: string } | null | undefined; // undefined = loading

function DetailContent({ t }: { t: BoardToken }) {
  const { closeDetail, watchlist, toggleWatch, toast } = useApp();
  const network = CHAINS[t.chain]?.geckoNetwork ?? null;
  // The pool address already comes with the live token data (same fetch that
  // loads price/volume), so the chart embeds instantly with no extra call.
  const initial: ChartState =
    network && t.poolAddress ? { network, poolAddress: t.poolAddress } : undefined;
  const [chart, setChart] = useState<ChartState>(initial);

  // Fallback only when the token arrived without a pool (e.g. offline seed):
  // ask the API to resolve it once.
  useEffect(() => {
    if (initial) return; // already have the pool → nothing to do
    let stop = false;
    setChart(undefined);
    fetch(`/api/pool?chain=${encodeURIComponent(t.chain)}&address=${encodeURIComponent(t.address)}`)
      .then((r) => r.json())
      .then((j: { network: string | null; poolAddress: string | null }) => {
        if (!stop) setChart(j.poolAddress && j.network ? { network: j.network, poolAddress: j.poolAddress } : null);
      })
      .catch(() => {
        if (!stop) setChart(null);
      });
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.chain, t.address]);

  const c = CHAINS[t.chain];
  const up = t.chg["24h"] >= 0;
  const col = up ? "#3DDC97" : "#F76A85";
  const d = pathFrom(t.trend, 320, 72);
  const watching = watchlist.has(t.key);
  const st = scoreTier(t.score);

  const copyCa = () => {
    navigator.clipboard?.writeText(t.address).catch(() => {});
    toast("Contract address copied 📋");
  };

  const chartSrc = chart
    ? `https://www.geckoterminal.com/${chart.network}/pools/${chart.poolAddress}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0&resolution=15m`
    : null;

  return (
    <div className="modal-ov on" onClick={(e) => e.target === e.currentTarget && closeDetail()}>
      <div className="modal detail-modal-wide">
        <button className="modal-x" onClick={closeDetail}>✕</button>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="detail-head">
            <Coin token={t} size={52} fontSize={25} />
            <div>
              <div className="m-title" style={{ fontSize: 20, display: "flex", alignItems: "center", gap: 8 }}>
                {t.symbol}
                <span className={`tier-chip tier-${t.tier}`}>{t.tier.replace("FASTTRACK", "FAST-TRACK")}</span>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                {t.name} · <span style={{ color: c?.color }}>{c?.label ?? t.chain}</span> · listed {fmtAge(t.listedMinutesAgo)} ago
              </div>
            </div>
            <div className="detail-price">
              {fmtPrice(t.priceUsd)}
              <div style={{ fontSize: 13, color: col }}>
                {up ? "+" : ""}
                {t.chg["24h"].toFixed(1)}%
              </div>
            </div>
          </div>

          {chartSrc ? (
            <div className="detail-chart">
              <iframe title={`${t.symbol} chart`} src={chartSrc} allow="clipboard-write" allowFullScreen />
            </div>
          ) : (
            <div className="detail-chart-fallback">
              <svg className="detail-spark" viewBox="0 0 320 72" preserveAspectRatio="none">
                <path d={`${d} L320,72 L0,72 Z`} fill={col} fillOpacity=".14" />
                <path d={d} fill="none" stroke={col} strokeWidth="2.2" strokeLinecap="round" />
              </svg>
              <div className="chart-note">
                {chart === undefined ? (
                  <>
                    <span className="dot-live" style={{ display: "inline-block", marginRight: 6, verticalAlign: "middle" }} />
                    Loading live chart…
                  </>
                ) : c?.geckoNetwork ? (
                  <a href={`https://www.geckoterminal.com/${c.geckoNetwork}/tokens/${t.address}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--mint)" }}>
                    Open full chart on GeckoTerminal ↗
                  </a>
                ) : (
                  `Price trend · ${c?.label ?? t.chain} charts coming soon`
                )}
              </div>
            </div>
          )}

          <div className="dscore-banner" style={{ borderColor: st.color }}>
            <div className="dsb-num" style={{ color: st.color }}>{t.score}</div>
            <div className="dsb-meta">
              <div className="dsb-title">Dexvra Score · <span style={{ color: st.color }}>{st.label}</span></div>
              <div className="dsb-sub">Signal-based (momentum · liquidity · tax · buy pressure). Not votes.</div>
            </div>
          </div>

          <div className="detail-stats">
            <div className="ds"><div className="k">MCAP</div><div className="v">{fmtCap(t.mcap)}</div></div>
            <div className="ds"><div className="k">Liquidity</div><div className="v">{fmtCap(t.liq)}</div></div>
            <div className="ds"><div className="k">Vol · 24h</div><div className="v">{fmtCap(t.vol["24h"])}</div></div>
            <div className="ds"><div className="k">Holders</div><div className="v">{fmtNum(t.holders)}</div></div>
            <div className="ds">
              <div className="k">Tax</div>
              <div className="v" style={{ color: t.taxPct === 0 ? "var(--mint)" : t.taxPct == null ? undefined : "var(--orange)" }}>
                {t.taxPct != null ? `${t.taxPct}%` : "—"}
              </div>
            </div>
            <div className="ds">
              <div className="k">Txns · 24h</div>
              <div className="v">{fmtNum(t.txns["24h"].buys + t.txns["24h"].sells)}</div>
            </div>
          </div>

          <div className="ca-box">
            <code>{t.address}</code>
            <button className="copy-btn" onClick={copyCa}>COPY</button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div className="soc-row">
              <a className="soc" title="Explorer" href={c?.explorer(t.address)} target="_blank" rel="noopener noreferrer">⛓</a>
              <a className="soc" title="X">𝕏</a>
              <a className="soc" title="Telegram">✈</a>
            </div>
            <button
              className={`btn-ghost2 ${watching ? "on" : ""}`}
              style={{ marginLeft: "auto", color: watching ? "var(--gold)" : undefined }}
              onClick={() => toggleWatch(t.key, t.symbol)}
            >
              {watching ? "★ Watching" : "☆ Watch"}
            </button>
            <a className="btn-primary" href={c?.buyUrl(t.address)} target="_blank" rel="noopener noreferrer">
              Buy {t.symbol} →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TokenDetailModal() {
  const { detailToken } = useApp();
  if (!detailToken) return null;
  // key by token so chart state resets when a different token is opened
  return <DetailContent key={detailToken.key} t={detailToken} />;
}
