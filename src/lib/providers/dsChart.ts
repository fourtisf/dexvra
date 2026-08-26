// DexScreener candles — the SECOND source of price history, and the first this
// repo has ever had.
//
// WHY THIS FILE EXISTS
// The token page answered `Chart unavailable right now — Couldn't read the
// chart just now (GeckoTerminal 429 (rate limited))`, and "beberapa token
// chartnya tidak ada, mending tambahkan api dari dexscreener". Both halves of
// that are right, and the reason is an asymmetry this repo has already written
// down twice:
//
//     A PRICE HAS TWO FREE SOURCES; A CANDLE HAS ONE.
//
// GeckoTerminal is the only free OHLCV for an arbitrary DEX token, its ceiling
// is ~30 requests a minute counted PER IP, and this box splits that between the
// bot suite and the web app. One 429 anywhere arms a process-wide cooldown that
// blanks EVERY chart on the site until it lifts — which is exactly the state
// the screenshot was taken in. Cutting our own usage (six GT doors down to one
// client, an hour-long pool cache, DexScreener-first pricing in the bot) made
// the minute go further and could never remove the ceiling. A second source can.
//
// ⚠️ AND THIS IS AN UNVERIFIED REQUEST SHAPE — READ THIS BEFORE TRUSTING IT.
//
// DexScreener publishes NO documented OHLCV endpoint. Its own chart is a
// TradingView chart fed by an internal datafeed, and nothing in this repo has
// ever called it (verified: `io.dexscreener`, `chart/amm` and `/bars` appear
// nowhere). So the request shape below is a GUESS about somebody else's private
// API, from a sandbox that cannot reach the host — the state `pads.js` marks
// `verified: false` and was designed for:
//
//   • EVERY PART OF THE REQUEST IS ENV-OVERRIDABLE. A renamed segment costs a
//     line in `.env`, not a deploy. That is the whole reason it is safe to ship
//     a shape nobody here has exercised.
//   • IT CAN NEVER BE THE ONLY SOURCE. GeckoTerminal stays first whenever it is
//     answerable; this is what runs when GT has already said no.
//   • IT IS MEASURED ON THE BOX, not argued about here. `npm run chart:check`
//     drives this module's real entry point and prints the build stamp —
//     whether an upstream answers is a property of the server's egress today,
//     the rule `raid:check`, `launchpads:check` and `fonts:check` all state.
//   • A FAILURE HERE IS NEVER A CLAIM ABOUT THE TOKEN. `ok:false` means "could
//     not ask"; an empty list with `ok:true` means "asked, nothing there". The
//     two must not collapse, or one bad minute gets cached as "this pool has no
//     history" — the `pumpfunNewX` rule, on the surface that publishes charts.
//
// Relative imports with extensions: node:test resolves this file.
import { CHAINS } from "../../config/chains.ts";
import { normalizeCandles, TF, type Candle, type Timeframe } from "../ohlcv.ts";

/** `Number('')` is 0 — finite, non-negative, and it silently replaced every
 *  default with zero the last four times this repo wrote an env reader (the
 *  launchpad registry, clampInt(null), clampNum's NaN, autoTrend). The BLANK
 *  STRING check is the whole guard, and the absent case is `undefined`. */
function envNum(raw: string | undefined, dflt: number, min: number): number {
  const s = String(raw ?? "").trim();
  if (s === "") return dflt;
  const n = Number(s);
  return Number.isFinite(n) && n >= min ? n : dflt;
}

/** Blank is NOT false. An absent or empty var means ON — only an explicit
 *  0/false/off/no disables. Same rule as `raid/sourceFlag.js` and the launchpad
 *  registry, and deliberately different from `bool()` in the bot's constants:
 *  a `.env` carrying a bare `DS_CHART=` is "never decided", not "refused". */
function envOn(raw: string | undefined): boolean {
  const s = String(raw ?? "").trim().toLowerCase();
  return !(s === "0" || s === "false" || s === "off" || s === "no");
}

const strip = (s: string) => s.trim().replace(/\/+$/, "");

/**
 * A BASE LIST, current first — never one hardcoded host.
 *
 * `DS_CHART_API` pins one base AND SKIPS THE LIST: an override and a skip, the
 * same contract `<CHAIN>_V4_POOLMANAGER`, `JUP_BASE` and `LAUNCHPAD_<PAD>_API`
 * already have. An operator who has pinned a host must not have it silently
 * outvoted by a default further down.
 */
