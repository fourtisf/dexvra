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
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="BNB Chain">
      <circle cx="12" cy="12" r="10" fill="#F3BA2F" />
      <g fill="#fff">
        <path d="M12 5.9 14.1 8 12 10.1 9.9 8z" />
        <path d="M8 9.9 10.1 12 8 14.1 5.9 12z" />
        <path d="M16 9.9 18.1 12 16 14.1 13.9 12z" />
        <path d="M12 13.9 14.1 16 12 18.1 9.9 16z" />
        <path d="M12 9.85 14.15 12 12 14.15 9.85 12z" />
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
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Robinhood Chain">
      <circle cx="12" cy="12" r="10" fill="#0B0F10" />
      {/* stylized feather quill */}
      <path
        d="M16.5 6.2c-3.4.3-6.2 2-7.7 4.8-.7 1.3-1 2.8-1 4.4l-1 1.4c-.2.3 0 .7.4.6l1.7-.4c1.4.5 3 .5 4.4-.1 2.9-1.3 4.7-4.1 5.1-7.6l.4-2.9c0-.4-.3-.7-.7-.6l-1.3.9z"
        fill="#C5F94B"
      />
      <path d="M9 15.5c1.6-2.9 3.9-4.9 6.7-6" stroke="#0B0F10" strokeWidth="1" fill="none" strokeLinecap="round" />
    </svg>
  );
}
function Tron({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Tron">
      <circle cx="12" cy="12" r="10" fill="#EF0027" />
      {/* TRON angular tri-mark */}
      <path
        d="M6.2 7.4 15.4 8.9c.3 0 .5.2.6.4l2 3.3c.2.3.1.6-.1.8L11.6 18c-.3.3-.8.1-.9-.3L6 8c-.1-.4.2-.7.6-.6zm1.7 1.5 3 5.9.1-4.9zm4.2 1 .0 4.6 3.8-3.2zm.9-.9 2.6 1.9-1.2-2z"
        fill="#fff"
      />
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
  tron: Tron,
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
