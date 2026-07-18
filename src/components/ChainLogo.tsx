import type { CSSProperties } from "react";

// Recognizable per-chain mark (nominative use — labels which chain a token
// trades on, like every DEX aggregator). Kept as compact inline SVG so it
// stays crisp and needs no network image.
function Solana({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Solana">
      <defs>
        <linearGradient id="sol" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#9945FF" />
          <stop offset="1" stopColor="#19FB9B" />
        </linearGradient>
      </defs>
      <g fill="url(#sol)">
        <path d="M5 7.5c.2-.2.5-.3.7-.3H20l-2.7 3H4.3z" />
        <path d="M5 15.5c.2.2.5.3.7.3H20l-2.7-3H4.3z" transform="translate(0 -1)" />
        <path d="M5 11.4c.2-.2.5-.3.7-.3H20l-2.7 3H4.3z" transform="translate(0 .1)" />
      </g>
    </svg>
  );
}
function Ethereum({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Ethereum">
      <g fill="#8A92B2">
        <path d="M12 2 5.5 12.3 12 16z" />
        <path d="M12 2 18.5 12.3 12 16z" fill="#62688F" />
        <path d="M12 17.2 5.5 13.5 12 22z" />
        <path d="M12 17.2 18.5 13.5 12 22z" fill="#62688F" />
      </g>
    </svg>
  );
}
function Bnb({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="BNB">
      <g fill="#F0B90B">
        <path d="M12 4 9.4 6.6 12 9.2l2.6-2.6z" />
        <path d="M6.6 9.4 4 12l2.6 2.6L9.2 12z" />
        <path d="M17.4 9.4 14.8 12l2.6 2.6L20 12z" />
        <path d="M12 14.8 9.4 17.4 12 20l2.6-2.6z" />
        <path d="M12 9.4 9.4 12 12 14.6 14.6 12z" />
      </g>
    </svg>
  );
}
function Base({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Base">
      <circle cx="12" cy="12" r="10" fill="#0052FF" />
      <path d="M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 6.4-5.4H8.6v-2.2h9.8A6.5 6.5 0 0 0 12 5.5z" fill="#fff" />
    </svg>
  );
}
function Ton({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="TON">
      <circle cx="12" cy="12" r="10" fill="#0098EA" />
      <path d="M7.5 8.5h9L12 17zM12 9.7 9.6 9.7 12 14.4 14.4 9.7z" fill="#fff" />
    </svg>
  );
}
function Robinhood({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Robinhood">
      <circle cx="12" cy="12" r="10" fill="#0A0A0A" />
      <path d="M8 17V7c3.4 0 5.6 1.4 5.6 4 0 1.7-1 2.9-2.7 3.4L14 17h-2.4l-1.8-2.4H10V17z" fill="#CCFF00" />
    </svg>
  );
}

const MAP: Record<string, (p: { s: number }) => JSX.Element> = {
  solana: Solana,
  ethereum: Ethereum,
  bsc: Bnb,
  base: Base,
  ton: Ton,
  robinhood: Robinhood,
};

export function ChainLogo({ chain, size = 16, style }: { chain: string; size?: number; style?: CSSProperties }) {
  const C = MAP[chain];
  if (!C)
    return <span style={{ width: size, height: size, display: "inline-block", ...style }} />;
  return (
    <span style={{ width: size, height: size, display: "inline-grid", placeItems: "center", ...style }}>
      <C s={size} />
    </span>
  );
}
