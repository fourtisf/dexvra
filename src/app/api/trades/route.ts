import { NextRequest, NextResponse } from "next/server";
import { CHAINS } from "@/config/chains";
import { cached } from "@/lib/cache";
import type { Trade } from "@/lib/types";

export const dynamic = "force-dynamic";

const TRADES_TTL = 20_000;

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

async function fetchTrades(network: string, pool: string): Promise<Trade[]> {
  const res = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/trades`,
    { headers: { accept: "application/json;version=20230302" }, signal: AbortSignal.timeout(9000), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
  const json = (await res.json()) as { data?: GtTrade[] };
  return (json.data ?? []).slice(0, 40).map((tr) => {
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

export async function GET(req: NextRequest) {
  const chain = (req.nextUrl.searchParams.get("chain") ?? "").trim();
  const pool = (req.nextUrl.searchParams.get("pool") ?? "").trim();
  const network = CHAINS[chain]?.geckoNetwork;
  if (!network || !pool || pool.length > 90 || /[^A-Za-z0-9:_-]/.test(pool)) {
    return NextResponse.json({ trades: [] });
  }
  try {
    const trades = await cached(`trades:${network}:${pool}`, TRADES_TTL, () => fetchTrades(network, pool));
    return NextResponse.json({ trades });
  } catch {
    return NextResponse.json({ trades: [] });
  }
}
