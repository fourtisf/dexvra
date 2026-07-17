"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CHAINS, CHAIN_IDS } from "@/config/chains";
import { useApp } from "./AppState";

const TIERS = [
  { name: "Trench", price: "0.5 SOL", perks: ["Live within 24h", "All Coins listing", "Search indexed"] },
  { name: "Express", price: "2 SOL", perks: ["Live within 1h", "Ticker mention", "New Pairs highlight"], popular: true },
  { name: "Fast-Track", price: "5 SOL", perks: ["Live instantly", "Homepage spotlight", "1-day carousel slot"] },
];

const URL_RE = /^https?:\/\/[^\s]+$/i;

const emptyForm = {
  name: "",
  sym: "",
  chain: "solana",
  emoji: "",
  ca: "",
  x: "",
  tg: "",
};

export function ListingModal() {
  const { listingOpen, closeListing, addListing, toast } = useApp();
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(emptyForm);
  const [tier, setTier] = useState(TIERS[1]);

  if (!listingOpen) return null;

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const close = () => {
    closeListing();
    setStep(1);
  };

  const next1 = () => {
    if (!form.name.trim() || !form.sym.trim() || !form.ca.trim()) {
      toast("Fill in name, ticker, and CA first 🙏");
      return;
    }
    if (!CHAINS[form.chain].addressPattern.test(form.ca.trim())) {
      toast(`That doesn't look like a ${CHAINS[form.chain].label} address 🤔`);
      return;
    }
    for (const [v, label] of [[form.x, "X"], [form.tg, "Telegram"]] as const) {
      if (v.trim() && !URL_RE.test(v.trim())) {
        toast(`${label} link must be a full https:// URL`);
        return;
      }
    }
    setStep(2);
  };

  const pay = () => {
    // Phase 1 stores locally; real SOL payment + tx-signature verification is Phase 3.
    addListing({
      symbol: "$" + form.sym.trim().toUpperCase().replace(/^\$+/, ""),
      name: form.name.trim(),
      emoji: form.emoji.trim() || "🆕",
      chain: form.chain,
      tier: tier.name,
      status: "IN REVIEW",
    });
    setStep(4);
  };

  const ca = form.ca.trim();

  return (
    <div className="modal-ov on" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="modal">
        <button className="modal-x" onClick={close}>✕</button>
        <div className="m-title">⚡ List your token</div>
        <div className="stepdots">
          {[1, 2, 3].map((i) => (
            <span key={i} className={`sdot ${i <= Math.min(step, 3) ? "on" : ""}`} />
          ))}
        </div>

        {step === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="frow">
              <div className="fld"><label>Token name</label><input value={form.name} onChange={set("name")} placeholder="e.g. Trench Cat" /></div>
              <div className="fld"><label>Ticker</label><input value={form.sym} onChange={set("sym")} placeholder="e.g. TRENCHCAT" /></div>
            </div>
            <div className="frow">
              <div className="fld">
                <label>Chain</label>
                <select value={form.chain} onChange={set("chain")}>
                  {CHAIN_IDS.map((id) => (
                    <option key={id} value={id}>{CHAINS[id].label}</option>
                  ))}
                </select>
              </div>
              <div className="fld"><label>Logo (emoji for now)</label><input value={form.emoji} onChange={set("emoji")} placeholder="🐸" maxLength={4} /></div>
            </div>
            <div className="fld"><label>Contract address</label><input value={form.ca} onChange={set("ca")} placeholder="Paste CA…" /></div>
            <div className="frow">
              <div className="fld"><label>X / Twitter</label><input value={form.x} onChange={set("x")} placeholder="https://x.com/…" /></div>
              <div className="fld"><label>Telegram</label><input value={form.tg} onChange={set("tg")} placeholder="https://t.me/…" /></div>
            </div>
            <div className="m-actions">
              <button className="btn-primary" onClick={next1}>Choose tier →</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="tier-grid">
              {TIERS.map((t) => (
                <div
                  key={t.name}
                  className={`tier ${tier.name === t.name ? "sel" : ""}`}
                  onClick={() => setTier(t)}
                >
                  {t.popular && <span className="pop">POPULAR</span>}
                  <div className="tname">{t.name}</div>
                  <div className="tprice">{t.price}</div>
                  <ul>
                    {t.perks.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="m-actions">
              <button className="btn-ghost2" onClick={() => setStep(1)}>← Back</button>
              <button className="btn-primary" onClick={() => setStep(3)}>Review →</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="check-list">
              <div className="check">
                Token
                <span className="cv ok" style={{ background: "none", color: "var(--text)" }}>
                  {form.emoji || "🆕"} {form.name} (${form.sym.toUpperCase().replace(/^\$+/, "")})
                </span>
              </div>
              <div className="check">
                Chain
                <span className="cv ok" style={{ background: "none", color: "var(--text)" }}>{CHAINS[form.chain].label}</span>
              </div>
              <div className="check">
                Contract
                <span className="cv ok" style={{ background: "none", color: "var(--muted)", fontSize: 10 }}>
                  {ca.slice(0, 8)}…{ca.slice(-6)}
                </span>
              </div>
              <div className="check">
                Tier
                <span className="cv ok">{tier.name} · {tier.price}</span>
              </div>
            </div>
            <div className="m-actions">
              <button className="btn-ghost2" onClick={() => setStep(2)}>← Back</button>
              <button className="btn-primary" onClick={pay}>Pay &amp; submit ⚡</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="success-wrap">
            <div className="success-ic">✓</div>
            <div className="m-title" style={{ justifyContent: "center" }}>Submission received!</div>
            <p style={{ color: "var(--muted)", fontSize: 13, maxWidth: "38ch" }}>
              Your token is in the review queue. Track its status anytime from your account.
            </p>
            <div className="m-actions" style={{ justifyContent: "center", width: "100%" }}>
              <button className="btn-ghost2" onClick={close}>Close</button>
              <button
                className="btn-primary"
                onClick={() => {
                  close();
                  router.push("/account");
                }}
              >
                View my listings →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
