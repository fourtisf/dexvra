"use client";

// Admin console — the Listings tab. One compact row per listing (token, tier,
// trending, status, age) and ONE button; everything that changes a listing
// lives in the Manage panel that button opens. It used to be nine controls on
// every one of ~700 rows, all rendered at once — the "terlalu banyak spam"
// this replaced. Rows are filtered, sorted newest first and paged through
// lib/adminView, which is where those rules are tested.
import { useEffect, useMemo, useState } from "react";
import type { StoredListing } from "@/lib/store";
import { CHAIN_IDS, CHAINS } from "@/config/chains";
import { FREE_TIER, LISTING_TIERS, tierLabel, tierMeta } from "@/lib/packages";
import { fmtAge } from "@/lib/format";
import {
  STATUS_FILTERS,
  arrivedAt,
  countListings,
  filterListings,
  isTrending,
  paginate,
  trendHoursLeft,
  type ListFilter,
  type StatusFilter,
} from "@/lib/adminView";

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

// The bot's own auto-listings sit on FREE, which no buyer can pick, so the
// public tier list leaves it out. Here it has to be IN the list: a <select>
// whose value matches no option shows its first one, so every free listing
// read "Diamond" in this console — and one tap would have upgraded it.
const TIER_OPTIONS = [...LISTING_TIERS, FREE_TIER];

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: "All",
  approved: "Live",
  pending: "Pending",
  rejected: "Unlisted",
  trending: "Trending",
  free: "Free (bot)",
};

export type ListingActions = {
  patch: (id: string, body: Record<string, unknown>) => Promise<boolean>;
  setStatus: (id: string, status: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  reload: () => Promise<void>;
};

type EditForm = { name: string; emoji: string; logoUrl: string; website: string; twitter: string; telegram: string; overview: string };

export function ListingsTable({
  rows,
  busy,
  filter,
  setFilter,
  actions,
}: {
  rows: StoredListing[] | null;
  busy: string | null;
  filter: ListFilter;
  setFilter: (f: ListFilter) => void;
  actions: ListingActions;
}) {
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  // "Now" ticks once a minute: the hours-left and age columns stay true
  // without every render getting a fresh clock (which would defeat the memos).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  // …and re-reads it whenever the rows reload: a slot just set to 5h, measured
  // against a clock up to a minute old, read "6h left".
  useEffect(() => setNow(Date.now()), [rows]);

  const all = useMemo(() => rows ?? [], [rows]);
  const counts = useMemo(() => countListings(all, now), [all, now]);
  const shown = useMemo(() => filterListings(all, filter, now), [all, filter, now]);
  const view = paginate(shown, page);

  // A new filter starts at the top of its own results.
  useEffect(() => setPage(1), [filter]);

  const chainsInUse = useMemo(() => CHAIN_IDS.filter((id) => all.some((r) => r.chain === id)), [all]);
  const set = (patch: Partial<ListFilter>) => setFilter({ ...filter, ...patch });
  const chipCount = (s: StatusFilter) => (s === "all" ? counts.total : counts[s]);

  return (
    <section className="asec">
      <div className="asec-h">
        Listings <span className="cnt">{shown.length === all.length ? all.length : `${shown.length} / ${all.length}`}</span>
      </div>

      <div className="a-toolbar">
        <input
          className="a-input a-search"
          value={filter.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Search ticker, name or contract…"
          aria-label="Search listings"
        />
        <select className="a-select a-narrow" value={filter.chain} onChange={(e) => set({ chain: e.target.value })} aria-label="Chain">
          <option value="all">All chains</option>
          {chainsInUse.map((id) => (
            <option key={id} value={id}>{CHAINS[id].label}</option>
          ))}
        </select>
        <select className="a-select a-narrow" value={filter.tier} onChange={(e) => set({ tier: e.target.value })} aria-label="Tier">
          <option value="all">All tiers</option>
          {TIER_OPTIONS.map((t) => (
            <option key={t.key} value={t.key}>{t.label}</option>
          ))}
        </select>
      </div>
      <div className="a-chips" role="tablist" aria-label="Status">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={filter.status === s}
            className={`a-chip ${filter.status === s ? "on" : ""}`}
            onClick={() => set({ status: s })}
          >
            {STATUS_LABEL[s]} <span>{chipCount(s)}</span>
          </button>
        ))}
      </div>

      {rows == null ? (
        <div className="asec-body a-chain">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="asec-body a-chain">Nothing matches this filter.</div>
      ) : (
        <>
          <div className="atable-wrap">
            <table className="atable compact">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Tier</th>
                  <th>Trending</th>
                  <th>Status</th>
                  <th>Added</th>
                  <th aria-label="Actions"></th>
                </tr>
              </thead>
              <tbody>
                {view.items.flatMap((r) => {
                  const left = trendHoursLeft(r, now);
                  const t = tierMeta(r.tier);
                  const open = openId === r.id;
                  const out = [
                    <tr key={r.id} className={open ? "is-open" : ""}>
                      <td>
                        <div className="a-sym">
                          <span className="a-logo">
                            {r.logoUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={r.logoUrl} alt="" loading="lazy" />
                            ) : (
                              r.emoji
                            )}
                          </span>
                          <span className="a-sym-t">{r.sym}</span>
                        </div>
                        <div className="a-chain">
                          {r.name} · {CHAINS[r.chain]?.label ?? r.chain} ·{" "}
                          <span className="a-ca" title={r.address}>{short(r.address)}</span>
                        </div>
                      </td>
                      <td>
                        <span className="a-tier" style={{ color: t?.color }}>{tierLabel(r.tier)}</span>
                      </td>
                      <td>
                        {left != null ? (
                          <span className="a-trend">{left}h left</span>
                        ) : isTrending(r, now) ? (
                          <span className="a-trend">no end</span>
                        ) : r.trendingRank != null && r.status === "approved" ? (
                          <span className="a-chain">ended</span>
                        ) : (
                          <span className="a-chain">—</span>
                        )}
                      </td>
                      <td><span className={`a-status ${r.status}`}>{STATUS_LABEL[r.status as StatusFilter] ?? r.status}</span></td>
                      <td className="a-chain">{arrivedAt(r) ? fmtAge((now - arrivedAt(r)) / 60_000) : "—"}</td>
                      <td className="a-right">
                        <button className={`abtn ${open ? "p" : ""}`} onClick={() => setOpenId(open ? null : r.id)} aria-expanded={open}>
                          {open ? "Close" : "Manage"}
                        </button>
                      </td>
                    </tr>,
                  ];
                  if (open) {
                    out.push(
                      <tr className="edit-row" key={`${r.id}-m`}>
                        <td colSpan={6}>
                          <ManagePanel row={r} busy={busy === r.id} actions={actions} onClose={() => setOpenId(null)} />
                        </td>
                      </tr>,
                    );
                  }
                  return out;
                })}
              </tbody>
            </table>
          </div>

          <div className="a-pager">
            <span className="a-chain">
              {view.from}–{view.to} of {view.total}
            </span>
            <div className="a-pager-btns">
              <button className="abtn" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)}>← Prev</button>
              <span className="a-chain">Page {view.page} / {view.pages}</span>
              <button className="abtn" disabled={view.page >= view.pages} onClick={() => setPage(view.page + 1)}>Next →</button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** Everything that changes ONE listing, in one place: tier, trending window,
 *  status, delete, and the profile fields. */
