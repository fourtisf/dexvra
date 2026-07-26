"use client";

import { useState, type CSSProperties } from "react";
import { PageHead } from "@/components/PageHead";
import { ChainLogo } from "@/components/ChainLogo";
import { BOT_URL, BRAND_NAME, TELEGRAM_HANDLE, TELEGRAM_URL, X_URL } from "@/config/brand";
import { CHAINS, CHAIN_IDS } from "@/config/chains";
import { LISTING_TIERS, fmtNative, nativeOf, tierPrice } from "@/lib/packages";

// This page used to sell verification on its own for "1.5 SOL / one-time" — a
// price that appears in no package on the site and in no product in the bot, so
// nothing could quote it and nothing could collect it. Worse, the verified badge
// is already included in Diamond, Gold and Platinum: a project that had just
// paid 5 SOL for Diamond read this page and concluded it owed another 1.5 SOL
// for a badge it already had.
//
// The page now shows how verification is actually obtained — through the listing
// tiers — priced from the same LISTING_TIERS the bot charges from, in the
// chain's own coin, exactly like /advertise.
export default function VerifiedPage() {
  const [chain, setChain] = useState("solana");
  const native = nativeOf(chain);
  const withBadge = LISTING_TIERS.filter((t) => t.verified);
  const xpress = LISTING_TIERS.find((t) => t.instant);
  const xpressPrice = xpress ? tierPrice(xpress.key, chain) : null;

  return (
    <section className="view">
      <PageHead
        icon="✅"
        title="Get Verified"
        sub={`The green check tells traders your project passed ${BRAND_NAME} review. It comes with the top listing tiers — there is no separate fee.`}
      />

      <div className="chain-pick" role="tablist" aria-label="Choose chain">
        {CHAIN_IDS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={chain === id}
            className={`chip-chain ${chain === id ? "on" : ""}`}
            onClick={() => setChain(id)}
          >
            <ChainLogo chain={id} size={16} />
            {CHAINS[id].label}
            <span className="cc-native">{nativeOf(id)}</span>
          </button>
        ))}
      </div>

      <div className="panel" style={{ maxWidth: 720 }}>
        <div className="check-list">
          <div className="check">✓ Team identity reviewed by {BRAND_NAME}<span className="cv ok">INCLUDED</span></div>
          <div className="check">✓ Contract &amp; LP lock checked on-chain<span className="cv ok">INCLUDED</span></div>
          <div className="check">✓ Verified badge on every board &amp; ticker<span className="cv ok">INCLUDED</span></div>
          <div className="check">✓ Announcement post on Telegram &amp; X<span className="cv ok">INCLUDED</span></div>
        </div>
      </div>

      <h3 className="pkg-h">Tiers that include verification</h3>
      <p className="pkg-sub">
        Priced in {CHAINS[chain].label}&rsquo;s own coin. These are the same tiers at the same prices that{" "}
        <b>@dexvrabot</b> charges — this page and the bot read one list.
      </p>
      <div className="pkg-grid">
        {withBadge.map((tier) => {
          const price = tierPrice(tier.key, chain);
          return (
            <div
              className={`pkg ${tier.rank === 1 ? "featured" : ""}`}
              key={tier.key}
              style={{ "--tc": tier.color } as CSSProperties}
            >
              {tier.rank === 1 && <span className="pkg-flag">TOP TIER</span>}
              <div className="pkg-name">
                <span className="pkg-glyph">{tier.glyph}</span>
                {tier.label}
                <span className="pkg-rank">#{tier.rank}</span>
              </div>
              <div className="pkg-price">{price != null ? fmtNative(price, native) : "—"}</div>
              <ul className="pkg-perks">
                <li>Verified badge</li>
                <li>Announcement post</li>
                <li>Tier #{tier.rank} placement</li>
              </ul>
              <a className="btn-primary pkg-cta" href={BOT_URL} target="_blank" rel="noopener noreferrer">
                List with {tier.label}
              </a>
            </div>
          );
        })}
      </div>

      {xpress && (
        <div className="panel soc-note" style={{ marginTop: 14 }}>
          <b>Listed on a lower tier already?</b> Silver and Bronze do not carry the badge.{" "}
          {xpress.label} ({xpressPrice != null ? fmtNative(xpressPrice, native) : "—"}) lists you instantly
          and puts you in the review queue first, but the badge itself comes with{" "}
          {withBadge.map((t) => t.label).join(", ")}. Message us on Telegram and we will tell you what an
          upgrade costs from where you are.
        </div>
      )}

      <div className="verify-contact">
        Questions first? Reach {BRAND_NAME} on{" "}
        <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">Telegram {TELEGRAM_HANDLE}</a>
        {" · "}
        <a href={X_URL} target="_blank" rel="noopener noreferrer">X</a>
      </div>
    </section>
  );
}
