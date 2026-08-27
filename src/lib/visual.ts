// Deterministic per-token colour, so the gradient behind a token's logo is
// stable across refreshes and identical on the server and the client.
// (Logos themselves are resolved in lib/logo.ts — never generated here.)
const GRADIENTS: [string, string, string][] = [
  ["#C9D4FF", "#6D8BFF", "#2A3FB8"],
  ["#FFE9A8", "#FFC53D", "#B57900"],
  ["#B8FFD0", "#3DF59F", "#0B9E5E"],
  ["#E2CCFF", "#A97CFF", "#6524C9"],
  ["#B0F2FF", "#22D3EE", "#0A7F96"],
  ["#FFD9B8", "#FF9D5C", "#C25C00"],
  ["#FFD0E4", "#FF7CB8", "#C22A72"],
  ["#C4FFD9", "#4DE8A0", "#0E7A4C"],
  ["#FFF9C4", "#FFE24D", "#A38B00"],
  ["#E0C4FF", "#B06CFF", "#5C1FB0"],
];

export function hashStr(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export function visualFor(sym: string): { gradient: [string, string, string] } {
  // `hashStr` returns an unsigned 32-bit value, so use the UNSIGNED shift
  // `>>>`. The signed `>>` sign-extends when the high bit is set, making the
  // result negative → a negative modulo → an out-of-range index → undefined
  // gradient → "Cannot read properties of undefined (reading '0')" in coinBg
  // for ~half of all symbols.
  return { gradient: GRADIENTS[(hashStr(sym) >>> 4) % GRADIENTS.length] };
}

export function coinBg(g?: [string, string, string]): string {
  // defensive fallback so a bad/missing gradient can never blank the page
  const c = g ?? ["#B8FFD0", "#3DF59F", "#0B9E5E"];
  return `radial-gradient(circle at 32% 26%,${c[0]},${c[1]} 45%,${c[2]})`;
}

/** Synthetic sparkline seeded by symbol — same construction as the prototype.
 *  Replaced by real OHLCV in a later phase. */
export function syntheticTrend(sym: string, chg24h: number): number[] {
  const i = hashStr(sym) % 23;
  const pts: number[] = [];
  let v = 50;
  const drift = chg24h >= 0 ? 0.9 : -0.9;
  for (let k = 0; k < 26; k++) {
    v += drift + Math.sin(i * 3.7 + k * 1.3) * 4 + (((k * i) % 5) - 2);
    v = Math.max(8, Math.min(92, v));
    pts.push(v);
  }
  if (chg24h >= 0) pts[pts.length - 1] = Math.max(...pts);
  return pts;
}