function ManagePanel({
  row: r,
  busy,
  actions,
  onClose,
}: {
  row: StoredListing;
  busy: boolean;
  actions: ListingActions;
  onClose: () => void;
}) {
  const now = Date.now();
  const left = trendHoursLeft(r, now);
  const [hrs, setHrs] = useState(left != null ? String(left) : "24");
  const [ef, setEf] = useState<EditForm>({
    name: r.name ?? "",
    emoji: r.emoji ?? "",
    logoUrl: r.logoUrl ?? "",
    website: r.website ?? "",
    twitter: r.twitter ?? "",
    telegram: r.telegram ?? "",
    overview: r.overview ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);

  const setE = (k: keyof EditForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setSaved(false);
    setEf((s) => ({ ...s, [k]: e.target.value }));
  };

  // Run a trending slot for N hours (0 / empty clears it). Stamps a real
  // window so the site and the bot's sweeper honour it, not just a flag.
  const setTrend = (raw: string) => {
    const h = Math.max(0, Math.round(Number(raw) || 0));
    if (!h) return actions.patch(r.id, { trendingRank: null, trendStart: null, trendExp: null });
    const t = Date.now();
    return actions.patch(r.id, { trendingRank: r.trendingRank ?? 1, trendStart: t, trendExp: t + h * 3_600_000 });
  };

  const save = async () => {
    setSaving(true);
    setErr("");
    try {
      const res = await fetch(`/api/admin/listings/${r.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ef),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error || `Could not save (HTTP ${res.status})`);
        return;
      }
      setSaved(true);
      await actions.reload(); // the table shows the saved row
    } finally {
      setSaving(false);
    }
  };

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setUploading(true);
    setErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/upload", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.url) setEf((s) => ({ ...s, logoUrl: j.url }));
      else setErr(j.error || "Upload failed");
    } catch {
      setErr("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const onSite = `https://dexvra.io/token/${r.chain}/${r.address}`;

  return (
    <div className="edit-panel">
      <div className="m-quick">
        <div className="m-block">
          <label className="m-lbl">Tier</label>
          <select className="a-select" value={r.tier} disabled={busy} onChange={(e) => actions.patch(r.id, { tier: e.target.value })}>
            {TIER_OPTIONS.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
        </div>
        <div className="m-block">
          <label className="m-lbl">Trending {left != null ? `· ${left}h left` : ""}</label>
          <div className="m-row">
            <input
              type="number"
              min={1}
              className="a-input m-hrs"
              value={hrs}
              disabled={busy}
              onChange={(e) => setHrs(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setTrend(hrs)}
              aria-label="Trending hours"
            />
            <button className="abtn" disabled={busy} onClick={() => setTrend(hrs)}>
              {left != null ? "Reset to" : "Run for"} {Math.max(0, Math.round(Number(hrs) || 0)) || "—"}h
            </button>
            {r.trendingRank != null && (
              <button className="abtn" disabled={busy} onClick={() => setTrend("0")}>Stop</button>
            )}
          </div>
        </div>
        <div className="m-block">
          <label className="m-lbl">Status</label>
          <div className="m-row">
            {r.status !== "approved" ? (
              <button className="abtn ok" disabled={busy} onClick={() => actions.setStatus(r.id, "approved")}>Approve</button>
            ) : (
              <button className="abtn" disabled={busy} onClick={() => actions.setStatus(r.id, "rejected")}>Unlist</button>
            )}
            <a className="abtn" href={onSite} target="_blank" rel="noopener noreferrer">Open ↗</a>
          </div>
        </div>
        <div className="m-block m-danger">
          <label className="m-lbl">&nbsp;</label>
          <button className="abtn bad" disabled={busy} onClick={async () => (await actions.remove(r.id)) && onClose()}>Delete</button>
        </div>
      </div>

      <div className="m-contract">
        <span className="m-lbl">Contract</span> <code>{r.address}</code>
      </div>

      <div className="edit-grid">
        <div className="add-fld"><label>Name</label><input className="a-input" value={ef.name} onChange={setE("name")} /></div>
        <div className="add-fld"><label>Emoji (fallback)</label><input className="a-input" value={ef.emoji} onChange={setE("emoji")} maxLength={4} placeholder="🐕" /></div>
        <div className="add-fld">
          <label>Logo</label>
          <div className="logo-row">
            <div className="edit-logo-box">
              {ef.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={ef.logoUrl} alt="" />
              ) : (
                <span>{ef.emoji || "🪙"}</span>
              )}
            </div>
            <label className={`abtn upload-btn ${uploading ? "busy" : ""}`}>
              {uploading ? "Uploading…" : "Upload"}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={upload} hidden disabled={uploading} />
            </label>
          </div>
        </div>
        <div className="add-fld wide"><label>Logo URL</label><input className="a-input" value={ef.logoUrl} onChange={setE("logoUrl")} placeholder="https://…/logo.png — or upload above" /></div>
        <div className="add-fld"><label>Website</label><input className="a-input" value={ef.website} onChange={setE("website")} placeholder="https://…" /></div>
        <div className="add-fld"><label>X / Twitter</label><input className="a-input" value={ef.twitter} onChange={setE("twitter")} placeholder="https://x.com/…" /></div>
        <div className="add-fld"><label>Telegram</label><input className="a-input" value={ef.telegram} onChange={setE("telegram")} placeholder="https://t.me/…" /></div>
        <div className="add-fld wide">
          <label>Overview (token page + channel posts; empty = none)</label>
          <textarea className="a-input" rows={2} value={ef.overview} onChange={setE("overview")} placeholder="1–3 sentences about the project" />
        </div>
      </div>
      {err && <div className="login-err" style={{ textAlign: "left" }}>{err}</div>}
      <div className="edit-actions">
        <button className="abtn p" disabled={saving || uploading} onClick={save}>{saving ? "Saving…" : "Save profile"}</button>
        {saved && <span className="a-chain a-ok">Saved ✓</span>}
      </div>
    </div>
  );
}
