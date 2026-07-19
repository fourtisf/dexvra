"use client";

// Admin panel section: homepage banner manager. Upload an image, set the
// click-through link (+ optional title & duration) → it becomes the carousel's
// sponsored slide immediately. Existing bookings (bot-paid or admin) are
// listed with live/expired state and can be removed.
import { useCallback, useEffect, useState } from "react";

type Row = {
  id: string;
  imageUrl: string;
  linkUrl: string;
  title?: string;
  slot: string;
  startsAt: number;
  endsAt: number;
  source?: string;
  active?: boolean;
};

const emptyForm = { imageUrl: "", linkUrl: "", title: "", days: "30" };

export function BannerManager() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [err, setErr] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/banners", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      setRows(j.banners ?? []);
    } catch {
      /* section stays in loading state */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/admin/upload", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.url) setForm((s) => ({ ...s, imageUrl: j.url }));
      else setErr(j.error || "Upload failed");
    } catch {
      setErr("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const create = async () => {
    setSaving(true);
    setErr("");
    try {
      const r = await fetch("/api/admin/banners", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, days: Number(form.days) || 30 }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.error || "Failed to save banner");
        return;
      }
      setForm(emptyForm);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    try {
      await fetch(`/api/admin/banners?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((s) => ({ ...s, [k]: e.target.value }));

  const live = (rows ?? []).filter((r) => r.active);

  return (
    <section className="asec">
      <div className="asec-h">
        Homepage banner <span className="cnt">{live.length} live</span>
      </div>
      <div className="asec-body">
        <div className="a-chain" style={{ marginBottom: 12 }}>
          The newest live banner shows in the homepage carousel; clicking it opens the target link in a new tab.
        </div>

        {/* create */}
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "end", marginBottom: 8 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="a-chain">Banner image</span>
            {form.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={form.imageUrl} alt="banner preview" style={{ maxHeight: 72, borderRadius: 8, objectFit: "cover", border: "1px solid rgba(255,255,255,.12)" }} />
            ) : null}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={upload} disabled={uploading} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="a-chain">Target link (opens on click)</span>
            <input placeholder="https://t.me/yourproject or https://…" value={form.linkUrl} onChange={set("linkUrl")} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="a-chain">Title (optional)</span>
            <input placeholder="Project name" value={form.title} onChange={set("title")} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="a-chain">Duration (days)</span>
            <input type="number" min={1} max={3650} value={form.days} onChange={set("days")} />
          </label>
          <button className="abtn" onClick={create} disabled={saving || uploading || !form.imageUrl || !form.linkUrl}>
            {uploading ? "Uploading…" : saving ? "Saving…" : "➕ Set banner"}
          </button>
        </div>
        {err && <div className="login-err">{err}</div>}

        {/* existing */}
        {rows == null ? (
          <div className="a-chain">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="a-chain">No banners yet.</div>
        ) : (
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {rows.map((r) => (
              <div key={r.id} style={{ display: "flex", gap: 12, alignItems: "center", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, padding: 8 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={r.imageUrl} alt="" style={{ width: 120, height: 44, objectFit: "cover", borderRadius: 6 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {r.title || r.slot} {r.active ? <span style={{ color: "#4EE6A8" }}>· LIVE</span> : <span className="a-chain">· ended</span>}
                    {r.source ? <span className="a-chain"> · {r.source}</span> : null}
                  </div>
                  <a href={r.linkUrl} target="_blank" rel="noopener noreferrer" className="a-chain" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.linkUrl}
                  </a>
                  <div className="a-chain">until {new Date(r.endsAt).toLocaleString()}</div>
                </div>
                <button className="abtn bad" onClick={() => remove(r.id)} disabled={busy === r.id}>
                  {busy === r.id ? "…" : "🗑 Remove"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
