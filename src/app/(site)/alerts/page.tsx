"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { Coin } from "@/components/Coin";

export default function AlertsPage() {
  const { data, alerts, addAlert, removeAlert, toast } = useApp();
  const tokens = useMemo(() => data?.tokens ?? [], [data]);
  const [sel, setSel] = useState("");
  const [cond, setCond] = useState<"pump" | "dump">("pump");
  const [pct, setPct] = useState(50);

  const selectedKey = sel || tokens[0]?.key || "";

  const create = () => {
    if (!pct || pct < 1) {
      toast("Set a threshold % first");
      return;
    }
    const t = tokens.find((x) => x.key === selectedKey);
    if (!t) return;
    addAlert({ key: t.key, symbol: t.symbol, cond, pct });
    toast("Alert created 🔔 — Telegram delivery ships with the bot");
  };

  return (
    <section className="view">
      <PageHead icon="🔔" title="Alerts" sub="Get pinged when a token moves. Telegram delivery coming with the bot." />
      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 13, maxWidth: 640 }}>
        <div className="frow">
          <div className="fld">
            <label>Token</label>
            <select value={selectedKey} onChange={(e) => setSel(e.target.value)}>
              {tokens.map((t) => (
                <option key={t.key} value={t.key}>{t.symbol}</option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label>Condition</label>
            <select value={cond} onChange={(e) => setCond(e.target.value as "pump" | "dump")}>
              <option value="pump">Pumps more than</option>
              <option value="dump">Drops more than</option>
            </select>
          </div>
        </div>
        <div className="frow">
          <div className="fld">
            <label>Threshold (%)</label>
            <input type="number" min={1} value={pct} onChange={(e) => setPct(+e.target.value)} />
          </div>
          <div className="fld" style={{ justifyContent: "flex-end" }}>
            <label>&nbsp;</label>
            <button className="btn-primary" onClick={create}>🔔 Create alert</button>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 9, maxWidth: 640 }}>
        {alerts.length === 0 ? (
          <div className="panel big-empty">
            <div className="em">🔕</div>
            <p>No alerts yet — create one above and never miss a move.</p>
          </div>
        ) : (
          alerts.map((a, i) => {
            const t = tokens.find((x) => x.key === a.key);
            return (
              <div className="alert-item" key={`${a.key}-${i}`}>
                {t ? (
                  <Coin token={t} size={34} fontSize={16} withBadge={false} />
                ) : (
                  <div className="coin" style={{ width: 34, height: 34, fontSize: 16 }}>🔔</div>
                )}
                <div>
                  <div style={{ fontFamily: "var(--fd)", fontWeight: 700, fontSize: 13.5 }}>{a.symbol}</div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                    {a.cond === "pump" ? "Pumps" : "Drops"} more than{" "}
                    <b style={{ color: a.cond === "pump" ? "var(--mint)" : "var(--red)" }}>{a.pct}%</b> · any window
                  </div>
                </div>
                <button className="del" onClick={() => removeAlert(i)}>✕</button>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
