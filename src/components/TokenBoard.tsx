"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardToken, PeriodKey } from "@/lib/types";
import { fmtAge, fmtCap, fmtNum, fmtPrice } from "@/lib/format";
import { scoreTier } from "@/lib/score";
import { Coin } from "./Coin";
import { useApp } from "./AppState";

const MEDALS = ["🥇", "🥈", "🥉"];

type SortKey = "price" | "chg" | "mcap" | "liq" | "vol" | "tx";

const SORT_VAL: Record<SortKey, (t: BoardToken, p: PeriodKey) => number> = {
  price: (t) => t.priceUsd,
  chg: (t, p) => t.chg[p],
  mcap: (t) => t.mcap ?? 0,
  liq: (t) => t.liq ?? 0,
  vol: (t, p) => t.vol[p],
  tx: (t, p) => t.txns[p].buys + t.txns[p].sells,
};

function StarButton({ token }: { token: BoardToken }) {
  const { watchlist, toggleWatch } = useApp();
  const on = watchlist.has(token.key);
  return (
    <button
      className={`star ${on ? "on" : ""}`}
      title="Watchlist"
      aria-pressed={on}
      onClick={(e) => {
        // star must never bubble into the row's open-detail click
        e.stopPropagation();
        toggleWatch(token.key, token.symbol);
      }}
    >
      <svg viewBox="0 0 24 24">
        <path d="m12 3.5 2.5 5.2 5.7.7-4.2 4 1.1 5.6L12 16.3 6.9 19l1.1-5.6-4.2-4 5.7-.7L12 3.5z" />
      </svg>
    </button>
  );
}

/** Track real price movements between refreshes and flash rows; in demo
 *  (seed) mode, replicate the prototype's random flicker so the board still
 *  feels alive. Overrides only touch what's displayed, never app state. */
function useFlicker(tokens: BoardToken[], reducedMotion: boolean) {
  const [flash, setFlash] = useState<Record<string, "up" | "dn">>({});
  const [override, setOverride] = useState<Record<string, { price: number; chgDelta: number }>>({});
  const prevPrices = useRef<Map<string, number>>(new Map());
  const timeouts = useRef<ReturnType<typeof setTimeout>[]>([]);

  const isSeed = tokens.length > 0 && tokens[0].source === "seed";

  useEffect(() => {
    if (reducedMotion) return;
    const next: Record<string, "up" | "dn"> = {};
    for (const t of tokens) {
      const prev = prevPrices.current.get(t.key);
      if (prev !== undefined && prev !== t.priceUsd) next[t.key] = t.priceUsd > prev ? "up" : "dn";
      prevPrices.current.set(t.key, t.priceUsd);
    }
    if (Object.keys(next).length) {
      setFlash((f) => ({ ...f, ...next }));
      const id = setTimeout(() => setFlash({}), 700);
      timeouts.current.push(id);
    }
    // live data refreshes invalidate any demo overrides
    if (!isSeed) setOverride({});
  }, [tokens, reducedMotion, isSeed]);

  useEffect(() => {
    if (!isSeed || reducedMotion) return;
    const id = setInterval(() => {
      const t = tokens[Math.floor(Math.random() * tokens.length)];
      if (!t) return;
      const dir = Math.random() > 0.45 ? 1 : -1;
      setOverride((o) => {
        const cur = o[t.key] ?? { price: t.priceUsd, chgDelta: 0 };
        return {
          ...o,
          [t.key]: {
            price: cur.price * (1 + dir * Math.random() * 0.006),
            chgDelta: cur.chgDelta + dir * Math.random() * 0.4,
          },
        };
      });
      setFlash((f) => ({ ...f, [t.key]: dir > 0 ? "up" : "dn" }));
      const to = setTimeout(() => setFlash((f) => {
        const { [t.key]: _drop, ...rest } = f;
        return rest;
      }), 700);
      timeouts.current.push(to);
    }, 2600);
    return () => clearInterval(id);
  }, [isSeed, reducedMotion, tokens]);

  useEffect(() => () => timeouts.current.forEach(clearTimeout), []);

  return { flash, override };
}

