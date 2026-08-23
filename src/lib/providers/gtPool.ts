// "Which pool do we chart?" — asked by /api/pool and /api/ohlcv, answered
// HERE, once.
//
// GeckoTerminal keys candles, trades and chart embeds by POOL address, never by
// token address, so every one of those routes needs this lookup. It used to
// live inline in /api/pool; the second caller is exactly the moment this repo's
// standing rule applies — two copies of "where does this token trade" drift,
// and the drift is invisible because both answers are plausible pool addresses.
import { CHAINS } from "../../config/chains.ts";

const BASE = "https://api.geckoterminal.com/api/v2";
const HEADERS = { accept: "application/json;version=20230302" };

interface GtPoolRow {
  id?: string;
  attributes?: { address?: string; reserve_in_usd?: string | null };
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// A pool id looks like "<network>_<poolAddress>"; `attributes.address` is the
// same value when GT sends it, and the id is the fallback when it does not.
const addrOf = (p: GtPoolRow): string | null =>
  p.attributes?.address ?? (p.id ? p.id.split("_").slice(1).join("_") || null : null);

/**
 * The pool a token should be charted on: its DEEPEST.
 *
 * Not "the first one GeckoTerminal returned". A token with several pools seen
 * through a thin one reads as a different asset — a four-figure candle range on
 * a $20k pool, then a flat week — which is the same reason `deepestPool` exists
 * in the market providers and in the bot. Liquidity is the honest tie-break;
 * array order is whatever the upstream happened to do that minute.
 *
 * THROWS on anything that is not an answer (transport failure, 429, 5xx) so the
 * caller's cache stores only facts about the token. A token GT does not index
 * is an answer, and it is `null`.
 */
export async function topPoolAddress(network: string, address: string): Promise<string | null> {
  const res = await fetch(
    `${BASE}/networks/${network}/tokens/${encodeURIComponent(address)}/pools?page=1`,
    { headers: HEADERS, signal: AbortSignal.timeout(9000), cache: "no-store" },
  );
  // 404 = GT has no such token on this network. That is a real answer and must
  // not be retried or thrown; every other status means it never looked.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
  const json = (await res.json()) as { data?: GtPoolRow[] };
  const rows = (json.data ?? []).filter((p) => addrOf(p));
  if (rows.length === 0) return null;
  const deepest = rows.reduce((best, p) =>
    num(p.attributes?.reserve_in_usd) > num(best.attributes?.reserve_in_usd) ? p : best,
  );
  return addrOf(deepest);
}

/** GeckoTerminal network id for one of our chains, or null where we have no
 *  coverage — the single reason a chart can be missing for a whole chain. */
export const networkOf = (chain: string): string | null => CHAINS[chain]?.geckoNetwork ?? null;

/**
 * WHY a GeckoTerminal read failed, in words a chart panel can print.
 *
 * ⚠️ undici puts the syscall in `err.cause`, so an unwrapped transport failure
 * reads as the two words `fetch failed` — which names neither the host nor what
 * went wrong, and cost this repo a round of guessing on the Solana buy path
 * (`netErr()` in the trade bot exists for exactly this). An HTTP status carries
 * its own explanation and is already in the message.
 */
export function readWhy(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } } | null;
  const msg = String(e?.message || "failed");
  const code = e?.cause?.code || e?.cause?.message;
  return code && !msg.includes(String(code)) ? `${msg}: ${code}` : msg;
}

/** Addresses and pool addresses go into an upstream URL PATH, so they are
 *  bounded and character-restricted rather than trusted. Same guard /api/pool
 *  and /api/token-preview already apply, in one place now. */
export const safeAddress = (a: string): boolean => !!a && a.length <= 90 && !/[^A-Za-z0-9:_-]/.test(a);
