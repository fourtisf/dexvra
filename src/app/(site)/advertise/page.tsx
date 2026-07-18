"use client";

import { useState, type CSSProperties } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { ChainLogo } from "@/components/ChainLogo";
import { CHAINS, CHAIN_IDS } from "@/config/chains";
import {
  BANNERS,
  LISTING_TIERS,
  fmtNative,
  fmtUsd,
  nativeOf,
  tierPrice,
  trendingForChain,
} from "@/lib/packages";

export default function AdvertisePage() {
  const { toast, openListing } = useApp();
  const [chain, setChain] = useState("solana");
  const native = nativeOf(chain);
  const trending = trendingForChain(chain);

  return (
    <section className="view">
      <PageHead
        icon="📢"
        title="Packages"
        sub="List, trend, and get seen. Every package is billed in the chain's own coin — pay on Solana in SOL, on BSC in BNB, on ETH/Base in ETH."
      />

      {/* Chain selector — drives which native prices are shown */}
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

      {/* ── Listing packages ─────────────────────────────────────────── */}
      <h3 className="pkg-h">Listing Packages</h3>
      <p className="pkg-sub">
        A one-time listing on Dexvra. Higher tiers get better placement, the verified badge, and an
        announcement post. Your token carries its tier tag everywhere.
      </p>
      <div className="pkg-grid">
        {LISTING_TIERS.map((tier) => {
          const price = tierPrice(tier.key, chain);
          const perks = tier.instant
            ? ["Instant activation", "Listed on TG + trending board", "Priority verification"]
            : [
                tier.rank <= 3 ? "Announcement post" : "Standard board listing",
                tier.rank <= 3 ? "Verified badge" : "Search + discovery indexed",
                `Tier #${tier.rank} placement`,
              ];
          return (
            <div
              className={`pkg ${tier.rank === 1 ? "featured" : ""}`}
              key={tier.key}
              style={{ "--tc": tier.color } as CSSProperties}
            >
              {tier.rank === 1 && <span className="pkg-flag">TOP TIER</span>}
              {tier.instant && <span className="pkg-flag alt">INSTANT</span>}
              <div className="pkg-name">
                <span className="pkg-glyph">{tier.glyph}</span>
                {tier.label}
                {tier.rank > 0 && <span className="pkg-rank">#{tier.rank}</span>}
              </div>
              <div className="pkg-price">
                {price != null ? fmtNative(price, native) : "—"}
              </div>
              <ul className="pkg-perks">
                {perks.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <button className="btn-primary pkg-cta" onClick={openListing}>
                List with {tier.label}
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Trending packages ────────────────────────────────────────── */}
      <h3 className="pkg-h">
        Trending — <span style={{ color: CHAINS[chain].color }}>{CHAINS[chain].label}</span>
      </h3>
      <p className="pkg-sub">
        Time-boxed featured slots on the Trending board. Longer runs discount. 24H &amp; 48H are also
        posted to the announcement channel.
      </p>
      <div className="ptable-wrap">
        <table className="ptable">
          <thead>
            <tr>
              <th>Duration</th>
              <th>Price</th>
              <th>Discount</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {trending.map((r) => (
              <tr key={r.duration}>
                <td className="pt-dur">{r.duration}</td>
                <td className="pt-price">{fmtNative(r.price, native)}</td>
                <td>{r.discount > 0 ? <span className="pt-off">−{r.discount}%</span> : <span className="pt-dim">—</span>}</td>
                <td className="pt-cta">
                  <button
                    className="btn-ghost2 sm"
                    onClick={() => toast(`Trending ${r.duration} · ${fmtNative(r.price, native)} — we'll reach out on TG 📩`)}
                  >
                    Book
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Banner ads ───────────────────────────────────────────────── */}
      <h3 className="pkg-h">Banner Ads</h3>
      <p className="pkg-sub">Rotating homepage banner slots, billed in USD by run length.</p>
      <div className="banner-grid">
        {BANNERS.map((b) => (
          <div className="pkg banner-card" key={b.name}>
            <div className="pkg-name">{b.name}</div>
            <div className="banner-size">{b.size}px</div>
            <table className="ptable flush">
              <tbody>
                {b.rows.map((r) => (
                  <tr key={r.duration}>
                    <td className="pt-dur">{r.duration}</td>
                    <td className="pt-price">{fmtUsd(r.usd)}</td>
                    <td><span className="pt-off">−{r.discount}%</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              className="btn-ghost2 pkg-cta"
              onClick={() => toast(`"${b.name}" requested — we'll reach out on TG 📩`)}
            >
              Book banner
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
