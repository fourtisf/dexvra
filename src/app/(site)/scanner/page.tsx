"use client";

import { useState } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { ChainLogo } from "@/components/ChainLogo";
import { CHAINS } from "@/config/chains";
import { shortAddr } from "@/lib/format";
import type { ScanResult } from "@/lib/types";

const SCORE_COLOR: Record<string, string> = {
  SAFE: "#3DDC97",
  CAUTION: "#E7C77A",
  "HIGH RISK": "#F76A85",
  LIMITED: "#9AA6BC",
};

function ScoreRing({ score, color }: { score: number | null; color: string }) {
  const r = 46;
  const circ = 2 * Math.PI * r;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score));
  const off = circ * (1 - pct / 100);
  return (
    <svg viewBox="0 0 120 120" className="score-ring" role="img" aria-label={`Safety score ${score ?? "unknown"}`}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,.1)" strokeWidth="9" />
      <circle
        cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={off} transform="rotate(-90 60 60)"
      />
      <text x="60" y="58" textAnchor="middle" className="score-num" fill={color}>{score ?? "—"}</text>
      <text x="60" y="78" textAnchor="middle" className="score-den">/ 100</text>
    </svg>
  );
}

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

  const copy = () => {
    if (!result) return;
    navigator.clipboard?.writeText(result.address).catch(() => {});
    toast("Contract address copied 📋");
  };

  const color = result ? SCORE_COLOR[result.scoreLabel] ?? "#9AA6BC" : "#9AA6BC";
  const chain = result?.chain ? CHAINS[result.chain] : undefined;

  return (
    <section className="view">
      <PageHead icon="🧪" title="Token Scanner" sub="Paste any contract address for an instant safety snapshot." />
      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 13, maxWidth: 720 }}>
        <div className="fld">
          <label>Contract address</label>
          <input value={ca} onChange={(e) => setCa(e.target.value)} placeholder="Paste a CA (Solana, EVM, Tron, TON…)" />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn-primary" onClick={() => scan(ca)} disabled={busy}>
            {busy ? "Scanning…" : "🧪 Scan token"}
          </button>
          <button className="btn-ghost2" onClick={demo}>Try a demo CA</button>
        </div>
      </div>

      {busy && (
        <div className="panel scan-loading" style={{ maxWidth: 720 }}>
          <span className="dot-live" /> Fetching on-chain security data…
        </div>
      )}

      {result && !busy && (
        <div className="scan-report" style={{ maxWidth: 720 }}>
          {/* Header: score + identity */}
          <div className="scan-head panel" style={{ borderColor: `${color}55` }}>
            <ScoreRing score={result.score} color={color} />
            <div className="scan-id">
              <div className="scan-label" style={{ color }}>{result.scoreLabel}</div>
              <div className="scan-name">
                {result.name ?? "Unknown token"}
                {result.symbol && <span className="scan-sym">{result.symbol}</span>}
              </div>
              <div className="scan-meta">
                {chain && (
                  <span className="scan-chip">
                    <ChainLogo chain={result.chain!} size={14} style={{ verticalAlign: "-2px" }} /> {chain.label}
                  </span>
                )}
                <button className="scan-ca" onClick={copy} title="Copy contract">
                  {shortAddr(result.address)} ⧉
                </button>
              </div>
              <div className="scan-src">Source: {result.dataSource}</div>
            </div>
          </div>

          {/* Security analysis grid */}
          <div className="panel">
            <div className="scan-sec-h">Security Analysis</div>
            <div className="scan-grid">
              {result.flags.map((f) => (
                <div className="scan-flag" key={f.label}>
                  <span className="sf-label">{f.label}</span>
                  <span className={`sf-val ${f.status}`}>{f.value}</span>
                </div>
              ))}
            </div>
            <div className={`verdict ${result.verdict}`}>{result.verdictText}</div>
            <p className="hint" style={{ marginTop: 10 }}>
              Automated snapshot only — never a guarantee. Always do your own research.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
