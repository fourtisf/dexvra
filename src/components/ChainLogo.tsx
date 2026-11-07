import type { CSSProperties } from "react";
import { chainOf } from "@/config/chains";

/**
 * The chain's own mark (nominative use — labels which chain a token trades on,
 * like every DEX aggregator), served from `public/chains/<chain>.svg`.
 *
 * ⚠️ THESE USED TO BE HAND-DRAWN APPROXIMATIONS — a quill for Robinhood, a bear
 * face for Berachain, a letter on a coloured disc for Sonic, Sei, Blast and
 * Unichain — and a project reading the chain list saw marks that were not its
 * chain's ("logonya benerin logo chainnya"). The files are the brands' own
 * vector marks (the web3icons set, MIT), so they are the real logos and stay
 * crisp at every size. Marks drawn in black are shipped in the colour each
 * brand uses on a dark background, because this site has no light surface.
 *
 * ⚠️ AN <img>, NEVER INLINE SVG. Inline marks put their paint servers and clip
 * paths in the page's ONE id space, and a page draws dozens of marks: every
 * `url(#…)` then resolves to the FIRST copy, and when that copy sits in a hidden
 * subtree (the desktop rail is `display:none` below 1100px) it paints nothing —
 * which is how every Solana mark on tablets and phones once rendered blank. An
 * image is its own document, so no mark can borrow another's ids.
 */
const MARKS = new Set([
  "solana", "ethereum", "bsc", "base", "ton", "robinhood", "tron", "sui", "plasma", "polygon", "arbitrum",
  "optimism", "avalanche", "berachain", "sonic", "hyperevm", "abstract", "apechain", "blast", "sei", "aptos", "unichain",
]);

/** The url of a chain's mark, or null for a chain with no file yet. */
export function chainMarkSrc(chain: string): string | null {
  return MARKS.has(chain) ? `/chains/${chain}.svg` : null;
}

export function ChainLogo({ chain, size = 16, style }: { chain: string; size?: number; style?: CSSProperties }) {
  const cfg = chainOf(chain);
  const label = cfg?.label ?? chain;
  const src = chainMarkSrc(chain);
  if (!src) {
    // No mark yet (e.g. a newly-added chain) → a coloured initial badge from the
    // chain registry, so it still reads as a recognizable tag instead of a gap.
    const color = cfg?.color ?? "#5A6E74";
    const initial = (label ?? "?").slice(0, 1).toUpperCase();
    return (
      <span
        aria-label={label}
        style={{
          width: size,
          height: size,
          display: "inline-grid",
          placeItems: "center",
          borderRadius: "50%",
          background: color,
          color: "#0A1219",
          fontSize: Math.round(size * 0.58),
          fontWeight: 700,
          lineHeight: 1,
          ...style,
        }}
      >
        {initial}
      </span>
    );
  }
  return (
    <span className="chain-mark" style={{ width: size, height: size, display: "inline-grid", placeItems: "center", flex: "none", ...style }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} width={size} height={size} alt={label} decoding="async" draggable={false} style={{ display: "block" }} />
    </span>
  );
}
