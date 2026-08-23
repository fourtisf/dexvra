import { NextRequest, NextResponse } from "next/server";
import { CHAINS } from "@/config/chains";
import { cached } from "@/lib/cache";
import { gtGet } from "@/lib/providers/gt";
import { readWhy } from "@/lib/providers/gtPool";
import type { Trade } from "@/lib/types";

export const dynamic = "force-dynamic";

// Short TTL so the client's ~12s poll gets genuinely fresh trades, while the
// cache still coalesces concurrent viewers of the same pool into one upstream hit.
const TRADES_TTL = 8_000;

interface GtTrade {
  attributes: {
    block_timestamp: string;
    tx_from_address: string;
    from_token_amount: string;
    to_token_amount: string;
    price_from_in_usd: string | null;
    price_to_in_usd: string | null;
    volume_in_usd: string | null;
    kind: "buy" | "sell";
  };
}

async function fetchOnce(network: string, pool: string): Promise<Trade[]> {
  // Through the shared client: this route is polled every ~12s by every open
  // token page, so it is one of the app's biggest GT consumers and must be
  // silenced by a 429 anybody else earned.
  const res = await gtGet<{ data?: GtTrade[] }>(
    // trade_volume_in_usd_greater_than=0 keeps out dust; GeckoTerminal returns
    // the most recent ~300 trades for the pool — we surface the freshest 60.
    `/networks/${network}/pools/${pool}/trades`,
    { trade_volume_in_usd_greater_than: 0 },
  );
  if (!res.ok) throw new Error(res.reason ?? "GeckoTerminal failed");
  return (res.body?.data ?? []).slice(0, 60).map((tr) => {
    const a = tr.attributes;
    const buy = a.kind === "buy";
    return {
      ts: Math.floor(Date.parse(a.block_timestamp) / 1000),
      kind: a.kind,
      usd: Number(a.volume_in_usd ?? 0),
      amount: Number(buy ? a.to_token_amount : a.from_token_amount) || 0,
      price: Number((buy ? a.price_to_in_usd : a.price_from_in_usd) ?? 0) || 0,
      trader: a.tx_from_address ?? "",
    };
  });
}

// One retry after a short delay — GeckoTerminal occasionally rate-limits a
// first hit; a single retry recovers it without stalling the panel on demo.
async function fetchTrades(network: string, pool: string): Promise<Trade[]> {
  try {
    return await fetchOnce(network, pool);
  } catch {
    await new Promise((r) => setTimeout(r, 600));
    return fetchOnce(network, pool);
  }
}

export async function GET(req: NextRequest) {
  const chain = (req.nextUrl.searchParams.get("chain") ?? "").trim();
  const pool = (req.nextUrl.searchParams.get("pool") ?? "").trim();
  const network = CHAINS[chain]?.geckoNetwork;
  if (!network || !pool || pool.length > 90 || /[^A-Za-z0-9:_-]/.test(pool)) {
    return NextResponse.json({ trades: [], why: "No indexed pool for this token yet." });
  }
  try {
    const trades = await cached(`trades:${network}:${pool}`, TRADES_TTL, () => fetchTrades(network, pool));
    // An empty list from a pool that DOES exist is an answer: nothing has
    // traded in the window. It is not the same as "we could not look".
    return NextResponse.json({ trades, why: trades.length ? null : "No trades in this pool's recent window." });
  } catch (err) {
    // ⚠️ THE REASON TRAVELS. The panel used to receive a bare empty list for
    // every failure and answer it by DRAWING TWELVE INVENTED TRADES — see
    // components/TokenTrades. Whatever it renders now, it renders knowing
    // which of the two things happened.
    return NextResponse.json({ trades: [], why: `Couldn't read recent trades just now (${readWhy(err)}).` });
  }
}
