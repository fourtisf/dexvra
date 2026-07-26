import { PageHead } from "@/components/PageHead";
import { BOT_URL, BRAND_NAME, TELEGRAM_HANDLE, TELEGRAM_URL, X_URL } from "@/config/brand";

export default function VerifiedPage() {
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
          {/* This was a button that popped "Verification request sent ✓" and
              sent nothing anywhere — the applicant went away believing they had
              applied. Verification is handled by a human over Telegram, so the
              CTA goes where the work actually happens, exactly like /advertise. */}
          <a
            className="btn-primary"
            style={{ marginLeft: "auto" }}
            href={BOT_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            ✅ Apply for verification
          </a>
        </div>
        <div className="verify-contact">
          Questions first? Reach {BRAND_NAME} on{" "}
          <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">Telegram {TELEGRAM_HANDLE}</a>
          {" · "}
          <a href={X_URL} target="_blank" rel="noopener noreferrer">X</a>
        </div>
      </div>
    </section>
  );
}
