// Number formatting ported 1:1 from the prototype (fmtPrice etc.) — the
// handoff calls these out as canonical.
export function fmtPrice(p: number): string {
  // guard: without this, the trailing-zero strip below turns 0 into "$0."
  if (!(p > 0)) return "$0";
  if (p >= 1)
    return (
      "$" +
      p.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  if (p >= 0.01) return "$" + p.toFixed(4);
  if (p >= 0.0001) return "$" + p.toFixed(6);
  // Sub-$0.0001: keep ~4 significant figures. The old toFixed(8) rounded any
  // price below ~1e-8 down to "0.00000000", and the trailing-zero strip then
  // left a bare "$0." (looked broken for tiny memecoin prices).
  const decimals = Math.min(18, Math.max(8, -Math.floor(Math.log10(p)) + 3));
  const s = p.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
  return "$" + (s && s !== "0" ? s : p.toExponential(2));
}

export function fmtCap(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + Math.round(n);
}

export function fmtNum(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

export function fmtAge(m: number | null): string {
  if (m == null) return "—";
  if (m < 60) return Math.max(0, Math.round(m)) + "m";
  if (m < 1440) return Math.round(m / 60) + "h";
  return Math.round(m / 1440) + "d";
}

export function pathFrom(pts: number[], w: number, h: number, pad = 3): string {
  const mx = Math.max(...pts),
    mn = Math.min(...pts),
    step = w / (pts.length - 1);
  const ys = pts.map((v) => h - pad - ((v - mn) / (mx - mn || 1)) * (h - pad * 2));
  let d = "M0," + ys[0].toFixed(1);
  ys.forEach((y, i) => {
    if (i) d += " L" + (i * step).toFixed(1) + "," + y.toFixed(1);
  });
  return d;
}

export function shortAddr(a: string): string {
  if (a.length <= 16) return a;
  return a.slice(0, 8) + "…" + a.slice(-6);
}
