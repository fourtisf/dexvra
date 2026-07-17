"use client";

import { CHAINS } from "@/config/chains";
import { fmtAge, fmtCap, fmtNum, fmtPrice, pathFrom } from "@/lib/format";
import { useApp } from "./AppState";
import { Coin } from "./Coin";

export function TokenDetailModal() {
  const { detailToken: t, closeDetail, watchlist, toggleWatch, toast } = useApp();
  if (!t) return null;
  const c = CHAINS[t.chain];
  const up = t.chg["24h"] >= 0;
  const col = up ? "#3DF59F" : "#FF5C7A";
  const d = pathFrom(t.trend, 320, 72);
  const watching = watchlist.has(t.key);

  const copyCa = () => {
    navigator.clipboard?.writeText(t.address).catch(() => {});
    toast("Contract address copied 📋");
  };

  return (
    <div className="modal-ov on" onClick={(e) => e.target === e.currentTarget && closeDetail()}>
      <div className="modal">
        <button className="modal-x" onClick={closeDetail}>✕</button>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="detail-head">
            <Coin token={t} size={52} fontSize={25} />
            <div>
              <div className="m-title" style={{ fontSize: 20 }}>{t.symbol}</div>
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                {t.name} · <span style={{ color: c?.color }}>{c?.label ?? t.chain}</span>
                {t.ageMinutes != null && <> · listed {fmtAge(t.ageMinutes)} ago</>}
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

          <svg className="detail-spark" viewBox="0 0 320 72" preserveAspectRatio="none">
            <path d={`${d} L320,72 L0,72 Z`} fill={col} fillOpacity=".14" />
            <path d={d} fill="none" stroke={col} strokeWidth="2.2" strokeLinecap="round" />
          </svg>

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
            <a
              className="btn-primary"
              href={c?.buyUrl(t.address)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Buy {t.symbol} →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
