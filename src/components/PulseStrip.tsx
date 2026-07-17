"use client";

import { CHAINS } from "@/config/chains";
import { fmtCap } from "@/lib/format";
import { BRAND_NAME } from "@/config/brand";
import { useApp } from "./AppState";

function FearGreedGauge({ value }: { value: number }) {
  const cx = 100,
    cy = 100,
    r = 78;
  const segs: [string, number, number][] = [
    ["#FF4D6D", 0, 36],
    ["#FF9D4D", 36, 72],
    ["#FFD166", 72, 108],
    ["#A8E063", 108, 144],
    ["#3DF59F", 144, 180],
  ];
  const rad = (a: number) => (Math.PI / 180) * (180 - a);
  const arc = (a1: number, a2: number, c: string, key: number) => {
    const x1 = cx + r * Math.cos(rad(a1)),
      y1 = cy - r * Math.sin(rad(a1)),
      x2 = cx + r * Math.cos(rad(a2)),
      y2 = cy - r * Math.sin(rad(a2));
    return (
      <path
        key={key}
        d={`M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 0 1 ${x2.toFixed(1)},${y2.toFixed(1)}`}
        fill="none"
        stroke={c}
        strokeWidth="12"
        strokeLinecap="round"
      />
    );
  };
  const ang = -90 + (value / 100) * 180;
  return (
    <svg viewBox="0 0 200 110">
      {segs.map((s, i) => arc(s[1] + 3, s[2] - 3, s[0], i))}
      <g transform={`rotate(${ang} ${cx} ${cy})`}>
        <line x1={cx} y1={cy - 4} x2={cx} y2={cy - 56} stroke="#F1F5FB" strokeWidth="3.5" strokeLinecap="round" />
      </g>
      <circle cx={cx} cy={cy} r="6.5" fill="#F1F5FB" />
      <circle cx={cx} cy={cy} r="2.8" fill="#0B0E15" />
    </svg>
  );
}

function fngZone(v: number): [string, string] {
  if (v < 25) return ["Extreme Fear", "#FF4D6D"];
  if (v < 45) return ["Fear", "#FF9D4D"];
  if (v < 55) return ["Neutral", "#FFD166"];
  if (v < 75) return ["Greed", "#A8E063"];
  return ["Extreme Greed", "#3DF59F"];
}

export function PulseStrip() {
  const { data, fng } = useApp();
  const heat = data?.heat ?? [];
  const hottest = heat.length ? heat.reduce((a, b) => (a.temp > b.temp ? a : b)) : null;
  const fngVal = fng?.value ?? null;
  const zone = fngVal != null ? fngZone(fngVal) : null;

  return (
    <div className="pulse-strip">
      <div className="wcard">
        <div className="wcard-head">
          <div className="ic">📡</div>
          <h3>{BRAND_NAME} Pulse</h3>
          <span className="live-pill">● LIVE</span>
          <a className="more">
            {hottest ? `${CHAINS[hottest.chain]?.label ?? hottest.chain} ${hottest.temp}° 🔥` : "…"}
          </a>
        </div>
        <div className="heat">
          {heat.map((h) => {
            const c = CHAINS[h.chain];
            if (!c) return null;
            return (
              <div className="heat-cell" key={h.chain}>
                <div className="heat-top">
                  <span className="heat-chain">
                    <span className="cdot" style={{ background: c.color, color: c.color }} />
                    {c.label}
                  </span>
                  <span className="heat-temp">{h.temp}°</span>
                </div>
                <div className="heat-kv">
                  <span>VOL</span>
                  <b>{fmtCap(h.vol24h)}</b>
                </div>
                <div className="heat-bar">
                  <i style={{ width: `${Math.min(h.temp * 2.2, 100)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="wcard">
        <div className="wcard-head">
          <div className="ic">🧭</div>
          <h3>Fear &amp; Greed</h3>
          <a className="more">{fng?.source === "live" ? "LIVE" : "History"}</a>
        </div>
        <div className="fg">
          {fngVal != null && <FearGreedGauge value={fngVal} />}
          <div className="fg-col">
            <div className="fg-num" style={{ color: zone?.[1] }}>{fngVal ?? "…"}</div>
            <div className="fg-label" style={{ color: zone?.[1] }}>{zone?.[0] ?? ""}</div>
            <div className="fg-note">
              {fng ? `Updated ${fng.updatedMinutesAgo} min ago` : "Loading…"}
            </div>
          </div>
        </div>
      </div>

      <div className="wcard">
        <div className="wcard-head">
          <div className="ic">⚡</div>
          <h3>Wire</h3>
          <a className="more">View all</a>
        </div>
        <div className="wire-list">
          {(data?.wire ?? []).map((w, i) => (
            <div className="wire-item" key={i}>
              <span className="wdot" style={{ background: w.color, boxShadow: `0 0 8px ${w.color}` }} />
              <span dangerouslySetInnerHTML={{ __html: w.html }} />
              <span className="t">{w.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
