import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { BRAND_DOMAIN, BRAND_NAME, SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/config/brand";
import { SOCIALS } from "@/config/socials";
import { SocialIcon } from "@/components/SocialIcon";

import { pageMetadata } from "@/lib/seo";

// Through the shared helper so this page gets the canonical and the social card
// every other page now gets — it had a title and description and nothing else.
export const metadata: Metadata = pageMetadata({
  title: "Community",
  description: `Every official ${BRAND_NAME} account: listing and trending alerts, announcements, the community group, the listing bot, the trading bot, X and YouTube.`,
  path: "/community",
});

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
              <SocialIcon kind={s.kind} />
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

        {/* Where to WRITE. It sits in the grid as a card — the first cut put it
            in a note below the grid, and on a laptop the grid fills the screen,
            so "the email is not on the community page" was the first report
            ("tmbhkkakn di community juga"). Last, because the accounts above are
            where to start; a mailto, so no target=_blank. */}
        <a key="support" className="soc-card email" href={SUPPORT_MAILTO}>
          <span className="soc-ic">
            <SocialIcon kind="email" />
          </span>
          <span className="soc-body">
            <span className="soc-name">Support</span>
            <span className="soc-handle">{SUPPORT_EMAIL}</span>
            <span className="soc-blurb">
              Questions about a listing, a payment or the bots. This is the only {BRAND_NAME} email address.
            </span>
          </span>
          <span className="soc-go" aria-hidden="true">✉</span>
        </a>
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
        <b>{BRAND_DOMAIN}</b> — and the support address beside them are the only official ones.
      </div>
    </section>
  );
}
