import { CHAINS } from "@/config/chains";
import { cached } from "@/lib/cache";
import {
  SEED_ROWS,
  rowToBoardToken,
  rowsToAddressesByChain,
  rowsToBoardTokens,
  type ListingRow,
} from "@/lib/listings";
import { approvedRows } from "@/lib/store";
import { dexvraScore } from "@/lib/score";
import { syntheticTrend, visualFor } from "@/lib/visual";
import type {
  BoardToken,
  ChainHeat,
  FearGreed,
  Signal,
  TokensPayload,
  WireItem,
} from "@/lib/types";
import { fmtCap } from "@/lib/format";
import { SEED_FEAR_GREED, fetchFearGreed } from "./feargreed";
import { fetchListedMarket, type LiveMarket } from "./geckoterminal";

const PRICE_TTL = 30_000;
const FNG_TTL = 10 * 60_000;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Approved paid listings from the admin store; falls back to the seed if the
 *  store can't be read. */
async function loadRows(): Promise<ListingRow[]> {
  try {
    const rows = await approvedRows();
    return rows.length ? rows : SEED_ROWS;
  } catch {
    return SEED_ROWS;
  }
}

/** Merge live market data onto the paid listings. Any listing without live
 *  data keeps its fallback figures, so the board always renders. */
async function loadListedTokens(): Promise<BoardToken[]> {
  const rows = await loadRows();
  const byChain = rowsToAddressesByChain(rows);
  const fallback = rowsToBoardTokens(rows);

  const marketResults = await Promise.allSettled(
    Object.entries(byChain).map(async ([chain, addrs]) => ({
      chain,
      map: await fetchListedMarket(chain, addrs),
    })),
  );
  const anyLive = marketResults.some((r) => r.status === "fulfilled" && r.value.map.size > 0);
  if (!anyLive) throw new Error("no live market data for any listing");

  const live = new Map<string, Map<string, LiveMarket>>();
  for (const r of marketResults) if (r.status === "fulfilled") live.set(r.value.chain, r.value.map);

  return fallback.map((t) => {
    const m = live.get(t.chain)?.get(t.address.toLowerCase());
    if (!m) return t; // keep fallback figures for this listing
    const score = dexvraScore({ chg: m.chg, liq: m.liq, taxPct: t.taxPct, txns: m.txns, holders: t.holders });
    const v = visualFor(t.symbol);
    return {
      ...t,
      logoUrl: t.logoUrl ?? m.logoUrl, // admin-set logo wins; else live logo
      priceUsd: m.priceUsd,
      mcap: m.mcap ?? t.mcap,
      liq: m.liq ?? t.liq,
      chg: m.chg,
      vol: m.vol,
      txns: m.txns,
      gradient: v.gradient,
      trend: syntheticTrend(t.symbol, m.chg["24h"]),
      score,
      source: "live" as const,
      ageMinutes: m.ageMinutes ?? t.ageMinutes,
      listedMinutesAgo: t.listedMinutesAgo,
      poolAddress: m.poolAddress,
    };
  });
}

function buildHeat(tokens: BoardToken[]): ChainHeat[] {
  const byChain = new Map<string, { vol: number; chg: number; n: number }>();
  for (const t of tokens) {
    const e = byChain.get(t.chain) ?? { vol: 0, chg: 0, n: 0 };
    e.vol += t.vol["24h"];
    e.chg += t.chg["24h"];
    e.n++;
    byChain.set(t.chain, e);
  }
  return [...byChain.entries()]
    .map(([chain, e]) => ({
      chain,
      temp: Math.max(5, Math.min(45, Math.round(Math.log10(Math.max(e.vol, 1)) * 4 + e.chg / e.n / 8))),
      vol24h: e.vol,
    }))
    .sort((a, b) => b.vol24h - a.vol24h)
    .slice(0, 3);
}

// Algorithmic Signal Feed — derived from on-chain data, NOT human votes.
function buildSignals(tokens: BoardToken[]): Signal[] {
  const sig: Signal[] = [];
  const byScore = [...tokens].sort((a, b) => b.score - a.score);
  const top = byScore[0];
  if (top)
    sig.push({ kind: "score", color: "#3DDC97", symbol: top.symbol, chain: top.chain, text: `hits a Dexvra Score of <b>${top.score}</b> — strongest signal right now`, minutesAgo: 2 });

  const whale = [...tokens].sort((a, b) => b.vol["1h"] - a.vol["1h"])[0];
  if (whale)
    sig.push({ kind: "whale", color: "#7CE0B0", symbol: whale.symbol, chain: whale.chain, text: `whale inflow — <b>${fmtCap(whale.vol["1h"])}</b> volume in the last hour`, minutesAgo: 7 });

  const mover = [...tokens].sort((a, b) => b.chg["1h"] - a.chg["1h"])[0];
  if (mover && mover.chg["1h"] > 0)
    sig.push({ kind: "volume", color: "#E7C77A", symbol: mover.symbol, chain: mover.chain, text: `momentum spike <b>+${mover.chg["1h"].toFixed(1)}%</b> in 1h`, minutesAgo: 11 });

  const fresh = [...tokens].sort((a, b) => a.listedMinutesAgo - b.listedMinutesAgo)[0];
  if (fresh)
    sig.push({ kind: "listing", color: "#B79CFF", symbol: fresh.symbol, chain: fresh.chain, text: `new paid listing on <b>${CHAINS[fresh.chain]?.label ?? fresh.chain}</b>`, minutesAgo: fresh.listedMinutesAgo });

  const safe = [...tokens].filter((t) => t.taxPct === 0 && (t.liq ?? 0) > 3e6).sort((a, b) => (b.liq ?? 0) - (a.liq ?? 0))[0];
  if (safe)
    sig.push({ kind: "lock", color: "#3DDC97", symbol: safe.symbol, chain: safe.chain, text: `deep liquidity <b>${fmtCap(safe.liq)}</b>, 0% tax`, minutesAgo: 19 });

  return sig;
}

function buildWire(signals: Signal[]): WireItem[] {
  return signals.slice(0, 3).map((s) => ({
    color: s.color,
    html: `<b>${esc(s.symbol)}</b> ${s.text}`,
    time: s.minutesAgo < 60 ? `${s.minutesAgo}m` : `${Math.round(s.minutesAgo / 60)}h`,
  }));
}

export async function getTokensPayload(): Promise<TokensPayload> {
  let tokens: BoardToken[];
  let live = true;
  try {
    tokens = await cached("listings:market", PRICE_TTL, loadListedTokens);
  } catch {
    tokens = rowsToBoardTokens(await loadRows());
    live = false;
  }
  const signals = buildSignals(tokens);
  return {
    tokens,
    heat: buildHeat(tokens),
    signals,
    wire: buildWire(signals),
    trackedVol24h: tokens.reduce((s, t) => s + t.vol["24h"], 0),
    live,
    updatedAt: Date.now(),
  };
}

export async function getFearGreed(): Promise<FearGreed> {
  try {
    return await cached("fng", FNG_TTL, fetchFearGreed);
  } catch {
    return SEED_FEAR_GREED;
  }
}