function StdRow({
  t,
  i,
  period,
  flashDir,
  override,
}: {
  t: BoardToken;
  i: number;
  period: PeriodKey;
  flashDir?: "up" | "dn";
  override?: { price: number; chgDelta: number };
}) {
  const { openDetail } = useApp();
  const price = override?.price ?? t.priceUsd;
  const chg = t.chg[period] + (override?.chgDelta ?? 0);
  const up = chg >= 0;
  const dec = period === "5m" ? 2 : 1;
  const { buys, sells } = t.txns[period];
  const rank = i < 3 ? <span className="medal">{MEDALS[i]}</span> : i + 1;

  return (
    <div
      className={`row ${flashDir === "up" ? "flash-up" : ""} ${flashDir === "dn" ? "flash-dn" : ""}`}
      onClick={() => openDetail(t)}
    >
      <div className="rank">{rank}</div>
      <div className="tok">
        <Coin token={t} />
        <div className="ts">
          <div className="sym">
            {t.symbol}
            {t.verified && <span className="verified-badge" title="Verified">✓</span>}
          </div>
          <div className="nm">{t.name}</div>
        </div>
      </div>
      <div className="c-num price">{fmtPrice(price)}</div>
      <div className="c-num">
        <span className={`chg ${up ? "up" : "dn"}`}>
          {up ? "+" : ""}
          {chg.toFixed(dec)}%
        </span>
      </div>
      <div className="c-num c-mcap mono-dim">{fmtCap(t.mcap)}</div>
      <div className="c-num c-liq mono-dim">{fmtCap(t.liq)}</div>
      <div className="c-num c-vol mono-dim">{fmtCap(t.vol[period])}</div>
      <div className="c-txns tx-cell">
        <div className="tx-main">{fmtNum(buys + sells)}</div>
        <div className="tx-split">
          <span className="b">{fmtNum(buys)}</span>
          <span className="sl"> / </span>
          <span className="s">{fmtNum(Math.max(sells, 0))}</span>
        </div>
      </div>
      <div className="c-info info-cell">
        <span className="dscore" style={{ color: scoreTier(t.score).color }} title="Dexvra Score">
          <span className="dl">DXS</span>
          {t.score}
        </span>
        {t.taxPct != null && (
          <span className={`ichip ${t.taxPct === 0 ? "good" : ""}`}>🛡 {t.taxPct}%</span>
        )}
      </div>
      <StarButton token={t} />
    </div>
  );
}

function NpRow({ t, i, flashDir }: { t: BoardToken; i: number; flashDir?: "up" | "dn" }) {
  const { openDetail } = useApp();
  const up = t.chg["24h"] >= 0;
  return (
    <div
      className={`row ${flashDir === "up" ? "flash-up" : ""} ${flashDir === "dn" ? "flash-dn" : ""}`}
      onClick={() => openDetail(t)}
    >
      <div className="rank">{i + 1}</div>
      <div className="tok">
        <Coin token={t} />
        <div className="ts">
          <div className="sym">{t.symbol}</div>
          <div className="nm">{t.name}</div>
        </div>
      </div>
      <div>
        <span className="age-chip">⏱ {fmtAge(t.ageMinutes)}</span>
      </div>
      <div className="c-num price c-mcap">{fmtPrice(t.priceUsd)}</div>
      <div className="c-num">
        <span className={`chg ${up ? "up" : "dn"}`}>
          {up ? "+" : ""}
          {t.chg["24h"].toFixed(1)}%
        </span>
      </div>
      <div className="c-num c-liq mono-dim">{fmtCap(t.liq)}</div>
      <div className="c-txns tx-cell">
        <div className="tx-main">{fmtNum(t.txns["24h"].buys + t.txns["24h"].sells)}</div>
        <div className="tx-split">
          <span className="b">{fmtNum(t.txns["24h"].buys)}</span>
          <span className="sl"> / </span>
          <span className="s">{fmtNum(t.txns["24h"].sells)}</span>
        </div>
      </div>
      <StarButton token={t} />
    </div>
  );
}

