"use client";

import { useState } from "react";
import { PageHead } from "@/components/PageHead";

export default function CalculatorPage() {
  const [inv, setInv] = useState(500);
  const [entry, setEntry] = useState(300000);
  const [target, setTarget] = useState(10000000);

  const valid = inv > 0 && entry > 0 && target > 0;
  const mult = valid ? target / entry : 0;
  const value = valid ? inv * mult : 0;
  const profit = value - inv;

  return (
    <section className="view">
      <PageHead icon="🌙" title="Moon Calculator" sub={'"If I ape $X at this MCAP and it hits that MCAP…" — answered.'} />
      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 640 }}>
        <div className="frow">
          <div className="fld">
            <label>Investment (USD)</label>
            <input type="number" min={0} value={inv} onChange={(e) => setInv(+e.target.value)} />
          </div>
          <div className="fld">
            <label>Entry MCAP (USD)</label>
            <input type="number" min={1} value={entry} onChange={(e) => setEntry(+e.target.value)} />
          </div>
        </div>
        <div className="fld">
          <label>Target MCAP (USD)</label>
          <input type="number" min={1} value={target} onChange={(e) => setTarget(+e.target.value)} />
        </div>
        <div className="calc-out">
          <div className="co">
            <div className="v">{valid ? (mult >= 100 ? mult.toFixed(0) : mult.toFixed(1)) + "×" : "—"}</div>
            <div className="l">Multiple</div>
          </div>
          <div className="co">
            <div className="v dim">{valid ? "$" + Math.round(value).toLocaleString("en-US") : "—"}</div>
            <div className="l">Position value</div>
          </div>
          <div className="co">
            <div className="v" style={{ color: profit >= 0 ? "var(--mint)" : "var(--red)" }}>
              {valid ? (profit >= 0 ? "+" : "−") + "$" + Math.abs(Math.round(profit)).toLocaleString("en-US") : "—"}
            </div>
            <div className="l">Profit</div>
          </div>
        </div>
        <p className="hint">
          Assumes no tax, no dilution, and that you actually take profit — which you won&apos;t. 😄
        </p>
      </div>
    </section>
  );
}
