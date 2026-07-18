import { NextRequest, NextResponse } from "next/server";
import { CHAINS } from "@/config/chains";
import { cached } from "@/lib/cache";

export const dynamic = "force-dynamic";

const POOL_TTL = 10 * 60_000;

// Resolve a token's top pool so the client can embed the GeckoTerminal chart.
// GeckoTerminal chart embeds are keyed by pool address, not token address.
async function topPool(network: string, address: string): Promise<string | null> {
  const res = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`,
    { headers: { accept: "application/json;version=20230302" }, signal: AbortSignal.timeout(8000), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
  const json = (await res.json()) as {
    data?: { attributes?: { address?: string }; id?: string }[];
  };
  const top = json.data?.[0];
  if (!top) return null;
  // pool id looks like "<network>_<address>"; fall back to that if attributes.address is absent
  return top.attributes?.address ?? top.id?.split("_").slice(1).join("_") ?? null;
}

export async function GET(req: NextRequest) {
  const chain = (req.nextUrl.searchParams.get("chain") ?? "").trim();
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  const network = CHAINS[chain]?.geckoNetwork;
  if (!network || !address || address.length > 90 || /[^A-Za-z0-9:_-]/.test(address)) {
    return NextResponse.json({ network: null, poolAddress: null }, { status: 200 });
  }
  try {
    const poolAddress = await cached(`pool:${network}:${address}`, POOL_TTL, () => topPool(network, address));
    return NextResponse.json({ network, poolAddress });
  } catch {
    return NextResponse.json({ network, poolAddress: null });
  }
}
