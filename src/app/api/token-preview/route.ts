import { NextRequest, NextResponse } from "next/server";
import { CHAINS } from "@/config/chains";
import { cached } from "@/lib/cache";

export const dynamic = "force-dynamic";

const TTL = 5 * 60_000;

/**
 * Live market data for ANY contract on a supported chain — listed or not.
 *
 * This exists for the token page's not-yet-listed state. Every other market
 * read in the app is keyed off the listings store, which by definition knows
 * nothing about a token nobody has paid to list; without this the page could
 * show a ticker and a dead end, which is what it used to do.
 *
 * Deliberately read-only and unauthenticated: it returns what GeckoTerminal
 * already publishes about a public contract, nothing about Dexvra.
 */
interface Preview {
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  mcap: number | null;
  logoUrl: string | null;
  poolAddress: string | null;
}

const num = (s: unknown): number | null => {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

async function fetchPreview(network: string, address: string): Promise<Preview | null> {
  const res = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}?include=top_pools`,
    { headers: { accept: "application/json;version=20230302" }, signal: AbortSignal.timeout(8000), cache: "no-store" },
  );
  // 404 is a real answer — that contract is not indexed — and must not be
  // retried or cached as an error. The page copes with a null.
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`GeckoTerminal ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: { attributes?: Record<string, unknown>; relationships?: { top_pools?: { data?: { id?: string }[] } } };
    included?: { id?: string; attributes?: { address?: string } }[];
  };
  const a = json.data?.attributes;
  if (!a) return null;
  const topId = json.data?.relationships?.top_pools?.data?.[0]?.id;
  const pool = (json.included ?? []).find((p) => p.id === topId);
  const img = typeof a.image_url === "string" ? a.image_url : null;
  return {
    name: typeof a.name === "string" ? a.name : null,
    symbol: typeof a.symbol === "string" ? a.symbol : null,
    priceUsd: num(a.price_usd),
    // fdv is what a not-yet-circulating memecoin actually reports; market_cap
    // is frequently null on GT for exactly the tokens that land on this page.
    mcap: num(a.market_cap_usd) ?? num(a.fdv_usd),
    logoUrl: img && !img.endsWith("missing.png") ? img : null,
    poolAddress: pool?.attributes?.address ?? topId?.split("_").slice(1).join("_") ?? null,
  };
}

/**
 * Which chains a raw address could possibly be on, by SHAPE.
 *
 * Ordered most-likely-first within each family. Sui is tested before the plain
 * 40-hex EVM pattern because its ids also start 0x — the EVM regex is
 * exact-length so it would not match anyway, but relying on that is a trap for
 * whoever edits the pattern next.
 */
const SHAPES: [RegExp, string[]][] = [
  [/^0x[a-fA-F0-9]+::/, ["sui"]],
  [/^0x[a-fA-F0-9]{40}$/, ["ethereum", "bsc", "base", "arbitrum", "polygon", "avalanche", "optimism", "plasma"]],
  [/^T[1-9A-HJ-NP-Za-km-z]{33}$/, ["tron"]],
  [/^(EQ|UQ|0:)/, ["ton"]],
  [/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, ["solana"]],
];

const candidateChains = (address: string): string[] =>
  SHAPES.find(([re]) => re.test(address))?.[1].filter((c) => CHAINS[c]?.geckoNetwork) ?? [];

/**
 * Find a contract on whichever chain actually has it.
 *
 * One address shape covers eight EVM chains, so they are probed IN PARALLEL —
 * sequentially this is eight round trips before the search box can say
 * anything, and the person typing has already given up. Ties break on market
 * cap: the same address is deployed on several chains often enough (a bridged
 * token, a copycat) that "first to answer" would be a race deciding which one
 * a user sees.
 */
async function findAnyChain(address: string): Promise<{ chain: string; token: Preview } | null> {
  const found = await Promise.all(
    candidateChains(address).map(async (chain) => {
      try {
        const network = CHAINS[chain].geckoNetwork as string;
        const token = await cached(`preview:${network}:${address}`, TTL, () => fetchPreview(network, address));
        return token ? { chain, token } : null;
      } catch {
        return null;
      }
    }),
  );
  const hits = found.filter((x): x is { chain: string; token: Preview } => !!x);
  hits.sort((a, b) => (b.token.mcap ?? 0) - (a.token.mcap ?? 0));
  return hits[0] ?? null;
}

export async function GET(req: NextRequest) {
  const chain = (req.nextUrl.searchParams.get("chain") ?? "").trim();
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  // The address goes into an upstream URL path, so it is bounded and character
  // -restricted here rather than trusted — the same guard /api/pool uses.
  if (!address || address.length > 90 || /[^A-Za-z0-9:_-]/.test(address)) {
    return NextResponse.json({ token: null, chain: null }, { status: 200 });
  }
  try {
    // No chain given — the search box has a pasted CA and nothing else. Work
    // out which chain it is on rather than making the person pick.
    if (!chain) {
      const hit = await findAnyChain(address);
      return NextResponse.json({ token: hit?.token ?? null, chain: hit?.chain ?? null });
    }
    const network = CHAINS[chain]?.geckoNetwork;
    if (!network) return NextResponse.json({ token: null, chain: null }, { status: 200 });
    const token = await cached(`preview:${network}:${address}`, TTL, () => fetchPreview(network, address));
    return NextResponse.json({ token, chain: token ? chain : null });
  } catch {
    // A feed outage must not turn the page into an error screen — it still has
    // the network, the contract and the way to list it.
    return NextResponse.json({ token: null, chain: null });
  }
}
