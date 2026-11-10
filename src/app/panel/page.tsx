"use client";

// The admin console. ONE TAB AT A TIME:
//
//   Review   — what is waiting on a human: the counts, and pending submissions
//   Listings — every listing, searched/filtered/paged; one Manage button a row
//   Pons     — fresh Robinhood launches (reads the chain, so only when opened)
//   Add      — create a listing by hand
//   Site     — the homepage showcase, the homepage banners, the channel banners
//
// "perbaiki admin panel agar lebih clean dan mudah diakses, ini terlalu banyak
// spam": it used to be one scroll of all of the above — three site editors
// first, then ~700 listings with nine controls each, then the add form at the
// very bottom. The open tab lives in the URL hash, so a reload or a bookmark
// lands on it. The view rules (filter, order, pages, counts) are in
// lib/adminView, where they are tested by being called.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { StoredListing } from "@/lib/store";
import { CHAINS } from "@/config/chains";
import { tierLabel } from "@/lib/packages";
import { fmtAge } from "@/lib/format";
import {
  EMPTY_FILTER,
  arrivedAt,
  countListings,
  tabFromHash,
  type AdminTab,
  type ListFilter,
} from "@/lib/adminView";
import { Logo } from "@/components/Logo";
import { BannerManager } from "@/components/admin/BannerManager";
import { ChannelBannerManager } from "@/components/admin/ChannelBannerManager";
import { PromoManager } from "@/components/admin/PromoManager";
import { ListingsTable, type ListingActions } from "@/components/admin/ListingsTable";
import { PonsQueue } from "@/components/admin/PonsQueue";
import { AddListingForm } from "@/components/admin/AddListingForm";

type Note = { kind: "ok" | "err"; text: string } | null;

const TAB_LABEL: Record<AdminTab, string> = {
  review: "Review",
  listings: "Listings",
  pons: "Pons",
  add: "Add listing",
  site: "Site content",
};

/** The reason a refused admin request gives, or its status. */
async function reason(r: Response, what: string): Promise<string> {
  const j = await r.json().catch(() => ({}) as Record<string, unknown>);
  return `${what}: ${typeof j.error === "string" && j.error ? j.error : `HTTP ${r.status}`}`;
}

