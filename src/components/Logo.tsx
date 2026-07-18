// Dexvra brand mark — a diamond-cut "D" (nods to the Diamond tier) in the
// mint→cyan brand gradient on a dark rounded badge. Self-contained SVG so it
// renders identically in the sidebar, the admin header, and as a favicon.
export function Logo({ size = 40, gid = "dxvMark" }: { size?: number; gid?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label="Dexvra" style={{ display: "block" }}>
      <defs>
        <linearGradient id={gid} x1="6" y1="6" x2="42" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4BFCA6" />
          <stop offset="0.55" stopColor="#22D3EE" />
          <stop offset="1" stopColor="#12B9E0" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="13" fill="#0A0E16" />
      <rect x="2" y="2" width="44" height="44" rx="13" fill="none" stroke={`url(#${gid})`} strokeOpacity="0.55" strokeWidth="1.5" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M15 11 H23 A13 13 0 0 1 23 37 H15 Z M20 16 H23 A8 8 0 0 1 23 32 H20 Z"
        fill={`url(#${gid})`}
      />
      <path d="M33.5 12.5 L35.2 14.2 L33.5 15.9 L31.8 14.2 Z" fill="#EAFFF6" fillOpacity="0.92" />
    </svg>
  );
}