export function dsChartBases(override = "", extra = ""): string[] {
  const pinned = strip(override);
  if (pinned) return [pinned];
  const list = strip(extra)
    .split(",")
    .map(strip)
    .filter(Boolean);
  return [...list, "https://io.dexscreener.com"];
}

/**
 * PATH TEMPLATES, tried in order. `{dex}` `{chain}` `{pair}` are filled in.
 *
 * Two spellings ship because DexScreener's own frontend uses a different one
 * per AMM family, and which family a pair belongs to is not something the
 * documented API tells us. `DS_CHART_PATH` replaces the list outright.
 */
export function dsChartPaths(override = ""): string[] {
  const pinned = override.trim();
  if (pinned) return pinned.split(",").map((s) => s.trim()).filter(Boolean);
  return ["/dex/chart/amm/v3/{dex}/bars/{chain}/{pair}", "/dex/chart/amm/v2/{dex}/bars/{chain}/{pair}"];
}

const ENABLED = envOn(process.env.DS_CHART);
const BASES = dsChartBases(process.env.DS_CHART_API ?? "", process.env.DS_CHART_BASES ?? "");
/** The DOCUMENTED pair endpoint's host, overridable for the same reason the
 *  chart host is — and because a check that cannot be pointed somewhere is a
 *  check that can only ever be run against production. It is a different host
 *  from the chart one (`api.` versus `io.`), so it needs its own var: pinning
 *  one and silently moving the other is the failure `PUBLIC_API` aliases exist
 *  to prevent. */
const PAIRS_BASE = strip(process.env.DS_PAIRS_API ?? "") || "https://api.dexscreener.com";
const PATHS = dsChartPaths(process.env.DS_CHART_PATH ?? "");
const TIMEOUT_MS = envNum(process.env.DS_CHART_TIMEOUT_MS, 9000, 1000);
/** How long a 429 silences every caller of THIS client. DexScreener's
 *  documented limit is far higher than GeckoTerminal's (300/min on the pair
 *  endpoints against ~30), so this is a courtesy brake rather than a budget —
 *  but it must exist: a client that hammers through its own 429 is precisely
 *  the defect `gt.ts` was written to end, and adding a second upstream without
 *  it would reintroduce it one host over. */
const COOLDOWN_MS = envNum(process.env.DS_CHART_COOLDOWN_MS, 60_000, 1000);

/** The DexScreener pair backing this token, and how it was found. */
export interface DsPair {
  /** DexScreener's PAIR address. ⚠️ NEVER a GeckoTerminal pool id — see below. */
  pairAddress: string;
  /** DexScreener's own AMM id ("uniswap", "raydium", …), part of the path. */
  dexId: string;
  /** DexScreener's chain slug. */
  chainId: string;
  liquidityUsd: number;
}

export interface DsCandles {
  /** Did DexScreener ANSWER? Never "did it have anything" — a rate limit, a
   *  dead socket and a pool with no history are three different facts and the
   *  caller has to be able to tell them apart. */
  ok: boolean;
  candles: Candle[];
  pair: DsPair | null;
  /** Why, in words, when `ok` is false. Never dropped. */
  why: string | null;
}

// Next can hold more than one instance of a module, so a per-instance cooldown
// would let one instance hammer through a 429 the other already saw. Same
// globalThis trick, and the same reason, as gt.ts.
const g = globalThis as { __dexvraDsChart?: { until: number } };
const state = g.__dexvraDsChart ?? (g.__dexvraDsChart = { until: 0 });

export const dsInCooldown = (at = Date.now()): boolean => at < state.until;
export const dsCooldownLeftMs = (at = Date.now()): number => Math.max(0, state.until - at);
export function dsArmCooldown(ms = COOLDOWN_MS, at = Date.now()): void {
  const until = at + Math.max(1000, ms);
  if (until > state.until) state.until = until;
}
/** Test seam — the cooldown is process-wide by design. */
export function _dsChartReset(): void {
  state.until = 0;
}

/** Whether this source is available at all for a chain. `null` in the registry
 *  means DexScreener does not carry it (Robinhood), which costs one source and
 *  never a failure — the rule `chains.ts` already states for every other id. */