export default function AdminDashboard() {
  const [rows, setRows] = useState<StoredListing[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [tab, setTab] = useState<AdminTab>("review");
  const [filter, setFilter] = useState<ListFilter>(EMPTY_FILTER);
  const [now, setNow] = useState(() => Date.now());

  // The tab follows the hash: the back button and a reload both land right.
  useEffect(() => {
    const sync = () => setTab(tabFromHash(window.location.hash));
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const go = (t: AdminTab) => {
    if (window.location.hash !== `#${t}`) window.location.hash = t;
    setTab(t);
    window.scrollTo({ top: 0 });
  };

  // A success note clears itself; a failure stays until the next action.
  useEffect(() => {
    if (note?.kind !== "ok") return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/listings", { cache: "no-store" });
      if (r.status === 401) {
        window.location.assign(window.location.pathname.replace(/\/$/, "") || "/");
        return;
      }
      if (!r.ok) {
        setLoadErr(await reason(r, "Could not load listings"));
        return;
      }
      const j = await r.json();
      setRows(j.listings ?? []);
      setLoadErr("");
      setNow(Date.now());
    } catch {
      setLoadErr("Could not load listings — the site did not answer.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Every write reports its outcome — a refused change used to vanish without
  // a word, which reads exactly like a button that does nothing.
  const run = useCallback(
    async (id: string, what: string, req: () => Promise<Response>, okText?: string): Promise<boolean> => {
      setBusy(id);
      setNote(null);
      try {
        const r = await req();
        if (!r.ok) {
          setNote({ kind: "err", text: await reason(r, what) });
          return false;
        }
        await load();
        if (okText) setNote({ kind: "ok", text: okText });
        return true;
      } catch {
        setNote({ kind: "err", text: `${what}: the site did not answer` });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const symOf = useCallback((id: string) => rows?.find((r) => r.id === id)?.sym ?? "listing", [rows]);

  const actions: ListingActions = useMemo(
    () => ({
      patch: (id, body) =>
        run(id, `Could not update ${symOf(id)}`, () =>
          fetch(`/api/admin/listings/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        `${symOf(id)} updated`),
      setStatus: (id, status) =>
        run(id, `Could not change ${symOf(id)}`, () =>
          fetch(`/api/admin/listings/${id}/status`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status }),
          }),
        `${symOf(id)} ${status === "approved" ? "approved — live on the site" : status === "rejected" ? "unlisted" : status}`),
      remove: (id) => {
        if (!confirm(`Delete ${symOf(id)} permanently? This cannot be undone.`)) return Promise.resolve(false);
        return run(id, `Could not delete ${symOf(id)}`, () => fetch(`/api/admin/listings/${id}`, { method: "DELETE" }), `${symOf(id)} deleted`);
      },
      reload: load,
    }),
    [run, symOf, load],
  );

  const logout = async () => {
    await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
    window.location.assign(window.location.pathname.replace(/\/$/, "") || "/");
  };

  const counts = useMemo(() => countListings(rows ?? [], now), [rows, now]);
  const pending = useMemo(
    () => (rows ?? []).filter((r) => r.status === "pending").sort((a, b) => arrivedAt(b) - arrivedAt(a)),
    [rows],
  );

  // A stat card opens the Listings tab already filtered to what it counts.
  const openListings = (patch: Partial<ListFilter>) => {
    setFilter({ ...EMPTY_FILTER, ...patch });
    go("listings");
  };

  const rejectAll = async () => {
    if (!pending.length) return;
    if (!confirm(`Reject all ${pending.length} pending submission(s)? They stay in the store as unlisted.`)) return;
    setBusy("__all");
    setNote(null);
    let done = 0;
    let failed = "";
    try {
      for (const r of pending) {
        const res = await fetch(`/api/admin/listings/${r.id}/status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "rejected" }),
        }).catch(() => null);
        if (res?.ok) done++;
        else if (!failed) failed = res ? await reason(res, r.sym) : `${r.sym}: the site did not answer`;
      }
      await load();
      setNote(failed ? { kind: "err", text: `Rejected ${done} of ${pending.length}. ${failed}` } : { kind: "ok", text: `Rejected ${done} submission(s)` });
    } finally {
      setBusy(null);
    }
  };

  const badge: Partial<Record<AdminTab, number>> = { review: counts.pending, listings: counts.total };

  return (
    <>
      <header className="admin-top">
        <div className="admin-brand">
          <div className="brand-logo"><Logo size={32} /></div>
          <div className="admin-name">Dexvra<span>Admin</span></div>
        </div>
        <nav className="admin-tabs" aria-label="Admin sections">
          {(Object.keys(TAB_LABEL) as AdminTab[]).map((t) => (
            <button key={t} className={`atab ${tab === t ? "on" : ""}`} aria-current={tab === t ? "page" : undefined} onClick={() => go(t)}>
              {TAB_LABEL[t]}
              {badge[t] ? <span className={`atab-n ${t === "review" ? "warn" : ""}`}>{badge[t]}</span> : null}
            </button>
          ))}
        </nav>
        <div className="admin-top-actions">
          <a className="abtn" href="https://dexvra.io" target="_blank" rel="noopener noreferrer">Site ↗</a>
          <button className="abtn bad" onClick={logout}>Log out</button>
        </div>
      </header>

      <div className="admin-wrap">
        {loadErr && <div className="a-note err">{loadErr} <button className="abtn" onClick={load}>Retry</button></div>}
        {note && (
          <div className={`a-note ${note.kind}`} role={note.kind === "err" ? "alert" : "status"}>
            {note.text}
            <button className="a-note-x" onClick={() => setNote(null)} aria-label="Dismiss">×</button>
          </div>
        )}

        {tab === "review" && (
          <>
            <div className="admin-stats">
              <button className="astat" onClick={() => openListings({})}>
                <div className="k">Listings</div><div className="v">{rows ? counts.total : "…"}</div>
              </button>
              <button className="astat" onClick={() => openListings({ status: "approved" })}>
                <div className="k">Live</div><div className="v">{rows ? counts.approved : "…"}</div>
              </button>
              <button className="astat pend" onClick={() => openListings({ status: "pending" })}>
                <div className="k">Pending</div><div className="v">{rows ? counts.pending : "…"}</div>
              </button>
              <button className="astat" onClick={() => openListings({ status: "trending" })}>
                <div className="k">Trending now</div><div className="v">{rows ? counts.trending : "…"}</div>
              </button>
            </div>

            <section className="asec">
              <div className="asec-h">
                Pending submissions <span className="cnt">{pending.length}</span>
                {pending.length > 1 && (
                  <div className="asec-h-tools">
                    <button className="abtn bad" disabled={busy != null} onClick={rejectAll}>
                      {busy === "__all" ? "Rejecting…" : `Reject all ${pending.length}`}
                    </button>
                  </div>
                )}
              </div>
              <div className="asec-body">
                {rows == null ? (
                  <div className="a-chain">Loading…</div>
                ) : pending.length === 0 ? (
                  <div className="a-empty">Nothing waiting for review.</div>
                ) : (
                  <div className="a-list">
                    {pending.map((r) => {
                      const links = [
                        ["Website", r.website],
                        ["X", r.twitter],
                        ["Telegram", r.telegram],
                      ].filter(([, u]) => u) as [string, string][];
                      return (
                        <div className="a-item" key={r.id}>
                          <div className="a-item-main">
                            <div className="a-sym-t">
                              {r.emoji} {r.sym} <span className="a-chain">{r.name}</span>
                            </div>
                            <div className="a-chain">
                              {CHAINS[r.chain]?.label ?? r.chain} · asked for {tierLabel(r.tier)} ·{" "}
                              {arrivedAt(r) ? `${fmtAge((now - arrivedAt(r)) / 60_000)} ago` : "—"}
                              {links.length ? " · " : ""}
                              {links.map(([k, u], i) => (
                                <span key={k}>
                                  {i ? " · " : ""}
                                  <a href={u} target="_blank" rel="noopener noreferrer nofollow">{k} ↗</a>
                                </span>
                              ))}
                            </div>
                            <div className="a-ca" title={r.address}>{r.address}</div>
                          </div>
                          <div className="a-item-act">
                            <button className="abtn ok" disabled={busy != null} onClick={() => actions.setStatus(r.id, "approved")}>Approve</button>
                            <button className="abtn bad" disabled={busy != null} onClick={() => actions.setStatus(r.id, "rejected")}>Reject</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          </>
        )}

        {tab === "listings" && <ListingsTable rows={rows} busy={busy} filter={filter} setFilter={setFilter} actions={actions} />}

        {tab === "pons" && <PonsQueue onListed={load} />}

        {tab === "add" && (
          <AddListingForm
            onAdded={async (sym) => {
              await load();
              setNote({ kind: "ok", text: `${sym} added — live on the site` });
            }}
          />
        )}

        {tab === "site" && (
          <>
            <PromoManager />
            <BannerManager />
            <ChannelBannerManager />
          </>
        )}
      </div>
    </>
  );
}
