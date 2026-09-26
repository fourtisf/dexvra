// The USD price of Robinhood Chain's native quote asset (ETH) — a LADDER.
//
// "bagaimana kalo token listing di pons v2 dan bot kita tidak bisa baca price
// dan marketcap masih tba" (2026-09-09). A Pons bonding-curve token has no
// pool, so the curve contract is the only place its price lives — and this
// app reads it there perfectly well. It then multiplied by an ETH/USD reference
// that came from GECKOTERMINAL AND NOWHERE ELSE: the one metered source on this
// box, sharing a ~30 req/min per-IP ceiling with the bot suite, budgeted at
// 5/min for the site and armed with a process-wide 120s cooldown on any 429.
// `describe()` nulls priceUsd AND mcapUsd AND priceQuote whenever that read
// fails, so on a busy minute every curve token on the site — and every paid
// post the bot builds through /api/pons — read TBA over a price the chain had
// just answered. A PRICE has more than one free source; a curve's USD figure
// hung on the scarcest one.
//
//   1. Coinbase spot   — keyless, unmetered in practice; the trade bot has
//                        priced every card through it since it was written
//   2. DexScreener     — WETH's own pair on Ethereum, the site's existing reader
//   3. GeckoTerminal   — LAST, because it is the only one that costs a chart
//
// Every rung is bounded, because this sits inside /api/pons, which the bot
// reads with a 5s timeout of its own: a rung that hangs for its full network
// timeout is the same TBA by a longer road. A rung that FAILS says why, and the
// caller carries the reasons — "no USD reference" with three named refusals is
// a diagnosis; a bare null is another round of guessing.
//
// Alias-free (relative imports only) so `npm test` can drive the ladder.
import { PONS } from "../../../config/pons.ts";
import { fetchDsMarket } from "../dexscreener.ts";
import { fetchTokenPriceUsd } from "../geckoterminal.ts";

export type QuoteUsdSource = "coinbase" | "dexscreener" | "geckoterminal" | "peg";

export interface QuoteUsdRead {
  usd: number | null;
  source: QuoteUsdSource | null;
  /** One line per rung that did not answer, in ladder order. Empty on success. */
  why: string[];
}

export interface QuoteUsdDeps {
  coinbase?: () => Promise<number>;
  dexscreener?: () => Promise<number>;
  geckoterminal?: () => Promise<number>;
  /** Per-rung ceiling. */
  stepMs?: number;
}

/** WETH on Ethereum mainnet — the pair DexScreener prices ETH through. */
export const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const COINBASE_SPOT = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
/** Each rung's ceiling. Three rungs at this fit inside the bot's 5s read of
 *  /api/pons with the chain reads running beside them. */
export const STEP_MS = 3000;