export const dsChartCovers = (chain: string): boolean => ENABLED && Boolean(CHAINS[chain]?.dexscreener);

/**
 * A timeframe in DexScreener's resolution vocabulary.
 *
 * TradingView's UDF spelling — minutes as a bare number, days as `1D` — which
 * is what a TradingView-backed datafeed takes. A TABLE and not arithmetic, for
 * the same reason `TF` is one: a combination the upstream does not serve comes
 * back an error, so the mapping has to be written down rather than derived.
 */
export const DS_RES: Record<Timeframe, string> = {
  "5m": "5",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "1D",
};

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * One bar → the `[t, o, h, l, c, v]` row `normalizeCandles` already owns.
 *
 * ⚠️ TIMESTAMPS ARRIVE IN MILLISECONDS AND EVERYTHING DOWNSTREAM IS SECONDS.
 * `Candle.t` is documented as seconds (GeckoTerminal's unit), CandleChart
 * multiplies by 1000 to build a Date, and `normalizeCandles` refuses a stamp
 * more than six hours in the future — so a millisecond stamp is not merely
 * wrong, it is silently DROPPED as "the future", every candle, leaving an empty
 * list and a panel reporting "no candles on this timeframe" about a source that
 * answered perfectly. That is the `normalize.toMs` scar, pointing the other
 * way. A value big enough to be milliseconds is converted; one already in
 * seconds is left alone, because both spellings are plausible from an
 * undocumented feed and guessing one costs the whole chart.
 *
 * The field vocabulary is deliberately WIDE for the same reason the launchpad
 * normaliser's is: this is not a published contract, and a renamed key must
 * cost nothing.
 */
export function barToRow(bar: unknown): [number, number, number, number, number, number] | null {
  if (Array.isArray(bar)) {
    // Some UDF-shaped feeds send parallel arrays per bar.
    const t = num(bar[0]);
    const o = num(bar[1]);
    const h = num(bar[2]);
    const l = num(bar[3]);
    const c = num(bar[4]);
    if (t == null || o == null || h == null || l == null || c == null) return null;
    return [toSeconds(t), o, h, l, c, num(bar[5]) ?? 0];
  }
  if (!bar || typeof bar !== "object") return null;
  const b = bar as Record<string, unknown>;
  const pick = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = num(b[k]);
      if (v != null) return v;
    }
    return null;
  };
  const t = pick("t", "time", "timestamp", "ts");
  const o = pick("o", "open", "openUsd", "open_usd");
  const h = pick("h", "high", "highUsd", "high_usd");
  const l = pick("l", "low", "lowUsd", "low_usd");
  const c = pick("c", "close", "closeUsd", "close_usd");
  if (t == null || o == null || h == null || l == null || c == null) return null;
  return [toSeconds(t), o, h, l, c, pick("v", "volume", "volumeUsd", "volume_usd") ?? 0];
}

/** Milliseconds → seconds, by MAGNITUDE rather than by trust. 1e12 seconds is
 *  the year 33658; any stamp above it is milliseconds. Below it, leaving the
 *  value alone is right for a real seconds stamp and harmless for anything else
 *  — `normalizeCandles` refuses what it cannot place. */
const MS_THRESHOLD = 1e12;
export const toSeconds = (t: number): number => (Math.abs(t) >= MS_THRESHOLD ? Math.floor(t / 1000) : Math.floor(t));

/** Every shape the payload's bar list has been seen in, and the ones it
 *  plausibly could be. An envelope key that is not here costs the chart, which
 *  is why `DS_CHART_BARS_KEY` can name one. */
export function barsOf(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const extra = String(process.env.DS_CHART_BARS_KEY ?? "").trim();
  for (const k of [extra, "bars", "data", "candles", "rows", "result"]) {
    if (!k) continue;
    const v = b[k];
    if (Array.isArray(v)) return v;
    // One level of nesting: `{data: {bars: [...]}}` is as common as the flat form.
    if (v && typeof v === "object") {
      const inner = barsOf(v);
      if (inner) return inner;
    }
  }
  return null;
}

/** Transport-error wording, so `fetch failed` never reaches a caller alone.
 *  undici hides the syscall in `err.cause`; the web app's `readWhy` and the
 *  bots' `netErr()` are the same function three times over. */
