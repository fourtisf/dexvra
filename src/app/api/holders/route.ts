import { NextRequest, NextResponse } from "next/server";
import { cache, cached } from "@/lib/cache";
import { CHAINS } from "@/config/chains";
import { safeAddress } from "@/lib/providers/gtPool";
import { readHolders, type HolderCount } from "@/lib/providers/holders";

export const dynamic = "force-dynamic";

const BUILD = process.env.NEXT_PUBLIC_BUILD ?? "unknown";

/** A holder count moves slowly; a page view must not re-ask an explorer. */
const TTL_MS = 15 * 60_000;
/** How long "nobody could give us a count" is remembered before we ask again.
 *  Short, and deliberately a separate key: a MISS is never written where the
 *  count lives, so a measured number from an hour ago keeps being served
 *  (stale-while-revalidate) through an explorer outage rather than being
 *  replaced by "—". */
const MISS_MS = 90_000;

class NoCount extends Error {}

/**
 * How many wallets hold a token — asked ONLY by the token page, never by the
 * board cycle, because ~200 listings × an explorer request every minute is a
 * budget nobody has and a count nobody is looking at.
 *
 * ⚠️ The chain is validated BEFORE a cache key is built from it: the cache is
 * bounded, but a key built from an unchecked query string is still a slot
 * spent on an answer nobody can use — the `/api/ohlcv` rule.
 */
export async function GET(req: NextRequest) {
  const chain = (req.nextUrl.searchParams.get("chain") ?? "").trim();
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  const cfg = CHAINS[chain];
  if (!cfg || !safeAddress(address) || !cfg.addressPattern.test(address)) {
    return NextResponse.json({ build: BUILD, count: null, source: null, why: "unknown chain or address" });
  }
  const addr = address.startsWith("0x") ? address.toLowerCase() : address;
  const key = `holders:${chain}:${addr}`;
  const missKey = `holders-miss:${chain}:${addr}`;

  const recentMiss = cache.get<string>(missKey);
  const held = cache.getStale<HolderCount>(key);
  if (recentMiss !== undefined && held === undefined) {
    return NextResponse.json({ build: BUILD, count: null, source: null, why: recentMiss });
  }
  try {
    const r = await cached<HolderCount>(key, TTL_MS, async () => {
      const got = await readHolders(chain, addr);
      if (got.count == null) throw new NoCount(got.why ?? "no count");
      return got;
    });
    return NextResponse.json({ build: BUILD, ...r });
  } catch (err) {
    const why = err instanceof NoCount ? err.message : "could not read the holder count";
    cache.set(missKey, why, MISS_MS);
    return NextResponse.json({ build: BUILD, count: null, source: null, why });
  }
}