async function coinbaseSpot(): Promise<number> {
  const res = await fetch(COINBASE_SPOT, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(STEP_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Coinbase ${res.status}`);
  const j = (await res.json()) as { data?: { amount?: string } };
  const p = Number(j?.data?.amount);
  if (!(p > 0)) throw new Error("Coinbase: no amount");
  return p;
}

async function dexscreenerWeth(): Promise<number> {
  const m = await fetchDsMarket("ethereum", [WETH_MAINNET]);
  const px = m.get(WETH_MAINNET.toLowerCase())?.priceUsd;
  if (!(typeof px === "number" && px > 0)) throw new Error("DexScreener: no WETH price");
  return px;
}

const geckoTerminal = (): Promise<number> =>
  fetchTokenPriceUsd(PONS.nativeUsdRef.network, PONS.nativeUsdRef.address);

/** Race a rung against its ceiling, KEEPING the reason: `within()` in lib/cache
 *  absorbs a rejection, and a rung's own sentence is the whole diagnosis here.
 *  ⚠️ Not `unref`'d — a request is waiting on it. */
function bounded(fn: () => Promise<number>, ms: number): Promise<{ ok: true; value: number } | { ok: false; why: string }> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, why: `no answer inside ${ms}ms` });
    }, ms);
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(value > 0 ? { ok: true, value } : { ok: false, why: `answered ${String(value)}` });
        },
        (e: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve({ ok: false, why: e instanceof Error ? e.message : String(e) });
        },
      );
  });
}

/** The first rung that answers, and every refusal above it. Never throws. */
export async function readNativeUsd(deps: QuoteUsdDeps = {}): Promise<QuoteUsdRead> {
  const stepMs = deps.stepMs ?? STEP_MS;
  const rungs: [QuoteUsdSource, () => Promise<number>][] = [
    ["coinbase", deps.coinbase ?? coinbaseSpot],
    ["dexscreener", deps.dexscreener ?? dexscreenerWeth],
    ["geckoterminal", deps.geckoterminal ?? geckoTerminal],
  ];
  const why: string[] = [];
  for (const [source, fn] of rungs) {
    const r = await bounded(fn, stepMs);
    if (r.ok) return { usd: r.value, source, why };
    why.push(`${source}: ${r.why}`);
  }
  return { usd: null, source: null, why };
}

// ── An ERC-20 quote asset (USDG, a tokenised stock) ───────────────────────
//
// "bot masih gagal membaca tokennya" — $HAPPYCAT, Pons v2, "Paired USDG". The
// provider priced a launch ONLY when it was paired with ETH ("no USD reference
// for an arbitrary quote asset"), so every USDG-paired launch published no
// price and no market cap anywhere: the site, the listing form, the paid post.
// Pons prices those launches in a DOLLAR stablecoin — the pad's own page shows
// "Price in USDG" beside "Price" and they are the same number.
//
//   1. peg        — a stablecoin symbol on a pair token the FACTORY configured.
//                   ⚠️ Symbol-based and still safe, because a launch's pair
//                   token comes from Pons's launch config, never from the
//                   creator: nobody can pair a launch against a fake "USDG".
//                   PONS_USD_PEGGED replaces the set; `PONS_USD_PEGGED=0`
//                   turns the rung off.
//   2. DexScreener — the asset's own market on the chain, for a quote that is
//                   not a dollar (a tokenised stock).
//   3. GeckoTerminal — LAST, the metered one, as in the native ladder.
//
// Display only, like everything in this provider: nothing here authorises a
// swap.
const DEFAULT_PEGGED = ["USDG", "USDC", "USDT", "USDC.E", "USDT0"];

export function peggedSymbols(env: string | undefined = process.env.PONS_USD_PEGGED): Set<string> {
  const raw = (env ?? "").trim();
  if (/^(0|off|false|no)$/i.test(raw)) return new Set();
  const list = raw ? raw.split(",") : DEFAULT_PEGGED;
  return new Set(list.map((s) => s.trim().toUpperCase()).filter(Boolean));
}

export interface QuoteAssetDeps extends QuoteUsdDeps {
  pegged?: Set<string>;
}

/** USD per unit of an ERC-20 quote asset. Never throws. */
export async function readQuoteAssetUsd(
  chain: string,
  address: string,
  symbol: string | null,
  deps: QuoteAssetDeps = {},
): Promise<QuoteUsdRead> {
  const stepMs = deps.stepMs ?? STEP_MS;
  const pegged = deps.pegged ?? peggedSymbols();
  if (symbol && pegged.has(symbol.trim().toUpperCase())) return { usd: 1, source: "peg", why: [] };
  const rungs: [QuoteUsdSource, () => Promise<number>][] = [
    [
      "dexscreener",
      deps.dexscreener ??
        (async () => {
          const m = await fetchDsMarket(chain, [address]);
          const px = m.get(address.toLowerCase())?.priceUsd;
          if (!(typeof px === "number" && px > 0)) throw new Error(`DexScreener: no ${symbol ?? "quote"} price`);
          return px;
        }),
    ],
    ["geckoterminal", deps.geckoterminal ?? (() => fetchTokenPriceUsd(chain, address))],
  ];
  const why: string[] = [];
  for (const [source, fn] of rungs) {
    const r = await bounded(fn, stepMs);
    if (r.ok) return { usd: r.value, source, why };
    why.push(`${source}: ${r.why}`);
  }
  return { usd: null, source: null, why };
}