function netWhy(err: unknown, host: string): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; errno?: string } };
  const code = e?.cause?.code || e?.cause?.errno || "";
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `${host} timed out`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `${host} could not be resolved (${code})`;
  if (code === "ECONNREFUSED") return `${host} refused the connection`;
  if (code) return `${host}: ${code}`;
  return `${host}: ${e?.message || "request failed"}`;
}

interface Fetched {
  ok: boolean;
  status: number;
  body: unknown;
  why: string | null;
}

async function getJson(url: string, timeoutMs = TIMEOUT_MS): Promise<Fetched> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (res.status === 429) {
      dsArmCooldown();
      void res.body?.cancel().catch(() => {});
      return { ok: false, status: 429, body: null, why: "DexScreener 429 (rate limited)" };
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status, body: null, why: `DexScreener ${res.status}` };
    }
    return { ok: true, status: res.status, body: await res.json(), why: null };
  } catch (err) {
    // status 0 = the request never got an answer. That is the ONLY thing worth
    // trying another base for, and the distinction is the whole failover rule.
    return { ok: false, status: 0, body: null, why: netWhy(err, new URL(url).host) };
  }
}

/**
 * OUR token's deepest DexScreener pair.
 *
 * ⚠️ THE PAIR ADDRESS IS NOT A GECKOTERMINAL POOL ID, and this repo states that
 * rule in seven places already. `dexscreener.ts` refuses to publish one as
 * `poolAddress` precisely because that field feeds GT; `/api/pool` and
 * `/api/trades` read the `pool:` cache and hand its value to GT. A DS pair
 * written into either would 404 inside the token page. So this value lives in
 * its own field, in its own cache namespace, and never touches `poolCache`.
 *
 * BASE-SIDE ONLY: a token also appears as the QUOTE side of somebody else's
 * pair, and charting that pair draws the other asset's price under our ticker.
 * DEEPEST: a real token seen through a thin pool reads as a different asset —
 * the rule every DS and GT reader in this repo already follows.
 */
export async function dsTopPair(chain: string, address: string): Promise<{ ok: boolean; pair: DsPair | null; why: string | null }> {
  const slug = CHAINS[chain]?.dexscreener;
  if (!slug) return { ok: true, pair: null, why: `DexScreener does not carry ${chain}` };
  if (dsInCooldown())
    return { ok: false, pair: null, why: `rate limited — cooling down for ${Math.ceil(dsCooldownLeftMs() / 1000)}s` };

  // The DOCUMENTED endpoint, unlike the bars call below. Addresses go out
  // VERBATIM: hex may be folded, but base58 and TON are case-SENSITIVE.
  const url = `${PAIRS_BASE}/token-pairs/v1/${slug}/${encodeURIComponent(address)}`;
  const res = await getJson(url);
  // A 404 is an ANSWER about the token — DexScreener has no pair for it.
  if (res.status === 404) return { ok: true, pair: null, why: "DexScreener has no pair for this token" };
  if (!res.ok) return { ok: false, pair: null, why: res.why };

  const rows = Array.isArray(res.body) ? res.body : barsOf(res.body) ?? [];
  const want = address.toLowerCase();
  let best: DsPair | null = null;
  for (const raw of rows) {
    const p = raw as {
      chainId?: string;
      dexId?: string;
      pairAddress?: string;
      baseToken?: { address?: string };
      liquidity?: { usd?: number };
    };
    if (!p?.pairAddress || !p?.dexId) continue;
    if (p.chainId && p.chainId !== slug) continue;
    if (String(p.baseToken?.address ?? "").toLowerCase() !== want) continue; // quote-side pair
    const liq = num(p.liquidity?.usd) ?? 0;
    if (!best || liq > best.liquidityUsd)
      best = { pairAddress: p.pairAddress, dexId: p.dexId, chainId: p.chainId ?? slug, liquidityUsd: liq };
  }
  return { ok: true, pair: best, why: best ? null : "DexScreener indexes no pair with this token as the base side" };
}

/** The window a request asks for, in ms — enough candles to fill the same view
 *  GeckoTerminal's `limit` buys, so the two sources draw the same span. */
const windowMsFor = (tf: Timeframe): number => TF[tf].seconds * TF[tf].limit * 1000;

