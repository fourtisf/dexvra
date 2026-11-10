"use client";

import { changeReading, tradedEnough } from "@/lib/home";
import { coinBg, monogram } from "@/lib/visual";
import { logoSrc } from "@/lib/logo";
import { tokenHref, useApp } from "./AppState";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { BoardToken } from "@/lib/types";

/** The ticker's 21px disc. Falls back to the monogram, never to a hidden image
 *  over an empty gradient — and reads a failure that happened BEFORE hydration
 *  too, which React's onError cannot see (the same rule as Coin). */
function TickCoin({ token: t }: { token: BoardToken }) {
  const src = logoSrc(t.logoUrl);
  const [broken, setBroken] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setBroken(true);
  }, [src]);
  return (
    <span className="tick-coin" style={{ background: coinBg(t.gradient) }}>
      {src && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={ref}
          src={src}
          alt=""
          style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }}
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="coin-mono">{monogram(t.symbol)}</span>
      )}
    </span>
  );
}

export const TICKER_SIZE = 10;

export function Ticker() {
  const { data } = useApp();
  // Ranked and shown through the sane reading — a five-million-percent figure
  // off a near-dead pool must not lead the top-movers bar (see changeReading).
  // …and through `tradedEnough`, which is the same rule at the other end of the
  // scale. This marquee is a numbered top-EIGHT on every page of the site, so a
  // token that traded five cents in a day led it — while the board directly
  // underneath, which reads the volume, ranked it tenth. One screen, two
  // rankings, disagreeing. EXCLUDED rather than demoted, like `movers`: there
  // is no honest place in a curated list for a number that means nothing.
  // Ten since mockup A ("minimal 9 atau 10"), and labelled for what it IS —
  // the biggest 24h moves, not the paid Trending inventory the spotlight leads
  // with. Two things both called "Trending" that disagree is a reader's puzzle.
  const top = data
    ? data.tokens
        .filter(tradedEnough)
        .map((t) => ({ t, r: changeReading(t, "24h") }))
        .filter((x): x is { t: (typeof data.tokens)[number]; r: number } => x.r != null)
        .sort((a, b) => b.r - a.r)
        .slice(0, TICKER_SIZE)
    : [];
  if (!top.length) return <div className="ticker" />;

  // Each chip OPENS ITS TOKEN ("top mover pas di klik harus ke tokenya"). A real
  // link, not a click handler on a span: it opens in a new tab, reads as a link
  // to a screen reader, and the marquee already pauses under the pointer. The
  // track is drawn twice for the seamless loop, so the second copy is hidden
  // from assistive tech and the tab order — one stop per token, not two.
  // `prefetch={false}`: twenty token pages fetched behind a marquee nobody
  // tapped is load the site does not need.
  const renderItems = (prefix: string, copy: boolean) =>
    top.map(({ t, r }, i) => {
      const up = r >= 0;
      return (
        <Link
          className="tick-item"
          key={prefix + t.key + i}
          href={tokenHref(t)}
          prefetch={false}
          title={`${t.symbol} — ${t.name}`}
          aria-hidden={copy || undefined}
          tabIndex={copy ? -1 : undefined}
        >
          <span className="rnk">#{i + 1}</span>
          <TickCoin token={t} />
          <span className="sym">{t.symbol}</span>
          <span className={`pct ${up ? "up" : "dn"}`}>
            {up ? "+" : ""}
            {r.toFixed(1)}%
          </span>
        </Link>
      );
    });

  // items rendered twice so the -50% marquee loops seamlessly (prototype trick)
  return (
    <div className="ticker">
      <span className="tick-lbl">
        <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />
        </svg>
        Top movers <i>24h</i>
      </span>
      <div className="ticker-view">
        <div className="ticker-track">
          {renderItems("a", false)}
          {renderItems("b", true)}
        </div>
      </div>
    </div>
  );
}
