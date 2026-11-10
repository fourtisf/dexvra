"use client";

// Admin console — the Add tab: create a listing by hand. It goes live at once
// (the route stores it approved). It used to sit at the very bottom of the one
// long page, under ~700 rows of listings.
import { useState } from "react";
import type { ListingTier } from "@/lib/types";
import { CHAIN_IDS, CHAINS } from "@/config/chains";
import { LISTING_TIERS, tierLabel } from "@/lib/packages";

const empty = {
  chain: "solana",
  address: "",
  sym: "",
  name: "",
  emoji: "",
  tier: "DIAMOND" as ListingTier,
  logoUrl: "",
  website: "",
  twitter: "",
  telegram: "",
};

export function AddListingForm({ onAdded }: { onAdded: (sym: string) => Promise<void> }) {
  const [add, setAdd] = useState(empty);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);

  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setAdd((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setAdding(true);
    try {
      const r = await fetch("/api/admin/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(add),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.error || `Could not add listing (HTTP ${r.status})`);
        return;
      }
      const sym = add.sym;
      setAdd(empty);
      await onAdded(sym);
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className="asec">
      <div className="asec-h">Add listing</div>
      <div className="asec-body">
        <form className="add-grid" onSubmit={submit}>
          <div className="add-fld">
            <label>Chain</label>
            <select className="a-select" value={add.chain} onChange={set("chain")}>
              {CHAIN_IDS.map((id) => (<option key={id} value={id}>{CHAINS[id].label}</option>))}
            </select>
          </div>
          <div className="add-fld">
            <label>Ticker</label>
            <input className="a-input" value={add.sym} onChange={set("sym")} placeholder="BONK" required />
          </div>
          <div className="add-fld">
            <label>Name</label>
            <input className="a-input" value={add.name} onChange={set("name")} placeholder="Bonk" />
          </div>
          <div className="add-fld">
            <label>Tier</label>
            <select className="a-select" value={add.tier} onChange={set("tier")}>
              {LISTING_TIERS.map((t) => (<option key={t.key} value={t.key}>{tierLabel(t.key)}</option>))}
            </select>
          </div>
          <div className="add-fld wide">
            <label>Contract address</label>
            <input className="a-input" value={add.address} onChange={set("address")} placeholder="Paste the contract address" required />
          </div>
          <div className="add-fld">
            <label>Emoji</label>
            <input className="a-input" value={add.emoji} onChange={set("emoji")} placeholder="🐕" maxLength={4} />
          </div>
          <div className="add-fld wide">
            <label>Logo image URL (optional)</label>
            <input className="a-input" value={add.logoUrl} onChange={set("logoUrl")} placeholder="https://…/logo.png" />
          </div>
          <div className="add-fld">
            <label>Website</label>
            <input className="a-input" value={add.website} onChange={set("website")} placeholder="https://…" />
          </div>
          <div className="add-fld">
            <label>X / Twitter</label>
            <input className="a-input" value={add.twitter} onChange={set("twitter")} placeholder="https://x.com/…" />
          </div>
          <div className="add-fld">
            <label>Telegram</label>
            <input className="a-input" value={add.telegram} onChange={set("telegram")} placeholder="https://t.me/…" />
          </div>
          {err && <div className="add-fld wide"><div className="login-err a-note-err">{err}</div></div>}
          <div className="add-fld wide">
            <button className="abtn p" type="submit" disabled={adding} style={{ padding: "10px 18px", justifySelf: "start" }}>
              {adding ? "Adding…" : "Add listing (goes live)"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