export function StdBoardHead({
  period = "24h",
  sortable = false,
  sortKey,
  sortDir,
  onSort,
}: {
  period?: PeriodKey;
  sortable?: boolean;
  sortKey?: SortKey;
  sortDir?: 1 | -1;
  onSort?: (k: SortKey) => void;
}) {
  const col = (key: SortKey, label: string, extraClass = "") => {
    if (!sortable)
      return <div className={`c-num ${extraClass}`}>{label}</div>;
    const on = sortKey === key;
    return (
      <div
        className={`sortable c-num ${extraClass} ${on ? "on" : ""}`}
        onClick={() => onSort?.(key)}
      >
        {label}
        <span className="sarrow">{on && sortDir === 1 ? "▲" : "▼"}</span>
      </div>
    );
  };
  return (
    <div className="row head">
      <div>#</div>
      <div>Token</div>
      {col("price", "Price")}
      {col("chg", `${period} %`)}
      {col("mcap", "MCAP", "c-mcap")}
      {col("liq", "Liquidity", "c-liq")}
      {col("vol", `Vol · ${period}`, "c-vol")}
      {col("tx", `Txns · ${period}`, "c-txns")}
      <div className="c-info">Score</div>
      <div></div>
    </div>
  );
}

export function StdBoard({
  tokens,
  period = "24h",
  sortable = false,
  emptyText = "No tokens match — try another chain or clear your search.",
  loading = false,
}: {
  tokens: BoardToken[];
  period?: PeriodKey;
  sortable?: boolean;
  emptyText?: string;
  loading?: boolean;
}) {
  const { reducedMotion } = useApp();
  const [sortKey, setSortKey] = useState<SortKey>("chg");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const sorted = useMemo(() => {
    if (!sortable) return tokens;
    return [...tokens].sort(
      (a, b) => (SORT_VAL[sortKey](b, period) - SORT_VAL[sortKey](a, period)) * -sortDir,
    );
  }, [tokens, sortable, sortKey, sortDir, period]);

  const { flash, override } = useFlicker(sorted, reducedMotion);

  const onSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setSortDir(-1);
    }
  };

  return (
    <div className="board">
      <StdBoardHead
        period={period}
        sortable={sortable}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
      />
      {loading ? (
        <div className="board-loading">
          <span className="dot-live" />
          Loading live board…
        </div>
      ) : sorted.length === 0 ? (
        <div className="empty">{emptyText}</div>
      ) : (
        sorted.map((t, i) => (
          <StdRow
            key={t.key}
            t={t}
            i={i}
            period={period}
            flashDir={flash[t.key]}
            override={override[t.key]}
          />
        ))
      )}
    </div>
  );
}

export function NpBoard({ tokens, loading = false }: { tokens: BoardToken[]; loading?: boolean }) {
  const { reducedMotion } = useApp();
  const { flash } = useFlicker(tokens, reducedMotion);
  return (
    <div className="board np">
      <div className="row head">
        <div>#</div>
        <div>Token</div>
        <div>Age</div>
        <div className="c-num c-mcap">Price</div>
        <div className="c-num">24h %</div>
        <div className="c-num c-liq">Liquidity</div>
        <div className="c-num c-txns">Txns</div>
        <div></div>
      </div>
      {loading ? (
        <div className="board-loading">
          <span className="dot-live" />
          Loading new pairs…
        </div>
      ) : tokens.length === 0 ? (
        <div className="empty">No fresh pairs right now — check back in a minute.</div>
      ) : (
        tokens.map((t, i) => <NpRow key={t.key} t={t} i={i} flashDir={flash[t.key]} />)
      )}
    </div>
  );
}
