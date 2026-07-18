"use client";

import { useState } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { shortAddr } from "@/lib/format";
import type { ScanResult } from "@/lib/types";

export default function ScannerPage() {
  const { data, toast } = useApp();
  const [ca, setCa] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);

  const scan = async (address: string) => {
    const trimmed = address.trim();
    if (trimmed.length < 20) {
      toast("That doesn't look like a contract address 🤔");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/scan?ca=${encodeURIComponent(trimmed)}`);
      if (!res.ok) throw new Error(String(res.status));
      setResult((await res.json()) as ScanResult);
    } catch {
      toast("Scan failed — try again in a moment");
    } finally {
      setBusy(false);
    }
  };

  const demo = () => {
    const t = data?.tokens[1] ?? data?.tokens[0];
    if (!t) return;
    setCa(t.address);
    scan(t.address);
  };

  return (
    <section className="view">
      <PageHead icon="🧪" title="Token Scanner" sub="Paste any contract address for an instant safety snapshot." />
      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 13, maxWidth: 640 }}>
        <div className="fld">
          <label>Contract address</label>
          <input value={ca} onChange={(e) => setCa(e.target.value)} placeholder="e.g. 7xKq…3fPa (any chain)" />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn-primary" onClick={() => scan(ca)} disabled={busy}>
            {busy ? "Scanning…" : "🧪 Scan token"}
          </button>
          <button className="btn-ghost2" onClick={demo}>Try a demo CA</button>
        </div>
      </div>

      {result && (
        <div className="panel" style={{ maxWidth: 640 }}>
          <div className="m-title" style={{ fontSize: 16, marginBottom: 8 }}>
            🧪 Scan result{" "}
            <span style={{ fontFamily: "var(--fm)", fontSize: 10, color: "var(--faint)", fontWeight: 700 }}>
              {shortAddr(result.address)}
            </span>
          </div>
          <div className="check-list">
            {result.checks.map((c) => (
              <div className="check" key={c.label}>
                {c.label}
                <span className={`cv ${c.status}`}>{c.value}</span>
              </div>
            ))}
          </div>
          <div className={`verdict ${result.verdict}`}>{result.verdictText}</div>
          <p className="hint" style={{ marginTop: 10 }}>
            Automated snapshot only — never a guarantee. Always do your own research.
          </p>
        </div>
      )}
    </section>
  );
}
