import { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { PONS } from "@/config/pons";
import { fetchPonsLaunch } from "@/lib/providers/pons";

export const dynamic = "force-dynamic";

// Launch state for a Pons v2 token on Robinhood Chain: graduation phase,
// bonding-curve progress, price and the locked-liquidity fact. Read straight
// off the launch factory and the curve — Pons publishes no HTTP API of its own.
const LAUNCH_TTL = 20_000;

export async function GET(req: NextRequest) {
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }

  try {
    const launch = await cached(`pons:launch:${address.toLowerCase()}`, LAUNCH_TTL, () =>
      fetchPonsLaunch(address),
    );
    if (!launch) {
      return NextResponse.json({ error: "not a Pons launch", chain: PONS.chain }, { status: 404 });
    }
    return NextResponse.json(
      { chain: PONS.chain, chainId: PONS.chainId, launchpad: "pons-v2", launch },
      { headers: { "Cache-Control": "public, max-age=10, stale-while-revalidate=30" } },
    );
  } catch {
    return NextResponse.json({ error: "upstream unavailable" }, { status: 503 });
  }
}
