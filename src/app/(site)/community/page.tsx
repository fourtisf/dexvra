import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { BRAND_DOMAIN, BRAND_NAME } from "@/config/brand";
import { SOCIALS, type SocialKind } from "@/config/socials";

export const metadata: Metadata = {
  title: `${BRAND_NAME} — Community`,
  description: `Every official ${BRAND_NAME} account: listing and trending alerts, announcements, the community group, the listing bot, the trading bot, and X.`,
};

// Inline so the page has no runtime dependency and renders as static HTML.
// A group and a bot get their own marks: they are different things to join, and
// five identical paper planes would tell a reader nothing about which is which.
function Icon({ kind }: { kind: SocialKind }) {
  if (kind === "x") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.2 2h3.3l-7.2 8.3L23 22h-6.7l-5.2-6.8L5.1 22H1.8l7.7-8.8L1 2h6.8l4.7 6.2L18.2 2zm-1.2 18h1.8L7.1 3.9H5.2L17 20z" />
      </svg>
    );
  }
  if (kind === "group") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <circle cx="9" cy="8.5" r="3.2" />
        <path d="M2.8 19.5c1-2.9 3.3-4.3 6.2-4.3s5.2 1.4 6.2 4.3" />
        <circle cx="17" cy="7" r="2.4" />
        <path d="M17 12.2c2 .1 3.5 1.2 4.2 3.1" />
      </svg>
    );
  }
  if (kind === "bot") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <rect x="4" y="8" width="16" height="11" rx="3.2" />
        <path d="M12 8V4.8M9.5 13v1.4M14.5 13v1.4M2.5 12.5v3M21.5 12.5v3" />
        <circle cx="12" cy="4" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21.9 4.3 18.9 19c-.2 1-.8 1.2-1.7.8l-4.6-3.4-2.2 2.2c-.3.3-.5.4-.9.4l.3-4.7 8.5-7.7c.4-.3-.1-.5-.6-.2L7.2 12.9 2.6 11.5c-1-.3-1-1 .2-1.5l18-6.9c.8-.3 1.5.2 1.1 1.2z" />
    </svg>
  );
}

export default function CommunityPage() {
  return (
    <section className="view">
      <PageHead
        icon="📣"
        title="Community"
        sub={`Every official ${BRAND_NAME} account: what each one posts, where projects buy listings and trending slots, and which bot trades tokens.`}
      />

      <div className="soc-grid">
        {SOCIALS.map((s) => (
          <a
            key={s.key}
            className={`soc-card ${s.kind}${s.primary ? " primary" : ""}`}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="soc-ic">
              <Icon kind={s.kind} />
            </span>
            <span className="soc-body">
              <span className="soc-name">
                {s.name}
                {s.primary && <span className="soc-tag">START HERE</span>}
              </span>
              <span className="soc-handle">{s.handle}</span>
              <span className="soc-blurb">{s.blurb}</span>
            </span>
            <span className="soc-go" aria-hidden="true">↗</span>
          </a>
        ))}
      </div>

      {/* Impersonation is the standard scam against a listing site: a lookalike
          channel messages a project mid-listing and asks for a "fee". Naming the
          real handles in one place is the cheapest defence there is.

          The two sentences are kept separate on purpose. Folding "outside
          @dexvrabot" into the list of things Dexvra never asks for reads, on a
          plain parse, as "inside the bot we DO ask for your seed phrase". */}
      <div className="panel soc-note">
        <b>⚠️ Beware of impersonators.</b> {BRAND_NAME} never sends the first direct message, and never
        asks for an extra fee, a wallet key or a seed phrase. <b>@dexvrabot</b> quotes every price and
        generates every payment address, and the accounts listed on this page — all linked from{" "}
        <b>{BRAND_DOMAIN}</b> — are the only official ones.
      </div>
    </section>
  );
}
