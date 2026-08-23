"use client";

/**
 * The token page's price chart — real candles, drawn here.
 *
 * WHAT IT REPLACES, AND WHY BOTH HAD TO GO
 *
 *  1. A GeckoTerminal IFRAME, whenever we happened to know a pool address. It
 *     charts fine and it is someone else's page inside ours: another brand's
 *     type, another brand's colours, its own loading spinner, and no way to
 *     read one number out of it for anything else on the page.
 *  2. A FABRICATED AREA CHART whenever we did not — `syntheticTrend(symbol,
 *     chg24h)`, a curve generated from the ticker's hash, drawn full-width
 *     under the words "Price trend". On a 34px sparkline that is decoration.
 *     At 640×120 on the page a person opens to decide whether to buy, it is a
 *     claim about a market that nobody measured. This repo refuses a printed
 *     `0.00%` for an unreadable change; a drawn price history is the same lie
 *     with more pixels.
 *
 * So: candles from /api/ohlcv, and when there are none, the panel SAYS which
 * of the two reasons it is — no pool indexed yet, versus we could not read the
 * chart just now. Those need different reactions from the reader, and an empty
 * grid gives them the same one.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { TIMEFRAMES, pollMsFor, priceRange, windowChangePct, type Candle, type Timeframe } from "@/lib/ohlcv";
import { fmtCap, fmtPrice } from "@/lib/format";

interface Feed {
  ok: boolean;
  network: string | null;
  pool: string | null;
  candles: Candle[];
  why: string | null;
}

type Status = "loading" | "ok" | "none" | "error";

// Chart furniture, in pixels. The right gutter holds the price axis, the bottom
// one the time axis; the volume histogram sits between them.
const PAD_L = 10;
const PAD_R = 74;
const PAD_T = 14;
const AXIS_H = 22;
const GAP = 10;
const MAX_BODY = 13;
const GRID_LINES = 5;
/** Narrowest a candle may get before the window is trimmed instead. Below ~4px
 *  the bodies and the gaps merge into one smear. */
const MIN_STEP = 4;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

/** Clock label for a candle. Intraday candles are read as a time of day, daily
 *  ones as a date — a "14:30" on a 1d chart says nothing at all. */
