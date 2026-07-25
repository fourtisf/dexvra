// Number / price / text formatting. fmt* ported 1:1 from the website's
// src/lib/format.ts; formatNumber + fmtPrice mirror the fourtis card style so
// channel posts read the same. HTML-safe helpers for parse_mode:"HTML".

/** Adaptive price string, e.g. $1.23, $0.004500, $0.00000119. */
function fmtPrice(p) {
  const n = Number(p);
  if (!(n > 0)) return "$0";
  if (n >= 1) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 0.01) return "$" + n.toFixed(4);
  if (n >= 0.0001) return "$" + n.toFixed(6);
  // Sub-$0.0001: keep ~4 significant figures. The old toFixed(8) rounded any
  // price below ~1e-8 to "0.00000000" → the trailing-zero strip left "$0.".
  const decimals = Math.min(18, Math.max(8, -Math.floor(Math.log10(n)) + 3));
  const s = n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
  return "$" + (s && s !== "0" ? s : n.toExponential(2));
}

/** Compact market-cap / big-number string: $1.72B, $138.0M, $24.0K. */
function fmtCap(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + Math.round(v);
}

/** Compact plain number (no $): 1.2M, 840.0K, 42. */
function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

/** fourtis-style compact (guards non-numbers instead of throwing). */
function formatNumber(num) {
  const v = Number(num);
  if (!Number.isFinite(v)) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (abs >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (abs >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  if (abs < 0.01 && abs > 0) return v.toFixed(4);
  if (abs < 1) return v.toFixed(3);
  if (abs < 100) return v.toFixed(2);
  return String(Math.floor(v));
}

function fmtAge(m) {
  if (m == null || !Number.isFinite(Number(m))) return "—";
  const v = Number(m);
  if (v < 60) return Math.max(0, Math.round(v)) + "m";
  if (v < 1440) return Math.round(v / 60) + "h";
  return Math.round(v / 1440) + "d";
}

function shortAddr(a) {
  const s = String(a || "");
  if (s.length <= 16) return s;
  return s.slice(0, 8) + "…" + s.slice(-6);
}

/** Escape for Telegram parse_mode:"HTML" (only & < > need escaping). */
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Trim a float for display: 0.5→"0.5", 5→"5". */
function trimAmount(n) {
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(8)));
}

module.exports = { fmtPrice, fmtCap, fmtNum, formatNumber, fmtAge, shortAddr, escapeHtml, trimAmount };