/**
 * Candles for one token from DexScreener.
 *
 * `pair` may be supplied by a caller that already resolved one (the check
 * script does), which saves a request; otherwise it is resolved here.
 */
export async function dsCandles(
  chain: string,
  address: string,
  tf: Timeframe,
  opts: { pair?: DsPair | null; now?: number } = {},
): Promise<DsCandles> {
  if (!ENABLED) return { ok: false, candles: [], pair: null, why: "DexScreener charts are switched off (DS_CHART=0)" };
  if (!CHAINS[chain]?.dexscreener)
    return { ok: true, candles: [], pair: null, why: `DexScreener does not carry ${chain}` };
  if (dsInCooldown())
    return { ok: false, candles: [], pair: null, why: `rate limited — cooling down for ${Math.ceil(dsCooldownLeftMs() / 1000)}s` };

  let pair = opts.pair ?? null;
  if (!pair) {
    const found = await dsTopPair(chain, address);
    if (!found.ok) return { ok: false, candles: [], pair: null, why: found.why };
    if (!found.pair) return { ok: true, candles: [], pair: null, why: found.why };
    pair = found.pair;
  }

  const to = opts.now ?? Date.now();
  const from = to - windowMsFor(tf);
  const qs = `from=${from}&to=${to}&res=${encodeURIComponent(DS_RES[tf])}&cb=${TF[tf].limit}`;
  let lastWhy: string | null = null;

  for (const base of BASES) {
    for (const template of PATHS) {
      const path = template
        .replace("{dex}", encodeURIComponent(pair.dexId))
        .replace("{chain}", encodeURIComponent(pair.chainId))
        .replace("{pair}", encodeURIComponent(pair.pairAddress));
      const res = await getJson(`${base}${path}?${qs}`);

      if (res.ok) {
        const bars = barsOf(res.body);
        // ⚠️ "IT ANSWERED WITH NOTHING" AND "IT ANSWERED IN A SHAPE WE CANNOT
        // READ" ARE DIFFERENT FACTS, and only the first is about the pool. An
        // unreadable envelope is OUR problem and names the env var that fixes
        // it without a deploy — the whole reason this shape may ship unverified.
        if (!bars) {
          lastWhy = "DexScreener answered in an unrecognised shape (set DS_CHART_BARS_KEY)";
          continue;
        }
        // `normalizeCandles` owns every rule about a candle list — order, zero
        // prices, wicks that do not contain their body, duplicate stamps, a
        // future timestamp. One owner, so a second source cannot grow a second
        // idea of what a valid candle is.
        const candles = normalizeCandles(bars.map(barToRow).filter(Boolean), { now: to });
        return { ok: true, candles, pair, why: candles.length ? null : "This pool has no candles on this timeframe yet." };
      }

      lastWhy = res.why;
      // ⚠️ THE TWO FAILOVER RULES ARE DIFFERENT, AND MIXING THEM IS THE BUG.
      //
      // Across BASES: transport only. An HTTP status means the host is there
      // and answered, and the same request gets the same status from every
      // other base — retrying it elsewhere only doubles the latency of a
      // request that was always going to fail. That is `JUP_BASES`' rule
      // verbatim.
      //
      // Across PATHS: a 404 only. This is NOT the same request — it is a
      // different resource on the same host, and "that spelling is not here"
      // is exactly when the other spelling is worth trying. A 429 or a 5xx
      // says nothing about which path is right, so neither is retried.
      if (res.status === 404) continue; // next template
      if (res.status === 0) break; // transport: next base, not next path
      return { ok: false, candles: [], pair, why: res.why };
    }
  }
  return { ok: false, candles: [], pair, why: lastWhy ?? "DexScreener did not answer" };
}

/** The human page for a pair, for the "open it at the source" link. Built from
 *  the DS slug and the PAIR address, which is what dexscreener.com keys on —
 *  the one place a pair address is the right value. */
export const dsPairUrl = (pair: DsPair): string => `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`;

/** What the boot line and the check script report. The KEY-less bases are not a
 *  secret, but they are printed so an operator can see which host a pinned
 *  override actually resolved to. */
export const dsChartConfig = () => ({ enabled: ENABLED, bases: BASES, pairsBase: PAIRS_BASE, paths: PATHS, timeoutMs: TIMEOUT_MS });