function timeLabel(t: number, tf: Timeframe): string {
  const d = new Date(t * 1000);
  if (tf === "1d") return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
const fullLabel = (t: number): string => {
  const d = new Date(t * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

/** How much time the drawn window covers. "over 40h" is what "160 × 15m" meant
 *  and could not say — and the page header carries a 24h figure right above
 *  this one, so which period each number belongs to has to be legible. */
function spanLabel(seconds: number): string {
  const h = seconds / 3600;
  if (h < 48) return `${Math.max(1, Math.round(h))}h`;
  const d = h / 24;
  return d < 90 ? `${Math.round(d)}d` : `${Math.round(d / 30)}mo`;
}

export function CandleChart({
  chain,
  address,
  symbol,
  poolHint,
  gtUrl,
}: {
  chain: string;
  address: string;
  symbol: string;
  /** The pool the market provider already named, so the first request skips a
   *  lookup. A HINT: /api/ohlcv re-resolves if GeckoTerminal doesn't know it. */
  poolHint?: string | null;
  /** Fallback "open it elsewhere" link for the states with nothing to draw. */
  gtUrl?: string | null;
}) {
  const [tf, setTf] = useState<Timeframe>("15m");
  const [status, setStatus] = useState<Status>("loading");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // ── data ────────────────────────────────────────────────────────────────
  // One effect owns the whole lifecycle for one (token, timeframe): the first
  // read, the poll, and the abort. `drawn` lives inside it rather than in state
  // deliberately — it is "does the panel currently show candles for THIS
  // timeframe", which is exactly what must not be inherited across a tab switch.
  useEffect(() => {
    const ac = new AbortController();
    let stopped = false;
    let drawn = 0;

    const run = async (quiet: boolean) => {
      if (!quiet) {
        setStatus("loading");
        setFeed(null);
        setHover(null);
      }
      try {
        const qs = new URLSearchParams({ chain, address, tf });
        if (poolHint) qs.set("pool", poolHint);
        const res = await fetch(`/api/ohlcv?${qs}`, { signal: ac.signal });
        const j = (await res.json()) as Feed;
        if (stopped) return;
        if (j.ok && j.candles?.length) {
          drawn = j.candles.length;
          setFeed(j);
          setStatus("ok");
          return;
        }
        // A POLL THAT FAILS MUST NEVER BLANK A CHART THAT IS ALREADY DRAWN —
        // the pool did not stop existing because one request did not land, and
        // "no candles yet" over a chart the reader was just looking at is a
        // worse answer than a slightly stale one.
        if (quiet && drawn > 0) return;
        setFeed(j);
        setStatus(j.why && /couldn't read/i.test(j.why) ? "error" : "none");
      } catch {
        if (stopped) return;
        if (quiet && drawn > 0) return;
        setFeed(null);
        setStatus("error");
      }
    };

    void run(false);
    // Polling faster than the route's own cache TTL only ever returns the same
    // bytes, so the interval is derived from it rather than picked.
    const id = setInterval(() => void run(true), pollMsFor(tf));
    return () => {
      stopped = true;
      ac.abort();
      clearInterval(id);
    };
  }, [chain, address, tf, poolHint]);

  // ── geometry ────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      setBox({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const candles = feed?.candles ?? [];
  const geo = useMemo(() => {
    const { w, h } = box;
    if (w < 120 || h < 160 || candles.length === 0) return null;
    const volH = Math.min(90, Math.max(38, Math.round(h * 0.16)));
    const plotW = w - PAD_L - PAD_R;
    const priceH = h - PAD_T - volH - AXIS_H - GAP;
    if (plotW < 40 || priceH < 60) return null;

    // HOW MANY CANDLES FIT, not how many arrived. 200 candles across a phone's
    // 330px plot is a 1.6px body per candle — a green-and-red smear you cannot
    // read a single bar out of. The window narrows to the most RECENT ones,
    // which is the half anybody opening a memecoin chart is looking at.
    const view = candles.slice(-Math.max(24, Math.floor(plotW / MIN_STEP)));

    const range = priceRange(view);
    if (!range) return null;
    // A little headroom top and bottom so a wick never touches the frame and
    // the last-price tag has somewhere to sit.
    const pad = (range.hi - range.lo) * 0.06;
    const lo = Math.max(range.lo - pad, range.lo * 0.5);
    const hi = range.hi + pad;
    const maxVol = view.reduce((m, c) => Math.max(m, c.v), 0);

    const step = plotW / view.length;
    const body = Math.max(1, Math.min(MAX_BODY, step * 0.66));
    const yOf = (p: number) => PAD_T + (1 - (p - lo) / (hi - lo)) * priceH;
    const xOf = (i: number) => PAD_L + step * (i + 0.5);
    const volTop = PAD_T + priceH + GAP;
    const yVol = (v: number) => (maxVol > 0 ? volH - (v / maxVol) * volH : volH);

    return { w, h, lo, hi, step, body, yOf, xOf, priceH, volH, volTop, plotW, maxVol, yVol, view };
  }, [box, candles]);

  // EVERYTHING BELOW READS THE VISIBLE WINDOW, not the fetched list — a
  // percentage measured over candles that were never drawn is a number the
  // reader cannot check against the chart it sits on.
  const view = geo?.view ?? [];
  const active = hover != null && view[hover] ? view[hover] : view[view.length - 1];
  const last = view[view.length - 1];
  const change = windowChangePct(view);
  const upWindow = (change ?? 0) >= 0;
  const span = view.length > 1 ? spanLabel(view[view.length - 1].t - view[0].t) : null;

  const onMove = (clientX: number) => {
    if (!geo) return;
    const el = wrapRef.current;
    if (!el) return;
    const x = clientX - el.getBoundingClientRect().left;
    const i = Math.floor((x - PAD_L) / geo.step);
    setHover(i >= 0 && i < geo.view.length ? i : null);
  };

  const gtLink = feed?.network && feed?.pool ? `https://www.geckoterminal.com/${feed.network}/pools/${feed.pool}` : gtUrl ?? null;

  return (
    <div className="ck">
      <div className="ck-head">
        <div className="ck-title">
          <span className="ck-sym">{symbol}</span>
          {status === "ok" && change != null && (
            <span className={`ck-chg ${upWindow ? "up" : "dn"}`}>
              {upWindow ? "+" : ""}
              {change.toFixed(2)}% {span && <span className="ck-chg-tf">over {span}</span>}
            </span>
          )}
          {status === "ok" && <span className="ck-live" title="Refreshing while you watch" />}
        </div>
        <div className="ck-tfs" role="tablist" aria-label="Chart timeframe">
          {TIMEFRAMES.map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={k === tf}
              className={`ck-tf ${k === tf ? "on" : ""}`}
              onClick={() => {
                setHover(null);
                setTf(k);
              }}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      <div
        className="ck-plot"
        ref={wrapRef}
        onMouseMove={(e) => onMove(e.clientX)}
        onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => e.touches[0] && onMove(e.touches[0].clientX)}
        onTouchMove={(e) => e.touches[0] && onMove(e.touches[0].clientX)}
        onTouchEnd={() => setHover(null)}
      >
        {status === "loading" && (
          <div className="ck-msg">
            <span className="dot-live" /> Loading candles…
          </div>
        )}

        {(status === "none" || status === "error") && (
          <div className="ck-msg ck-empty">
            {/* The two states read differently on purpose: one is about the
                token (no pool yet), the other about us (we could not read it). */}
            <div className="ck-empty-k">{status === "error" ? "Chart unavailable right now" : "No candles yet"}</div>
            <p className="ck-empty-p">{feed?.why ?? "Couldn't read the chart just now."}</p>
            {gtLink && (
              <a className="ck-empty-a" href={gtLink} target="_blank" rel="noopener noreferrer">
                Open the pool on GeckoTerminal ↗
              </a>
            )}
          </div>
        )}

        {status === "ok" && geo && (
          <svg className="ck-svg" width={geo.w} height={geo.h} aria-label={`${symbol} price chart, ${tf} candles`} role="img">
            {/* price grid + right-hand axis */}
            {Array.from({ length: GRID_LINES }, (_, i) => {
              const p = geo.lo + ((geo.hi - geo.lo) * i) / (GRID_LINES - 1);
              const y = geo.yOf(p);
              // The last-price tag is drawn in the same gutter. Two figures on
              // top of each other read as one wrong figure, so the grid label
              // gives way — the tag is the number people are looking for.
              const hidden = last != null && Math.abs(y - geo.yOf(last.c)) < 12;
              return (
                <g key={`g${i}`}>
                  <line x1={PAD_L} x2={geo.w - PAD_R} y1={y} y2={y} className="ck-grid" />
                  {!hidden && (
                    <text x={geo.w - PAD_R + 7} y={y + 3.5} className="ck-axis">
                      {fmtPrice(p)}
                    </text>
                  )}
                </g>
              );
            })}

            {/* volume histogram */}
            <g transform={`translate(0,${geo.volTop})`}>
              <line x1={PAD_L} x2={geo.w - PAD_R} y1={geo.volH} y2={geo.volH} className="ck-grid" />
              {geo.view.map((c, i) => {
                const top = geo.yVol(c.v);
                return (
                  <rect
                    key={`v${c.t}`}
                    x={geo.xOf(i) - geo.body / 2}
                    y={top}
                    width={geo.body}
                    height={Math.max(0.6, geo.volH - top)}
                    className={c.c >= c.o ? "ck-vol up" : "ck-vol dn"}
                  />
                );
              })}
              {/* NO VOLUME AXIS LABEL. In the right-hand gutter it sat a few
                  pixels under the lowest price label and the two read as one
                  column of unrelated numbers; over the band it sat on top of
                  the bars. Every bar's exact volume is in the readout above on
                  hover, which is where a number belongs. */}
            </g>

            {/* candles */}
            {geo.view.map((c, i) => {
              const up = c.c >= c.o;
              const x = geo.xOf(i);
              const yO = geo.yOf(c.o);
              const yC = geo.yOf(c.c);
              const top = Math.min(yO, yC);
              // A doji has zero body height and would vanish; 1px keeps the
              // open-equals-close candle on the chart as the flat it is.
              const hgt = Math.max(1, Math.abs(yC - yO));
              return (
                <g key={c.t} className={up ? "ck-c up" : "ck-c dn"}>
                  <line x1={x} x2={x} y1={geo.yOf(c.h)} y2={geo.yOf(c.l)} className="ck-wick" />
                  <rect x={x - geo.body / 2} y={top} width={geo.body} height={hgt} className="ck-body" />
                </g>
              );
            })}

            {/* last price */}
            {last && (
              <g>
                <line
                  x1={PAD_L}
                  x2={geo.w - PAD_R}
                  y1={geo.yOf(last.c)}
                  y2={geo.yOf(last.c)}
                  className={`ck-lastline ${last.c >= last.o ? "up" : "dn"}`}
                />
                <rect
                  x={geo.w - PAD_R + 2}
                  y={geo.yOf(last.c) - 9}
                  width={PAD_R - 6}
                  height={18}
                  rx={4}
                  className={`ck-lastbg ${last.c >= last.o ? "up" : "dn"}`}
                />
                <text x={geo.w - PAD_R + 7} y={geo.yOf(last.c) + 3.5} className="ck-lasttx">
                  {fmtPrice(last.c)}
                </text>
              </g>
            )}

            {/* time axis — a handful of stamps, never one per candle */}
            {(() => {
              const every = Math.max(1, Math.ceil(geo.view.length / 6));
              return geo.view.map((c, i) => {
                if (i % every !== 0) return null;
                // A centred label on the first candle hangs half of itself off
                // the left edge — "15:24" shipped as "5:24", which is a wrong
                // time rather than a clipped one. The end stamps anchor inward.
                const x = geo.xOf(i);
                const near = 26;
                const anchor: "start" | "end" | "middle" =
                  x < PAD_L + near ? "start" : x > geo.w - PAD_R - near ? "end" : "middle";
                return (
                  <text
                    key={`t${c.t}`}
                    x={anchor === "start" ? PAD_L : anchor === "end" ? geo.w - PAD_R : x}
                    y={geo.h - 6}
                    className="ck-axis ck-axis-x"
                    textAnchor={anchor}
                  >
                    {timeLabel(c.t, tf)}
                  </text>
                );
              });
            })()}

            {/* crosshair */}
            {hover != null && geo.view[hover] && (
              <line
                x1={geo.xOf(hover)}
                x2={geo.xOf(hover)}
                y1={PAD_T}
                y2={geo.volTop + geo.volH}
                className="ck-cross"
              />
            )}
          </svg>
        )}

        {status === "ok" && geo && active && (
          <div className="ck-tip" style={{ right: PAD_R + 4 }} aria-hidden>
            <span className="ck-tip-t">{fullLabel(active.t)}</span>
            <span className="ck-tip-v ck-tip-ohl">
              O <b>{fmtPrice(active.o)}</b>
            </span>
            <span className="ck-tip-v ck-tip-ohl">
              H <b>{fmtPrice(active.h)}</b>
            </span>
            <span className="ck-tip-v ck-tip-ohl">
              L <b>{fmtPrice(active.l)}</b>
            </span>
            <span className="ck-tip-v">
              C <b className={active.c >= active.o ? "up" : "dn"}>{fmtPrice(active.c)}</b>
            </span>
            <span className="ck-tip-v">
              Vol <b>{fmtCap(active.v)}</b>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
