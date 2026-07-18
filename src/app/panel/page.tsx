"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { StoredListing } from "@/lib/store";
import type { ListingTier } from "@/lib/types";
import { CHAIN_IDS, CHAINS } from "@/config/chains";
import { LISTING_TIERS, tierLabel } from "@/lib/packages";
import { Logo } from "@/components/Logo";

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

const emptyAdd = {
  chain: "solana",
  address: "",
  sym: "",
  name: "",
  emoji: "",
  tier: "DIAMOND" as ListingTier,
  website: "",
  twitter: "",
  telegram: "",
};

export default function AdminDashboard() {
  const [rows, setRows] = useState<StoredListing[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [add, setAdd] = useState(emptyAdd);
  const [addErr, setAddErr] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/listings", { cache: "no-store" });
      if (r.status === 401) {
        window.location.assign(window.location.pathname.replace(/\/$/, "") || "/");
        return;
      }
      const j = await r.json();
      setRows(j.listings ?? []);
    } catch {
      setErr("Failed to load listings");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(id);
    try {
      const r = await fetch(`/api/admin/listings/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) await load();
    } finally {
      setBusy(null);
    }
  };

  const setStatus = async (id: string, status: string) => {
    setBusy(id);
    try {
      const r = await fetch(`/api/admin/listings/${id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (r.ok) await load();
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this listing permanently?")) return;
    setBusy(id);
    try {
      const r = await fetch(`/api/admin/listings/${id}`, { method: "DELETE" });
      if (r.ok) await load();
    } finally {
      setBusy(null);
    }
  };

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddErr("");
    setAdding(true);
    try {
      const r = await fetch("/api/admin/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(add),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setAdd(emptyAdd);
        await load();
      } else {
        setAddErr(j.error || "Could not add listing");
      }
    } finally {
      setAdding(false);
    }
  };

  const logout = async () => {
    await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
    window.location.assign(window.location.pathname.replace(/\/$/, "") || "/");
  };

  const pending = useMemo(() => (rows ?? []).filter((r) => r.status === "pending"), [rows]);
  const stats = useMemo(() => {
    const all = rows ?? [];
    return {
      total: all.length,
      approved: all.filter((r) => r.status === "approved").length,
      pending: all.filter((r) => r.status === "pending").length,
      trending: all.filter((r) => r.trendingRank != null && r.status === "approved").length,
    };
  }, [rows]);

  const setA = (k: keyof typeof emptyAdd) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setAdd((s) => ({ ...s, [k]: e.target.value }));

  return (
    <>
      <header className="admin-top">
        <div className="admin-brand">
          <div className="brand-logo"><Logo size={36} /></div>
          <div className="admin-name">Dexvra<span>Admin Console</span></div>
        </div>
        <div className="admin-top-actions">
          <a className="abtn" href="https://dexvra.io" target="_blank" rel="noopener noreferrer">View site ↗</a>
          <button className="abtn bad" onClick={logout}>Log out</button>
        </div>
      </header>

      <div className="admin-wrap">
        {err && <div className="login-err">{err}</div>}

        <div className="admin-stats">
          <div className="astat"><div className="k">Listings</div><div className="v">{stats.total}</div></div>
          <div className="astat"><div className="k">Approved</div><div className="v">{stats.approved}</div></div>
          <div className="astat pend"><div className="k">Pending</div><div className="v">{stats.pending}</div></div>
          <div className="astat"><div className="k">Trending</div><div className="v">{stats.trending}</div></div>
        </div>

        {/* Pending submissions */}
        <section className="asec">
          <div className="asec-h">Pending submissions <span className="cnt">{pending.length}</span></div>
          <div className="asec-body">
            {rows == null ? (
              <div className="a-chain">Loading…</div>
            ) : pending.length === 0 ? (
              <div className="a-chain">No submissions waiting for review.</div>
            ) : (
              <div className="pend-grid">
                {pending.map((r) => (
                  <div className="pend-card" key={r.id}>
                    <div className="pend-top">
                      <span style={{ fontSize: 20 }}>{r.emoji}</span>
                      <div>
                        <div className="pend-sym">{r.sym}</div>
                        <div className="a-chain">{r.name} · {CHAINS[r.chain]?.label ?? r.chain}</div>
                      </div>
                    </div>
                    <div className="pend-meta">{r.address}</div>
                    <div className="pend-actions">
                      <button className="abtn ok" disabled={busy === r.id} onClick={() => setStatus(r.id, "approved")}>Approve</button>
                      <button className="abtn bad" disabled={busy === r.id} onClick={() => setStatus(r.id, "rejected")}>Reject</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* All listings */}
        <section className="asec">
          <div className="asec-h">All listings <span className="cnt">{rows?.length ?? 0}</span></div>
          <div className="atable-wrap">
            <table className="atable">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Chain</th>
                  <th>Contract</th>
                  <th>Tier</th>
                  <th>Trending</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="a-sym"><span>{r.emoji}</span>{r.sym}</div>
                      <div className="a-chain">{r.name}</div>
                    </td>
                    <td className="a-chain">{CHAINS[r.chain]?.label ?? r.chain}</td>
                    <td className="a-ca" title={r.address}>{short(r.address)}</td>
                    <td style={{ minWidth: 130 }}>
                      <select
                        className="a-select"
                        value={r.tier}
                        disabled={busy === r.id}
                        onChange={(e) => patch(r.id, { tier: e.target.value })}
                      >
                        {LISTING_TIERS.map((t) => (
                          <option key={t.key} value={t.key}>{tierLabel(t.key)}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <label className="a-check">
                        <input
                          type="checkbox"
                          checked={r.trendingRank != null}
                          disabled={busy === r.id}
                          onChange={(e) => patch(r.id, { trendingRank: e.target.checked ? (r.trendingRank ?? 1) : null })}
                        />
                        Featured
                      </label>
                    </td>
                    <td><span className={`a-status ${r.status}`}>{r.status}</span></td>
                    <td>
                      <div className="a-row-actions">
                        {r.status !== "approved" ? (
                          <button className="abtn ok" disabled={busy === r.id} onClick={() => setStatus(r.id, "approved")}>Approve</button>
                        ) : (
                          <button className="abtn" disabled={busy === r.id} onClick={() => setStatus(r.id, "rejected")}>Unlist</button>
                        )}
                        <button className="abtn bad" disabled={busy === r.id} onClick={() => remove(r.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Add listing */}
        <section className="asec">
          <div className="asec-h">Add listing</div>
          <div className="asec-body">
            <form className="add-grid" onSubmit={submitAdd}>
              <div className="add-fld">
                <label>Chain</label>
                <select className="a-select" value={add.chain} onChange={setA("chain")}>
                  {CHAIN_IDS.map((id) => (<option key={id} value={id}>{CHAINS[id].label}</option>))}
                </select>
              </div>
              <div className="add-fld">
                <label>Ticker</label>
                <input className="a-input" value={add.sym} onChange={setA("sym")} placeholder="BONK" />
              </div>
              <div className="add-fld">
                <label>Name</label>
                <input className="a-input" value={add.name} onChange={setA("name")} placeholder="Bonk" />
              </div>
              <div className="add-fld">
                <label>Tier</label>
                <select className="a-select" value={add.tier} onChange={setA("tier")}>
                  {LISTING_TIERS.map((t) => (<option key={t.key} value={t.key}>{tierLabel(t.key)}</option>))}
                </select>
              </div>
              <div className="add-fld wide">
                <label>Contract address</label>
                <input className="a-input" value={add.address} onChange={setA("address")} placeholder="Paste CA…" />
              </div>
              <div className="add-fld">
                <label>Emoji</label>
                <input className="a-input" value={add.emoji} onChange={setA("emoji")} placeholder="🐕" maxLength={4} />
              </div>
              <div className="add-fld">
                <label>Website</label>
                <input className="a-input" value={add.website} onChange={setA("website")} placeholder="https://…" />
              </div>
              <div className="add-fld">
                <label>X / Twitter</label>
                <input className="a-input" value={add.twitter} onChange={setA("twitter")} placeholder="https://x.com/…" />
              </div>
              <div className="add-fld">
                <label>Telegram</label>
                <input className="a-input" value={add.telegram} onChange={setA("telegram")} placeholder="https://t.me/…" />
              </div>
              {addErr && <div className="add-fld wide"><div className="login-err" style={{ textAlign: "left" }}>{addErr}</div></div>}
              <div className="add-fld wide">
                <button className="abtn p" type="submit" disabled={adding} style={{ padding: "10px 18px" }}>
                  {adding ? "Adding…" : "Add listing (goes live)"}
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </>
  );
}
