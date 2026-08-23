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
import { POOLS_TRADE_CHAIN, fetchLaunchMarket } from "./poolstrade";
import { fetchIndexedMarket } from "./indexedMarket";
import { fillFromLastGood } from "./lastGood";
import { pickLogo } from "./tokenLogo";
import { backfillLogos, knownLogo, rememberLogo, shouldLookUp } from "./logoFill";
import { setResolvedLogo } from "@/lib/store";

// 60s, not 30: at 173 listings a refresh is ~8 chunked GT requests, and the
// bot suite shares this server's IP and GT quota (~30 req/min, its own docs).
// The web app must be the polite tenant — `cached` serves stale on a failed
// refresh, so a missed minute costs staleness, never a DEMO board.
const PRICE_TTL = 60_000;
const FNG_TTL = 10 * 60_000;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Approved paid listings from the admin store; falls back to the seed if the
 *  store can't be read. */
async function loadRows(): Promise<ListingRow[]> {
  try {
    const rows = await approvedRows();
    return expireTrending(rows.length ? rows : SEED_ROWS);
  } catch {
    return SEED_ROWS;
  }
}

/** A paid Trending slot only features a token until `trendExp`. Past it, drop
 *  the featured rank at render time so the board stops featuring it even before
 *  the bot's sweeper clears it in the store. Purely non-mutating. */
function expireTrending(rows: ListingRow[]): ListingRow[] {
  const now = Date.now();
  return rows.map((r) =>
    r.trendExp && r.trendExp < now && r.trendingRank != null
      ? { ...r, trendingRank: undefined }
      : r,
  );
}

/** Live market data for one chain's listings, from every provider that covers
 *  that chain.
 *
 *  GeckoTerminal is the primary everywhere and wins wherever it answers — it
 *  carries the per-period stats and the pool address the chart embed needs. On
 *  the pools.trade chain it is not the whole story: a launch still on its
 *  bonding curve has no liquidity pool, so GT knows nothing about it and the
 *  listing rendered with the figures captured when it was listed. The launchpad
 *  does know it, so it fills those gaps and only those.
 *
 *  Throws only when NO provider for the chain answered, which keeps the
 *  caller's "everything is down → seed data" fallback intact. */
async function fetchChainMarket(chain: string, addrs: string[]): Promise<Map<string, LiveMarket>> {
  if (chain !== POOLS_TRADE_CHAIN) return fetchIndexedMarket(chain, addrs);

  const [gt, launch] = await Promise.allSettled([
    fetchListedMarket(chain, addrs),
    fetchLaunchMarket(chain, addrs),
  ]);
  const primary = gt.status === "fulfilled" ? gt.value : null;
  const secondary = launch.status === "fulfilled" ? launch.value : null;
  // Both providers down for this chain is the one case the caller must see as a
  // failure — reporting an empty map would read as "listed, but no activity".
  if (!primary && !secondary) throw gt.status === "rejected" ? gt.reason : new Error(`no market data (${chain})`);

  const out = new Map(secondary ?? []);
  for (const [addr, m] of primary ?? []) out.set(addr, m); // GT wins on overlap
  return out;
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
      map: await fetchChainMarket(chain, addrs),
    })),
  );
  const anyLive = marketResults.some((r) => r.status === "fulfilled" && r.value.map.size > 0);
  if (!anyLive) throw new Error("no live market data for any listing");

  const live = new Map<string, Map<string, LiveMarket>>();
  for (const r of marketResults) if (r.status === "fulfilled") live.set(r.value.chain, r.value.map);

  // A token the providers priced an hour ago and miss THIS cycle must not
  // collapse to its captured-at-listing figures — that is how a priced row
  // renders a dash for one bad chunk. Memory fills only what the cycle
  // missed; a fresh reading always wins (see lastGood.ts).
  for (const [chain, addrs] of Object.entries(byChain)) {
    const map = live.get(chain) ?? new Map<string, LiveMarket>();
    const filled = fillFromLastGood(chain, map, addrs);
    if (filled.length > 0)
      console.warn(`[market] ${chain}: served last-known reading for ${filled.length} token(s) the providers missed this cycle`);
    if (!live.has(chain) && map.size > 0) live.set(chain, map);
  }

  // The listing row behind each board token, so the logo ladder reads the
  // STORED value rather than the one `rowToBoardToken` already filled with the
  // CDN convention — that guess outranking a real image_url is the whole bug
  // (see pickLogo). Keyed rather than zipped by index: the mapping is 1:1 today
  // and an index that silently drifts would hand one token another's artwork.
  const rowOf = new Map(rows.map((r) => [`${r.chain}:${r.address.toLowerCase()}`, r]));
  // Candidates for the logo sweep, with what it takes to RANK them — the sweep
  // only looks up a handful per pass, so which handful matters.
  const needLogo: { chain: string; address: string; featured: boolean; vol: number }[] = [];

  const tokens = fallback.map((t) => {
    const m = live.get(t.chain)?.get(t.address.toLowerCase());
    // A logo a provider asserted is worth remembering even though we did not
    // have to resolve it: GT drops `image_url` on the odd cycle, and without
    // this the row would flicker back to a monogram whenever it does.
    if (m?.logoUrl) rememberLogo(t.chain, t.address, m.logoUrl);
    const row = rowOf.get(`${t.chain}:${t.address.toLowerCase()}`);
    const logo = pickLogo({
      stored: row?.logoUrl,
      live: m?.logoUrl,
      resolved: knownLogo(t.chain, t.address),
      chain: t.chain,
      address: t.address,
    });
    // "convention" and "none" both mean nobody has actually given this token a
    // logo — the row is drawing a monogram or a guess, and it is exactly what
    // the resolver is for.
    if ((logo.kind === "convention" || logo.kind === "none") && shouldLookUp(t.chain, t.address))
      needLogo.push({
        chain: t.chain,
        address: t.address,
        featured: t.trendingRank != null,
        vol: m?.vol["24h"] ?? t.vol["24h"],
      });

    if (!m) return { ...t, logoUrl: logo.url }; // keep fallback figures for this listing
    const score = dexvraScore({ chg: m.chg, liq: m.liq, taxPct: t.taxPct, txns: m.txns, holders: t.holders });
    const v = visualFor(t.symbol);
    return {
      ...t,
      logoUrl: logo.url,
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

  // FIRE AND FORGET, deliberately. Resolving a logo means up to three
  // rate-limited APIs and a verification fetch — a board render must never wait
  // on that. The sweep is bounded and one-at-a-time (logoFill.ts); what it
  // finds lands in the listing store, so the row is fixed for good rather than
  // for this process's lifetime.
  // RANKED, because a sweep does 8 rows and a board can be short by 80: a
  // featured row and a row nobody scrolls to are not worth the same lookup.
  // (The sweep's own comment says the caller hands them over ranked — this is
  // where that becomes true, rather than a comment describing nothing.)
  needLogo.sort((a, b) => Number(b.featured) - Number(a.featured) || b.vol - a.vol);
  backfillLogos(needLogo, {
    persist: setResolvedLogo,
    log: (msg) => console.log(msg),
  });

  return tokens;
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
