"use client";

// Admin console — the Pons tab: tokens the launchpad's factory has just minted
// on Robinhood Chain, read off chain. Nothing here is listed by itself: Dexvra
// is paid-listing only, so promoting one stays a deliberate press of a button.
// It reads the chain, so it loads only when the tab is OPENED — it used to run
// on every console load whether or not anybody looked at it.
import { useCallback, useEffect, useState } from "react";
import type { ListingTier } from "@/lib/types";
import { LISTING_TIERS, tierLabel } from "@/lib/packages";
import { fmtAge, fmtCap, fmtPrice } from "@/lib/format";

interface PonsQueueItem {
  address: string;
  symbol: string | null;
  name: string | null;
  ageMinutes: number;
  graduated: boolean;
  phase: string;
  progressPct: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  ponsUrl: string;
  existing: { id: string; status: string } | null;
}

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function PonsQueue({ onListed }: { onListed: () => Promise<void> }) {
  const [items, setItems] = useState<PonsQueueItem[] | null>(null);
  const [live, setLive] = useState(true);
  const [tier, setTier] = useState<ListingTier>("BRONZE");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [hideListed, setHideListed] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/pons", { cache: "no-store" });
      if (!r.ok) {
        setItems([]);
        setLive(false);
        return;
      }
      const j = await r.json();
      setItems(j.launches ?? []);
      setLive(j.live !== false);
    } catch {
      setItems([]);
      setLive(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const list = async (address: string) => {
    setErr("");
    setBusy(address);
    try {
      const r = await fetch("/api/admin/pons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, tier }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.error ?? `Could not create the listing (HTTP ${r.status})`);
        return;
      }
      await Promise.all([onListed(), load()]);
    } finally {
      setBusy(null);
    }
  };

  const shown = (items ?? []).filter((l) => !(hideListed && l.existing));
  const listedCount = (items ?? []).filter((l) => l.existing).length;

  return (
    <section className="asec">
      <div className="asec-h">
        Pons launches · Robinhood <span className="cnt">{items?.length ?? "…"}</span>
        <div className="asec-h-tools">
          <label className="a-check">
            <input type="checkbox" checked={hideListed} onChange={(e) => setHideListed(e.target.checked)} />
            Hide listed{listedCount ? ` (${listedCount})` : ""}
          </label>
          <select className="a-select a-narrow" value={tier} onChange={(e) => setTier(e.target.value as ListingTier)} title="Tier applied when you list a launch">
            {LISTING_TIERS.map((t) => (
              <option key={t.key} value={t.key}>List as {tierLabel(t.key)}</option>
            ))}
          </select>
          <button className="abtn" onClick={() => { setItems(null); load(); }}>Refresh</button>
        </div>
      </div>
      <div className="asec-body">
        {err && <div className="login-err a-note-err">{err}</div>}
        {items == null ? (
          <div className="a-chain">Reading the Pons factory…</div>
        ) : !live ? (
          <div className="a-chain">Robinhood Chain RPC unreachable — try Refresh shortly.</div>
        ) : shown.length === 0 ? (
          <div className="a-chain">{items.length ? "Every launch in the window is already listed." : "No launches inside the scanned window yet."}</div>
        ) : (
          <div className="a-list">
            {shown.map((l) => (
              <div className="a-item" key={l.address}>
                <div className="a-item-main">
                  <div className="a-sym-t">{l.symbol ? `$${l.symbol}` : short(l.address)}</div>
                  <div className="a-chain">
                    {l.name || "Unnamed"} · {fmtAge(l.ageMinutes)} old ·{" "}
                    {l.graduated ? l.phase : `curve ${(l.progressPct ?? 0).toFixed(0)}%`} ·{" "}
                    {l.priceUsd != null ? fmtPrice(l.priceUsd) : "no price"} · {l.mcapUsd != null ? fmtCap(l.mcapUsd) : "—"} mcap
                  </div>
                  <div className="a-ca" title={l.address}>{l.address}</div>
                </div>
                <div className="a-item-act">
                  {l.existing ? (
                    <span className="a-chain">Listed ({l.existing.status})</span>
                  ) : (
                    <button
                      className="abtn ok"
                      disabled={busy === l.address || !l.symbol}
                      title={l.symbol ? "" : "Launch has no on-chain ticker"}
                      onClick={() => list(l.address)}
                    >
                      {busy === l.address ? "Listing…" : "List it"}
                    </button>
                  )}
                  <a className="abtn" href={l.ponsUrl} target="_blank" rel="noopener noreferrer">Pons ↗</a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
