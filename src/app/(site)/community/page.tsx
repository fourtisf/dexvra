import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { BRAND_DOMAIN, BRAND_NAME } from "@/config/brand";
import { SOCIALS, type SocialKind } from "@/config/socials";

export const metadata: Metadata = {
  title: `${BRAND_NAME} — Community`,
  description: `Every official ${BRAND_NAME} channel: Telegram announcements, listing and trending alerts, the bot, and X.`,
};

// Inline so the page has no runtime dependency and renders as static HTML.
function Icon({ kind }: { kind: SocialKind }) {
  if (kind === "x") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.2 2h3.3l-7.2 8.3L23 22h-6.7l-5.2-6.8L5.1 22H1.8l7.7-8.8L1 2h6.8l4.7 6.2L18.2 2zm-1.2 18h1.8L7.1 3.9H5.2L17 20z" />
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
        sub={`Every official ${BRAND_NAME} channel. Anything not on this page is not us — check the handle before you trust it.`}
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
          channel DMs a project mid-listing and asks for a "fee". Naming the real
          handles in one place is the cheapest defence there is. */}
      <div className="panel soc-note">
        <b>⚠️ Beware of impersonators.</b> {BRAND_NAME} will never DM you first, never ask for your seed
        phrase, and never take payment outside <b>@dexvrabot</b>. Every real channel is listed above and
        linked from <b>{BRAND_DOMAIN}</b>.
      </div>
    </section>
  );
}
