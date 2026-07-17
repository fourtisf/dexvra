import { CHAIN_IDS, CHAINS } from "@/config/chains";
import { cached } from "@/lib/cache";
import { seedTokens } from "@/lib/seed";
import type {
  BoardToken,
  ChainHeat,
  FearGreed,
  TokensPayload,
  WireItem,
} from "@/lib/types";
import { fmtCap } from "@/lib/format";
import { SEED_FEAR_GREED, fetchFearGreed } from "./feargreed";
import { fetchNewPools, fetchTrendingPools } from "./geckoterminal";

const PRICE_TTL = 30_000; // handoff: prices 15–30s
const FNG_TTL = 10 * 60_000;

async function settled<T>(ps: Promise<T[]>[]): Promise<T[]> {
  const results = await Promise.allSettled(ps);
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

function dedupe(tokens: BoardToken[]): BoardToken[] {
  const seen = new Map<string, BoardToken>();
  for (const t of tokens) if (!seen.has(t.key)) seen.set(t.key, t);
  return [...seen.values()];
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
      // "temperature" 0–45°: volume magnitude + average momentum
      temp: Math.max(
        5,
        Math.min(
          45,
          Math.round(Math.log10(Math.max(e.vol, 1)) * 4 + e.chg / e.n / 8),
        ),
      ),
      vol24h: e.vol,
    }))
    .sort((a, b) => b.vol24h - a.vol24h)
    .slice(0, 3);
}

// Wire html is injected with dangerouslySetInnerHTML on the client — token
// symbols come from third-party providers, so escape them here.
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function buildWire(tokens: BoardToken[]): WireItem[] {
  const items: WireItem[] = [];
  const gainer = [...tokens].sort((a, b) => b.chg["24h"] - a.chg["24h"])[0];
  if (gainer)
    items.push({
      color: "#3DF59F",
      html: `<b>${esc(gainer.symbol)}</b> up <b style="color:#3DF59F">${gainer.chg["24h"].toFixed(1)}%</b> in 24h on ${CHAINS[gainer.chain]?.label ?? gainer.chain}`,
      time: "now",
    });
  const fresh = [...tokens]
    .filter((t) => t.ageMinutes != null)
    .sort((a, b) => a.ageMinutes! - b.ageMinutes!)[0];
  if (fresh)
    items.push({
      color: "#A97CFF",
      html: `Fresh pair: <b>${esc(fresh.symbol)}</b> live on <b style="color:#A97CFF">${CHAINS[fresh.chain]?.label ?? fresh.chain}</b> with ${fmtCap(fresh.liq)} liquidity`,
      time: "new",
    });
  return items;
}

async function loadLiveTokens(): Promise<BoardToken[]> {
  const trending = settled(CHAIN_IDS.map((c) => fetchTrendingPools(c)));
  const fresh = settled(CHAIN_IDS.map((c) => fetchNewPools(c)));
  const all = dedupe([...(await trending), ...(await fresh)]);
  if (all.length === 0) throw new Error("no live tokens from any provider");
  return all;
}

export async function getTokensPayload(): Promise<TokensPayload> {
  let tokens: BoardToken[];
  let live = true;
  try {
    tokens = await cached("tokens:all", PRICE_TTL, loadLiveTokens);
  } catch {
    tokens = seedTokens();
    live = false;
  }
  return {
    tokens,
    heat: buildHeat(tokens),
    wire: buildWire(tokens),
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
