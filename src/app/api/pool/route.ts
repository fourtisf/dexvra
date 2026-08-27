import { NextRequest, NextResponse } from "next/server";
import { CHAINS } from "@/config/chains";
import { cached } from "@/lib/cache";
import { dexChain, dexEmbedUrl } from "@/lib/dexscreener";

export const dynamic = "force-dynamic";

const POOL_TTL = 10 * 60_000;

// Resolve a token's deepest pool so a client can embed its chart. Chart
// embeds are keyed by pool/pair address, not token address. DexScreener is
// the chart source and answers first; GeckoTerminal is the fallback for a
// token it doesn't index.

async function dexScreenerPair(chain: string, address: string): Promise<string | null> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const json = (await res.json()) as {
    pairs?: { chainId?: string; pairAddress?: string; liquidity?: { usd?: number } }[] | null;
  };
  const onChain = (json.pairs ?? []).filter((p) => p.chainId === dexChain(chain) && p.pairAddress);
  if (!onChain.length) return null;
  // Deepest liquidity — same rule the provider layer uses, so the chart the
  // client embeds is the one the board quotes from.
  return onChain.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a)).pairAddress ?? null;
}

async function geckoTerminalPool(network: string, address: string): Promise<string | null> {
  const res = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`,
    { headers: { accept: "application/json;version=20230302" }, signal: AbortSignal.timeout(8000), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
  const json = (await res.json()) as { data?: { attributes?: { address?: string }; id?: string }[] };
  const top = json.data?.[0];
  if (!top) return null;
  // pool id looks like "<network>_<address>"; fall back to that if attributes.address is absent
  return top.attributes?.address ?? top.id?.split("_").slice(1).join("_") ?? null;
}

async function topPool(chain: string, address: string): Promise<string | null> {
  if (dexChain(chain)) {
    try {
      const pair = await dexScreenerPair(chain, address);
      if (pair) return pair;
    } catch {
      // fall through to GeckoTerminal
    }
  }
  const network = CHAINS[chain]?.geckoNetwork;
  return network ? geckoTerminalPool(network, address) : null;
}

export async function GET(req: NextRequest) {
  const chain = (req.nextUrl.searchParams.get("chain") ?? "").trim();
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  const cfg = CHAINS[chain];
  const network = cfg?.geckoNetwork ?? null;
  if (!cfg || !address || address.length > 90 || /[^A-Za-z0-9:_-]/.test(address)) {
    return NextResponse.json({ network: null, poolAddress: null, chartUrl: null }, { status: 200 });
  }
  try {
    const poolAddress = await cached(`pool:${chain}:${address}`, POOL_TTL, () => topPool(chain, address));
    return NextResponse.json({ network, poolAddress, chartUrl: dexEmbedUrl(chain, address, poolAddress) });
  } catch {
    // The embed resolves a bare token address to its top pair, so a failed
    // lookup still yields a working chart URL.
    return NextResponse.json({ network, poolAddress: null, chartUrl: dexEmbedUrl(chain, address) });
  }
}
