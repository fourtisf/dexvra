"use client";

import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { BRAND_NAME } from "@/config/brand";

export default function VerifiedPage() {
  const { toast } = useApp();
  return (
    <section className="view">
      <PageHead icon="✅" title="Get Verified" sub={`The green check tells degens your project passed ${BRAND_NAME} review.`} />
      <div className="panel" style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 4 }}>
        <div className="check-list">
          <div className="check">✓ Team identity reviewed by {BRAND_NAME}<span className="cv ok">INCLUDED</span></div>
          <div className="check">✓ Contract &amp; LP lock verified on-chain<span className="cv ok">INCLUDED</span></div>
          <div className="check">✓ Verified badge on every board &amp; ticker<span className="cv ok">INCLUDED</span></div>
          <div className="check">✓ Priority placement in search results<span className="cv ok">INCLUDED</span></div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
          <div style={{ fontFamily: "var(--fm)", fontWeight: 800, fontSize: 22, color: "var(--mint)" }}>
            1.5 SOL <span style={{ fontSize: 11, color: "var(--faint)" }}>/ one-time</span>
          </div>
          <button
            className="btn-primary"
            style={{ marginLeft: "auto" }}
            onClick={() => toast("Verification request sent ✓ — reviewed within 24h")}
          >
            ✅ Apply for verification
          </button>
        </div>
      </div>
    </section>
  );
}
