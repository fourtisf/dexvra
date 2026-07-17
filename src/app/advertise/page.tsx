"use client";

import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";

const SLOTS = [
  { name: "Ticker Priority", price: "1 SOL", perks: ["Top ranked ticker spot", "Highlighted symbol", "All pages"], popular: false },
  { name: "Carousel Takeover", price: "3 SOL", perks: ["Your own homepage slide", "Custom art & CTA", "Auto-rotating exposure"], popular: true },
  { name: "Full Network", price: "6 SOL", perks: ["Carousel + ticker + wire", "Pulse card mention", "Cross-tool reach"], popular: false },
];

export default function AdvertisePage() {
  const { toast } = useApp();
  return (
    <section className="view">
      <PageHead icon="📢" title="Advertise" sub="Put your token in front of 40K+ daily degens. Slots are limited by design." />
      <div className="slot-grid">
        {SLOTS.map((s) => (
          <div className={`tier ${s.popular ? "sel" : ""}`} key={s.name}>
            {s.popular && <span className="pop">POPULAR</span>}
            <div className="tname">{s.name}</div>
            <div className="tprice">
              {s.price} <span style={{ fontSize: 10, color: "var(--faint)" }}>/ 24h</span>
            </div>
            <ul>
              {s.perks.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <button
              className={s.popular ? "btn-primary" : "btn-ghost2"}
              style={{ marginTop: 12, width: "100%", justifyContent: "center" }}
              onClick={() => toast(`"${s.name}" slot requested — we'll reach out on TG 📩`)}
            >
              Book slot
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
