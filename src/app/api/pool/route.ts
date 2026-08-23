import { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { networkOf, safeAddress, topPoolAddress } from "@/lib/providers/gtPool";

export const dynamic = "force-dynamic";

const POOL_TTL = 10 * 60_000;

// Resolve a token's top pool. GeckoTerminal keys candles and trades by POOL
// address, not token address, so the client needs this to ask for either.
//
// The lookup itself lives in providers/gtPool — /api/ohlcv needs the same
// answer, and two copies of "where does this token trade" would diverge into
// two plausible-looking pool addresses with nothing to say which is right.
export async function GET(req: NextRequest) {
  const chain = (req.nextUrl.searchParams.get("chain") ?? "").trim();
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  const network = networkOf(chain);
  if (!network || !safeAddress(address)) {
    return NextResponse.json({ network: null, poolAddress: null }, { status: 200 });
  }
  try {
    const poolAddress = await cached(`pool:${network}:${address}`, POOL_TTL, () => topPoolAddress(network, address));
    return NextResponse.json({ network, poolAddress });
  } catch {
    return NextResponse.json({ network, poolAddress: null });
  }
}
