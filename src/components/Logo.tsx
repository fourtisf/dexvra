// Dexvra brand mark — a brilliant-cut gem (nods to the Diamond tier + premium
// paid listings) in the mint→cyan brand gradient on a dark rounded badge.
// Self-contained SVG so it renders identically in the sidebar, admin header,
// and as a favicon.
export function Logo({ size = 40, gid = "dxvMark" }: { size?: number; gid?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label="Dexvra" style={{ display: "block" }}>
      <defs>
        <linearGradient id={gid} x1="9" y1="12" x2="39" y2="37" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4BFCA6" />
          <stop offset="0.55" stopColor="#22D3EE" />
          <stop offset="1" stopColor="#12B9E0" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="13" fill="#0A0E16" />
      <rect x="2" y="2" width="44" height="44" rx="13" fill="none" stroke={`url(#${gid})`} strokeOpacity="0.45" strokeWidth="1.5" />
      {/* gem body */}
      <path d="M15 12 H33 L39 19 L24 37 L9 19 Z" fill={`url(#${gid})`} />
      {/* facet cuts */}
      <g stroke="#0A0E16" strokeWidth="1.3" strokeOpacity="0.5" fill="none">
        <path d="M9 19 H39" />
        <path d="M15 12 L20 19" />
        <path d="M33 12 L28 19" />
        <path d="M20 19 H28" />
        <path d="M20 19 L24 37" />
        <path d="M28 19 L24 37" />
      </g>
      {/* top-left highlight facet */}
      <path d="M15.6 12.5 H22 L19 18.5 H10.5 Z" fill="#FFFFFF" fillOpacity="0.14" />
    </svg>
  );
}
