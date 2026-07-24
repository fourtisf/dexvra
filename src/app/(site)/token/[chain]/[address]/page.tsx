"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo } from "react";
import { useApp } from "@/components/AppState";
import { Coin } from "@/components/Coin";
import { ChainLogo } from "@/components/ChainLogo";
import { Socials } from "@/components/Socials";
import { TokenTrades } from "@/components/TokenTrades";
import { TierTag, TrendingBadge } from "@/components/TierTag";
import { CHAINS } from "@/config/chains";
import { fmtAge, fmtCap, fmtNum, fmtPrice } from "@/lib/format";
import { scoreTier } from "@/lib/score";

export default function TokenPage() {
  const params = useParams<{ chain: string; address: string }>();
  const chain = params.chain;
  const address = decodeURIComponent(params.address ?? "");
  const router = useRouter();
  const { data, watchlist, toggleWatch, toast } = useApp();

  const t = useMemo(
    () =>
      (data?.tokens ?? []).find(
        (x) => x.chain === chain && x.address.toLowerCase() === address.toLowerCase(),
      ),
    [data, chain, address],
  );

  if (!data) {
    return (
      <section className="view">
        <div className="board-loading"><span className="dot-live" /> Loading token…</div>
      </section>
    );
  }
  if (!t) {
    return (
      <section className="view">
        <div className="panel big-empty">
          <div className="em">🔍</div>
          <p>This token isn&apos;t a Dexvra listing (yet). Only paid listings appear here.</p>
          <Link href="/" className="btn-primary">Back to board →</Link>
        </div>
      </section>
    );
  }

  const c = CHAINS[t.chain];
  const network = c?.geckoNetwork ?? null;
  const up = t.chg["24h"] >= 0;
  const col = up ? "#3DDC97" : "#F76A85";
  const watching = watchlist.has(t.key);
  const st = scoreTier(t.score);
  const chartSrc =
    network && t.poolAddress
      ? `https://www.geckoterminal.com/${network}/pools/${t.poolAddress}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0&resolution=15m`
      : null;

  const copyCa = () => {
    navigator.clipboard?.writeText(t.address).catch(() => {});
    toast("Contract address copied 📋");
  };

  const stats: [string, string, string?][] = [
    ["Price", fmtPrice(t.priceUsd)],
    ["24h", `${up ? "+" : ""}${t.chg["24h"].toFixed(1)}%`, up ? "up" : "dn"],
    ["MCAP", fmtCap(t.mcap)],
    ["Liquidity", fmtCap(t.liq)],
    ["Vol · 24h", fmtCap(t.vol["24h"])],
    ["Holders", fmtNum(t.holders)],
    ["Tax", t.taxPct != null ? `${t.taxPct}%` : "—"],
    ["Txns · 24h", fmtNum(t.txns["24h"].buys + t.txns["24h"].sells)],
  ];

  return (
    <section className="view token-page">
      <button className="back-link" onClick={() => router.back()}>← Back</button>

      <div className="tp-head">
        <Coin token={t} size={56} fontSize={26} />
        <div className="tp-id">
          <div className="tp-sym">
            {t.symbol}
            <TierTag tier={t.tier} ageMinutes={t.listedMinutesAgo} />
            {t.trendingRank != null && <TrendingBadge />}
          </div>
          <div className="tp-nm">
            {t.name} · <ChainLogo chain={t.chain} size={14} style={{ verticalAlign: "-2px" }} />{" "}
            <span style={{ color: c?.color }}>{c?.label ?? t.chain}</span> · listed {fmtAge(t.listedMinutesAgo)} ago
          </div>
        </div>
        <div className="tp-price">
          <div className="tp-px">{fmtPrice(t.priceUsd)}</div>
          <div className="tp-chg" style={{ color: col }}>{up ? "+" : ""}{t.chg["24h"].toFixed(1)}%</div>
        </div>
        <div className="tp-actions">
          <button
            className={`btn-ghost2 ${watching ? "on" : ""}`}
            style={{ color: watching ? "var(--gold)" : undefined }}
            onClick={() => toggleWatch(t.key, t.symbol)}
          >
            {watching ? "★ Watching" : "☆ Watch"}
          </button>
          <a className="btn-primary" href={c?.buyUrl(t.address)} target="_blank" rel="noopener noreferrer">
            Buy {t.symbol} →
          </a>
        </div>
      </div>

      <div className="tp-subrow">
        <div className="ca-box">
          <code>{t.address}</code>
          <button className="copy-btn" onClick={copyCa}>COPY</button>
        </div>
        <Socials t={t} />
      </div>

      {t.overview && (
        <div className="panel tp-about">
          <div className="tp-about-k">About {t.symbol}</div>
          <p className="tp-about-p">{t.overview}</p>
        </div>
      )}

      <div className="tp-grid">
        <div className="tp-chart-wrap">
          {chartSrc ? (
            <iframe className="tp-chart" title={`${t.symbol} chart`} src={chartSrc} allow="clipboard-write" allowFullScreen />
          ) : (
            <div className="tp-chart-fallback">
              <svg viewBox="0 0 640 260" preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
                {(() => {
                  // Candlestick view synthesised from the price trend (green up /
                  // red down candles with wicks) — shown until the live
                  // GeckoTerminal candle embed is available (needs a pool address).
                  const pts = t.trend;
                  const H = 260, W = 640, n = pts.length;
                  const lo = Math.min(...pts), hi = Math.max(...pts), rng = hi - lo || 1;
                  const yOf = (v: number) => H - 14 - ((v - lo) / rng) * (H - 28);
                  const slot = W / n;
                  const bw = Math.max(3, slot * 0.58);
                  return pts.map((close, i) => {
                    const open = pts[Math.max(0, i - 1)];
                    const wickHi = Math.max(open, close, pts[Math.min(n - 1, i + 1)]);
                    const wickLo = Math.min(open, close, pts[Math.min(n - 1, i + 1)]);
                    const green = close >= open;
                    const cc = green ? "#3DDC97" : "#F76A85";
                    const cx = i * slot + slot / 2;
                    const bodyTop = Math.min(yOf(open), yOf(close));
                    const bodyH = Math.max(2, Math.abs(yOf(close) - yOf(open)));
                    return (
                      <g key={i}>
                        <line x1={cx} x2={cx} y1={yOf(wickHi)} y2={yOf(wickLo)} stroke={cc} strokeWidth="1.4" />
                        <rect x={cx - bw / 2} y={bodyTop} width={bw} height={bodyH} fill={cc} rx="1" />
                      </g>
                    );
                  });
                })()}
              </svg>
              <div className="chart-note">
                {network ? (
                  <a href={`https://www.geckoterminal.com/${network}/tokens/${t.address}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--mint)" }}>
                    Open full chart on GeckoTerminal ↗
                  </a>
                ) : (
                  `Price trend · ${c?.label ?? t.chain} charts coming soon`
                )}
              </div>
            </div>
          )}
        </div>

        <aside className="tp-side">
          <div
            className="dscore-banner"
            style={{ borderColor: st.color }}
            title="Dexvra Score (0–100) — a transparent on-chain blend: momentum 30% · liquidity depth 25% · tax/safety 15% · buy pressure 15% · holder base 15%. Deterministic, not AI, not paid votes."
          >
            <div className="dsb-num" style={{ color: st.color }}>{t.score}</div>
            <div className="dsb-meta">
              <div className="dsb-title">Dexvra Score · <span style={{ color: st.color }}>{st.label}</span></div>
              <div className="dsb-sub">Signal-based. Not votes.</div>
            </div>
          </div>
          <div className="tp-stats">
            {stats.map(([k, v, cls]) => (
              <div className="ds" key={k}>
                <div className="k">{k}</div>
                <div className={`v ${cls === "up" ? "tp-up" : cls === "dn" ? "tp-dn" : ""}`}>{v}</div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <TokenTrades t={t} />
    </section>
  );
}
