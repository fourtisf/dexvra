import { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { networkOf, readWhy, safeAddress, topPoolAddress } from "@/lib/providers/gtPool";
import { TF, normalizeCandles, tfOf, type Candle, type Timeframe } from "@/lib/ohlcv";

export const dynamic = "force-dynamic";

/**
 * Candles for one token, from the pool it actually trades on.
 *
 * The token page used to embed GeckoTerminal's own chart in an iframe when it
 * happened to know a pool address, and draw a hash-generated squiggle when it
 * did not. This serves the numbers instead, so the page can draw a real
 * candlestick chart in the site's own type and colour — and so "we could not
 * read the chart" stops being indistinguishable from "this token has no
 * history", which is the shape of every reporting bug in this repo.
 */

const BASE = "https://api.geckoterminal.com/api/v2";
const HEADERS = { accept: "application/json;version=20230302" };
const POOL_TTL = 10 * 60_000;

export interface OhlcvResponse {
  ok: boolean;
  /**
   * WHICH BUILD ANSWERED. Not decoration: a chart that fails and a chart whose
   * fix was never deployed are indistinguishable from the outside, and working
   * that out has now cost a round trip on this very endpoint — the server had
   * merged a stale ref, so the answer came from the old code and said so
   * nowhere. `/api/token-preview` carries the same stamp for the same reason.
   */
  build: string;
  /** GeckoTerminal network id — the client builds its "open on GT" link from
   *  this plus `pool`, so it never has to re-derive either. */
  network: string | null;
  pool: string | null;
  tf: Timeframe;
  candles: Candle[];
  /** Why there are no candles. Populated ONLY when `ok` is false, and written
   *  for a person reading a chart panel, not for a log. */
  why: string | null;
}

const BUILD = process.env.NEXT_PUBLIC_BUILD ?? "unknown";

const fail = (tf: Timeframe, why: string, network: string | null = null, pool: string | null = null): OhlcvResponse => ({
  ok: false,
  build: BUILD,
  network,
  pool,
  tf,
  candles: [],
  why,
});

/** A GT read that ANSWERED with nothing (404 / 4xx) versus one that never
 *  happened. Only the first may be cached — caching a 429 would let a two
 *  minute backoff blank every chart on the site for the TTL, which is the
 *  bot's `changeFromCandles` lesson, one surface over. */
class Unreadable extends Error {}

async function fetchCandles(network: string, pool: string, token: string, tf: Timeframe): Promise<Candle[] | null> {
  const spec = TF[tf];
  const qs = new URLSearchParams({
    aggregate: String(spec.aggregate),
    limit: String(spec.limit),
    currency: "usd",
    // ⚠️ OUR token, never the pool's base side. GT's OHLCV defaults to `base`,
    // which is our token only by luck: in a WETH/OURTOKEN pool it is WETH, and
    // the page would draw Ethereum's chart under a memecoin's ticker. That is a
    // WRONG number rather than a missing one — the worse of the two — and the
    // bot repo names the same address for the same reason.
    token,
  });
  const res = await fetch(`${BASE}/networks/${network}/pools/${pool}/ohlcv/${spec.path}?${qs}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(9000),
    cache: "no-store",
  });
  // 404: GT does not index this pool — an answer about the pool, cacheable, and
  // the signal the caller uses to go and resolve a pool it does know.
  if (res.status === 404) return null;
  if (!res.ok) throw new Unreadable(`GeckoTerminal ${res.status}`);
  const json = (await res.json()) as { data?: { attributes?: { ohlcv_list?: unknown } } };
  return normalizeCandles(json.data?.attributes?.ohlcv_list);
}

async function load(chain: string, address: string, tf: Timeframe, hint: string | null): Promise<OhlcvResponse> {
  const network = networkOf(chain);
  if (!network) return fail(tf, `We don't have a chart source for ${chain} yet.`);

  // A caller-supplied pool is a HINT, not an authority: the token page passes
  // the pool GeckoTerminal named, but a preview built from DexScreener carries
  // a PAIR address GT has never indexed. So a 404 on the hint is not the end of
  // the lookup — it is the reason to ask GT which pool it knows.
  let pool = hint;
  let candles: Candle[] | null = null;
  if (pool) candles = await fetchCandles(network, pool, address, tf);

  // ⚠️ An EMPTY list from the hint is also a reason to go and ask, not only a
  // 404. A DexScreener pair address can be a real-but-thin GT pool that has
  // never traded on this timeframe, and reporting "no candles" for it hides the
  // deep pool that has a year of them. Costs one extra request, in the one case
  // where we were about to draw nothing anyway.
  if (candles == null || candles.length === 0) {
    const resolved = await cached(`pool:${network}:${address}`, POOL_TTL, () => topPoolAddress(network, address));
    if (!resolved) {
      return candles?.length === 0
        ? { ok: false, build: BUILD, network, pool, tf, candles: [], why: "This pool has no candles on this timeframe yet." }
        : fail(
            tf,
            pool
              ? "GeckoTerminal doesn't index a pool for this token yet."
              : "No pool indexed for this token yet — nothing to chart.",
            network,
            null,
          );
    }
    if (resolved !== pool) {
      const deeper = await fetchCandles(network, resolved, address, tf);
      // Only take the deeper pool's answer if it is actually better: a 404 or an
      // empty list there must not throw away candles the hint already gave us.
      if (deeper && (deeper.length > 0 || candles == null)) {
        pool = resolved;
        candles = deeper;
      }
    }
    if (candles == null) return fail(tf, "GeckoTerminal doesn't index a pool for this token yet.", network, pool);
  }

  // An empty list is an ANSWER — a pool this new has not traded a full candle
  // yet — and it is not an error. Saying so beats an empty grid that reads as a
  // broken page.
  if (candles.length === 0)
    return { ok: false, build: BUILD, network, pool, tf, candles: [], why: "This pool has no candles on this timeframe yet." };

  return { ok: true, build: BUILD, network, pool, tf, candles, why: null };
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const chain = (q.get("chain") ?? "").trim();
  const address = (q.get("address") ?? "").trim();
  const hint = (q.get("pool") ?? "").trim();
  const tf = tfOf(q.get("tf"));

  if (!safeAddress(address)) return NextResponse.json(fail(tf, "That contract address isn't one we can chart."));
  // ⚠️ CHECKED BEFORE THE CACHE KEY IS BUILT, not inside the loader. The key is
  // `ohlcv:<chain>:…`, and an unvalidated chain is an unbounded set of keys in
  // a process-lifetime cache — a memory leak anybody could drive from a query
  // string, for answers nobody could use.
  const network = networkOf(chain);
  if (!network) return NextResponse.json(fail(tf, "We don't have a chart source for that chain yet."));
  const pool = safeAddress(hint) ? hint : null;

  try {
    // Keyed on the POOL HINT as well as the token: two callers asking for the
    // same token with different hints must not be served each other's answer.
    const key = `ohlcv:${chain}:${address}:${pool ?? "-"}:${tf}`;
    const out = await cached(key, TF[tf].ttlMs, () => load(chain, address, tf, pool));
    return NextResponse.json(out);
  } catch (err) {
    // Never cached, so the next poll re-asks: this is "GeckoTerminal did not
    // answer", which is about the upstream and not about the token.
    //
    // ⚠️ THE REASON IS NEVER DROPPED. This branch used to print a bare
    // "Couldn't read the chart just now." for everything that was not an
    // `Unreadable`, and the pool lookup throws a plain Error — so the first
    // live failure on the server said nothing at all about whether GeckoTerminal
    // had rate-limited us, 404'd, or was unreachable from that box. Three
    // different problems, one shrug, and the operator left to guess.
    return NextResponse.json(fail(tf, `Couldn't read the chart just now (${readWhy(err)}).`, networkOf(chain), pool));
  }
}
