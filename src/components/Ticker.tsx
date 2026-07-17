"use client";

import { fmtPrice } from "@/lib/format";
import { coinBg } from "@/lib/visual";
import { useApp } from "./AppState";

export function Ticker() {
  const { data } = useApp();
  const top = data
    ? [...data.tokens].sort((a, b) => b.chg["24h"] - a.chg["24h"]).slice(0, 8)
    : [];
  if (!top.length) return <div className="ticker" />;

  const renderItems = (prefix: string) =>
    top.map((t, i) => {
      const up = t.chg["24h"] >= 0;
      return (
        <span className="tick-item" key={prefix + t.key + i}>
          <span className="rnk">{i + 1}.</span>
          <span className="tick-coin" style={{ background: coinBg(t.gradient) }}>
            {t.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={t.logoUrl} alt="" style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }} />
            ) : (
              t.emoji
            )}
          </span>
          <span className="sym">{t.symbol}</span>
          <span className="px">{fmtPrice(t.priceUsd)}</span>
          <span className={`pct ${up ? "up" : "dn"}`}>
            ({up ? "+" : ""}
            {t.chg["24h"].toFixed(1)}%)
          </span>
        </span>
      );
    });

  // items rendered twice so the -50% marquee loops seamlessly (prototype trick)
  return (
    <div className="ticker">
      <div className="ticker-track">
        {renderItems("a")}
        {renderItems("b")}
      </div>
    </div>
  );
}
