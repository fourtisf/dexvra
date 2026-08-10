"use client";

/**
 * What a token page shows for a contract nobody has listed yet.
 *
 * It used to be "This token isn't a Dexvra listing (yet). Only paid listings
 * appear here." plus a Back button — a dead end, and the wrong one to build:
 * every buy-bot alert links here, the buy bot is free and runs on ANY contract,
 * so the majority of visitors arriving on this page are looking at a token that
 * is not listed. They were told nothing about the token they came to see and
 * given no way to change that.
 *
 * So: the contract, the network, the live price and market cap that
 * GeckoTerminal already publishes about it, and the two things a visitor can
 * actually do — list it, or go look at what is listed.
 */

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { useApp } from "@/components/AppState";
import { ChainLogo } from "@/components/ChainLogo";
import { CHAINS } from "@/config/chains";
import { BOT_URL } from "@/config/socials";
import { BRAND_NAME } from "@/config/brand";
import { fmtCap, fmtPrice } from "@/lib/format";

interface Preview {
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  mcap: number | null;
  logoUrl: string | null;
  poolAddress: string | null;
}

export function UnlistedToken({ chain, address }: { chain: string; address: string }) {
  const { toast } = useApp();
  const [tok, setTok] = useState<Preview | null>(null);
  const [done, setDone] = useState(false);
  const c = CHAINS[chain];

  useEffect(() => {
    let live = true;
    if (!c || !address) {
      setDone(true);
      return;
    }
    fetch(`/api/token-preview?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`)
      .then((r) => r.json())
      .then((j) => {
        if (live) setTok(j?.token ?? null);
      })
      .catch(() => {})
      // `done` and not `!tok`: a contract GeckoTerminal has never seen answers
      // null, and that is an ANSWER. Keying the skeleton off the data would
      // spin forever on exactly the tokens this page exists for.
      .finally(() => live && setDone(true));
    return () => {
      live = false;
    };
  }, [chain, address, c]);

  const copyCa = () => {
    navigator.clipboard?.writeText(address).catch(() => {});
    toast("Contract address copied 📋");
  };

  const ticker = tok?.symbol ? `$${tok.symbol.replace(/^\$/, "")}` : null;

  return (
    <section className="view">
      <div className="panel unlisted">
        {tok?.logoUrl ? (
          // Unoptimized: the source is a third-party CDN we do not control and
          // cannot add to next.config's remote allow-list one memecoin at a time.
          <Image className="unlisted-logo" src={tok.logoUrl} alt="" width={72} height={72} unoptimized />
        ) : (
          <div className="unlisted-logo unlisted-logo-ph">{(tok?.symbol ?? "?").slice(0, 2).toUpperCase()}</div>
        )}

        <h1 className="unlisted-h">Token Not Yet Listed</h1>
        <p className="unlisted-p">
          {tok?.name ? <strong>{tok.name}</strong> : "This token"} hasn&apos;t been listed on{" "}
          <strong>{BRAND_NAME}</strong> yet. List it in under 2 minutes through our Telegram bot.
        </p>

        {done && (tok?.priceUsd != null || tok?.mcap != null) && (
          <div className="unlisted-live">
            {tok.priceUsd != null && (
              <div className="ds">
                <div className="k">Price</div>
                <div className="v">{fmtPrice(tok.priceUsd)}</div>
              </div>
            )}
            {tok.mcap != null && (
              <div className="ds">
                <div className="k">Market cap</div>
                <div className="v">{fmtCap(tok.mcap)}</div>
              </div>
            )}
          </div>
        )}

        <div className="unlisted-facts">
          <div className="ds">
            <div className="k">Network</div>
            <div className="v">
              <ChainLogo chain={chain} size={14} style={{ verticalAlign: "-2px" }} />{" "}
              <span style={{ color: c?.color }}>{c?.label ?? chain}</span>
            </div>
          </div>
          <div className="ds">
            <div className="k">Contract address</div>
            <div className="ca-box" style={{ border: 0, padding: 0, background: "none" }}>
              <code>{address}</code>
              <button className="copy-btn" onClick={copyCa}>COPY</button>
            </div>
          </div>
        </div>

        <div className="unlisted-cta">
          <a className="btn-primary" href={BOT_URL} target="_blank" rel="noopener noreferrer">
            List {ticker ?? "Your Token"} →
          </a>
          <Link className="btn-ghost2" href="/">Browse listed tokens</Link>
        </div>

        {/* The chart is the reason a lot of people followed the link at all, and
            it does not depend on a listing — GeckoTerminal has the pool either
            way. Only rendered once a pool is known, so no empty frame. */}
        {tok?.poolAddress && c?.geckoNetwork && (
          <iframe
            className="tp-chart unlisted-chart"
            title={`${tok.symbol ?? "Token"} chart`}
            src={`https://www.geckoterminal.com/${c.geckoNetwork}/pools/${tok.poolAddress}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0&resolution=15m`}
            allow="clipboard-write"
            allowFullScreen
          />
        )}
      </div>
    </section>
  );
}
