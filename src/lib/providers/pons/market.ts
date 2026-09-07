// Turns Pons launch state into the app's normalised market shape.
//
// Two price regimes, one token: while a launch is on its bonding curve the
// price is the curve's marginal price (quote reserve / token reserve, phantom
// reserve included); once it graduates, price comes from the locked Uniswap V4
// pool's sqrtPriceX96. Launches quoted in an ERC-20 rather than native ETH are
// reported without USD figures — we have no reference price for an arbitrary
// quote asset, and a wrong number is worse than none.
import { cached } from "@/lib/cache";
import { fromUnits } from "@/lib/evm/abi";
import { PONS, ponsExplorerUrl, ponsTokenUrl, type GraduationPhase } from "@/config/pons";
import { PERIOD_KEYS, type PeriodKey, type Trade, type TxSplit } from "@/lib/types";
import { fetchTokenPriceUsd } from "../geckoterminal";
import type { LiveMarket } from "../market";
import { readCurveTokenDecimals, readLaunchSnapshots, sortCurrencies, type LaunchSnapshot } from "./contracts";
import { readCurveHistories, type CurveHistory, type PonsTrade } from "./trades";

const NATIVE_USD_TTL = 60_000;
const PERIOD_MINUTES: Record<PeriodKey, number> = { "5m": 5, "1h": 60, "6h": 360, "24h": 1440 };
const Q96 = 2 ** 96;

/** USD price of the chain's native quote asset (ETH). */
export const nativeUsd = (): Promise<number> =>
  cached("pons:native-usd", NATIVE_USD_TTL, () =>
    fetchTokenPriceUsd(PONS.nativeUsdRef.network, PONS.nativeUsdRef.address),
  );

const tokenDecimals = (snapshot: LaunchSnapshot): number => snapshot.meta?.decimals ?? 18;

/** Effective AMM-side price of a trade, in quote per token. */
const tradePrice = (trade: PonsTrade, decimals: number): number => {
  const tokens = fromUnits(trade.tokens, decimals);
  return tokens > 0 ? fromUnits(trade.quote, PONS.nativeDecimals) / tokens : 0;
};

/** Marginal price of the bonding curve, in quote per token. */
function curveSpot(snapshot: LaunchSnapshot): number | null {
  const curve = snapshot.curve;
  if (!curve || curve.graduated || curve.tokenReserve <= 0n) return null;
  const tokens = fromUnits(curve.tokenReserve, tokenDecimals(snapshot));
  if (tokens <= 0) return null;
  return fromUnits(curve.quoteReserve, PONS.nativeDecimals) / tokens;
}

/**
 * Price and quote-side depth of the graduated Uniswap V4 pool. The position is
 * full-range and permanently locked, so `amount = L / sqrtP` (and `L * sqrtP`)
 * describes it to within the negligible tick-bound terms.
 */
function poolSpot(snapshot: LaunchSnapshot): { price: number; quoteAmount: number } | null {
  const pool = snapshot.pool;
  if (!pool || pool.sqrtPriceX96 <= 0n) return null;

  const decimals = tokenDecimals(snapshot);
  const [currency0] = sortCurrencies(snapshot.launch.pairToken, snapshot.launch.token);
  const quoteIsCurrency0 = currency0.toLowerCase() === snapshot.launch.pairToken.toLowerCase();
  const [decimals0, decimals1] = quoteIsCurrency0
    ? [PONS.nativeDecimals, decimals]
    : [decimals, PONS.nativeDecimals];

  const sqrtP = Number(pool.sqrtPriceX96) / Q96;
  if (!Number.isFinite(sqrtP) || sqrtP <= 0) return null;

  // price of currency1 per currency0, corrected for the decimal difference
  const price1Per0 = sqrtP * sqrtP * 10 ** (decimals0 - decimals1);
  if (!Number.isFinite(price1Per0) || price1Per0 <= 0) return null;

  const liquidity = Number(pool.liquidity);
  const amount0 = liquidity > 0 ? liquidity / sqrtP / 10 ** decimals0 : 0;
  const amount1 = liquidity > 0 ? liquidity * sqrtP / 10 ** decimals1 : 0;

  return quoteIsCurrency0
    ? { price: 1 / price1Per0, quoteAmount: amount0 }
    : { price: price1Per0, quoteAmount: amount1 };
}

interface PeriodStats {
  chg: Record<PeriodKey, number>;
  vol: Record<PeriodKey, number>;
  txns: Record<PeriodKey, TxSplit>;
}

const emptyStats = (): PeriodStats => ({
  chg: { "5m": 0, "1h": 0, "6h": 0, "24h": 0 },
  vol: { "5m": 0, "1h": 0, "6h": 0, "24h": 0 },
  txns: {
    "5m": { buys: 0, sells: 0 },
    "1h": { buys: 0, sells: 0 },
    "6h": { buys: 0, sells: 0 },
    "24h": { buys: 0, sells: 0 },
  },
});

/** Per-period volume, txn split and price change from the curve's trade log. */
function periodStats(
  trades: PonsTrade[],
  decimals: number,
  spotQuote: number,
  quoteUsd: number,
  nowSeconds: number,
): PeriodStats {
  const stats = emptyStats();
  for (const period of PERIOD_KEYS) {
    const since = nowSeconds - PERIOD_MINUTES[period] * 60;
    const window = trades.filter((trade) => trade.ts >= since);
    if (window.length === 0) continue;

    let volumeQuote = 0;
    let buys = 0;
    let sells = 0;
    for (const trade of window) {
      volumeQuote += fromUnits(trade.quote, PONS.nativeDecimals);
      if (trade.kind === "buy") buys++;
      else sells++;
    }
    stats.vol[period] = volumeQuote * quoteUsd;
    stats.txns[period] = { buys, sells };

    const opening = tradePrice(window[0], decimals);
    if (opening > 0 && spotQuote > 0) {
      stats.chg[period] = ((spotQuote - opening) / opening) * 100;
    }
  }
  return stats;
}

function buildMarket(
  snapshot: LaunchSnapshot,
  history: CurveHistory | undefined,
  quoteUsd: number,
  nowSeconds: number,
): LiveMarket | null {
  // No USD reference for an ERC-20-quoted launch — skip rather than guess.
  if (!snapshot.launch.nativeQuote) return null;

  const decimals = tokenDecimals(snapshot);
  const trades = history?.trades ?? [];
  const pool = poolSpot(snapshot);
  const last = trades.length ? tradePrice(trades[trades.length - 1], decimals) : 0;
  const spotQuote = pool?.price ?? curveSpot(snapshot) ?? (last > 0 ? last : null);
  if (spotQuote == null || !(spotQuote > 0)) return null;

  const priceUsd = spotQuote * quoteUsd;
  const supply = snapshot.meta ? fromUnits(snapshot.meta.totalSupply, decimals) : 0;

  // On the curve, the honest depth number is the quote actually backing it;
  // after graduation it's the locked pool, counted both sides as usual.
  const liquidityQuote = pool
    ? pool.quoteAmount * 2
    : snapshot.curve && !snapshot.curve.graduated
      ? fromUnits(snapshot.curve.realQuoteReserve, PONS.nativeDecimals)
      // Swept but not yet seeded (or rescued): the curve is drained, so the
      // reserves pulled into the factory are what is actually behind the token.
      : fromUnits(snapshot.launch.sweptQuote, PONS.nativeDecimals);

  const stats = periodStats(trades, decimals, spotQuote, quoteUsd, nowSeconds);

  return {
    priceUsd,
    mcap: supply > 0 ? supply * priceUsd : null,
    liq: liquidityQuote > 0 ? liquidityQuote * quoteUsd : null,
    chg: stats.chg,
    vol: stats.vol,
    txns: stats.txns,
    ageMinutes: null, // Pons keeps no launch timestamp on chain; the listing's own age stands
    logoUrl: snapshot.meta?.logo ?? null,
    // The curve is this launch's "pool" — /api/trades reads its logs.
    poolAddress: snapshot.launch.curve,
    statsCoverageMinutes: history?.coverageMinutes ?? 0,
  };
}

/**
 * Live market data for specific listed addresses on Robinhood Chain, keyed by
 * lowercased address — same contract as the GeckoTerminal provider. Throws on
 * a total failure so the caller can fall back to its own figures.
 */
export async function fetchPonsMarket(addresses: string[]): Promise<Map<string, LiveMarket>> {
  const out = new Map<string, LiveMarket>();
  if (addresses.length === 0) return out;

  const snapshots = await readLaunchSnapshots(addresses.slice(0, 30));
  if (snapshots.size === 0) return out;

  const [quoteUsd, histories] = await Promise.all([
    nativeUsd(),
    readCurveHistories([...snapshots.values()].map((s) => s.launch.curve)).catch(
      () => new Map<string, CurveHistory>(),
    ),
  ]);

  const now = Math.floor(Date.now() / 1000);
  for (const [address, snapshot] of snapshots) {
    const market = buildMarket(snapshot, histories.get(snapshot.launch.curve.toLowerCase()), quoteUsd, now);
    if (market) out.set(address, market);
  }
  return out;
}

export interface LaunchSummary {
  priceUsd: number | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  progressPct: number | null;
}

/** Price, size and curve progress for one snapshot, without a trade window.
 *  Used by the launch feed, which reads many launches and can't afford a log
 *  scan per curve. */
export function summarise(snapshot: LaunchSnapshot, quoteUsd: number | null): LaunchSummary {
  const market = quoteUsd ? buildMarket(snapshot, undefined, quoteUsd, Math.floor(Date.now() / 1000)) : null;
  const threshold = fromUnits(snapshot.launch.graduationThreshold, PONS.nativeDecimals);
  const raised =
    snapshot.curve && !snapshot.curve.graduated
      ? fromUnits(snapshot.curve.realQuoteReserve, PONS.nativeDecimals)
      : fromUnits(snapshot.launch.sweptQuote, PONS.nativeDecimals);
  return {
    priceUsd: market?.priceUsd ?? null,
    mcapUsd: market?.mcap ?? null,
    liquidityUsd: market?.liq ?? null,
    progressPct: threshold > 0 ? Math.min(100, (raised / threshold) * 100) : null,
  };
}

// ── Launch detail (the /api/pons surface) ─────────────────────────────────
export interface PonsLaunchInfo {
  address: string;
  curve: string;
  deployer: string;
  creatorFeeRecipient: string;
  pairToken: string;
  quoteSymbol: string | null;
  phase: GraduationPhase;
  graduated: boolean;
  name: string | null;
  symbol: string | null;
  logo: string | null;
  decimals: number | null;
  totalSupply: string | null;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  /** Curve progress towards graduation, 0–100. */
  progressPct: number | null;
  graduationThresholdQuote: number | null;
  raisedQuote: number | null;
  priceQuote: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  liquidityLocked: boolean;
  poolFee: number;
  tickSpacing: number;
  explorerUrl: string;
  ponsUrl: string;
}

function describe(snapshot: LaunchSnapshot, market: LiveMarket | null, quoteUsd: number | null): PonsLaunchInfo {
  const { launch, curve, meta } = snapshot;
  const threshold = fromUnits(launch.graduationThreshold, PONS.nativeDecimals);
  const raised = curve && !curve.graduated
    ? fromUnits(curve.realQuoteReserve, PONS.nativeDecimals)
    : fromUnits(launch.sweptQuote, PONS.nativeDecimals);
  const graduated = launch.phase !== "NotGraduated";

  return {
    address: launch.token,
    curve: launch.curve,
    deployer: launch.deployer,
    creatorFeeRecipient: launch.creatorFeeRecipient,
    pairToken: launch.pairToken,
    quoteSymbol: launch.nativeQuote ? PONS.nativeSymbol : null,
    phase: launch.phase,
    graduated,
    name: meta?.name || null,
    symbol: meta?.symbol || null,
    logo: meta?.logo ?? null,
    decimals: meta?.decimals ?? null,
    totalSupply: meta ? meta.totalSupply.toString() : null,
    creatorTaxBps: launch.creatorTaxBps,
    buybackEnabled: launch.buybackEnabled,
    progressPct: threshold > 0 ? Math.min(100, (raised / threshold) * 100) : null,
    graduationThresholdQuote: threshold,
    raisedQuote: raised,
    priceQuote: market && quoteUsd ? market.priceUsd / quoteUsd : null,
    priceUsd: market?.priceUsd ?? null,
    mcapUsd: market?.mcap ?? null,
    liquidityUsd: market?.liq ?? null,
    // Graduation locks the V4 position permanently — the locker exposes no
    // withdrawal path at all (PonsV2LaunchLocker).
    liquidityLocked: launch.phase === "PoolCreated",
    poolFee: launch.poolFee,
    tickSpacing: launch.tickSpacing,
    explorerUrl: ponsExplorerUrl(launch.token),
    ponsUrl: ponsTokenUrl(launch.token),
  };
}

/** Full launch detail for one token, or null when Pons never launched it. */
export async function fetchPonsLaunch(address: string): Promise<PonsLaunchInfo | null> {
  const snapshots = await readLaunchSnapshots([address]);
  const snapshot = snapshots.get(address.toLowerCase());
  if (!snapshot) return null;

  const [quoteUsd, histories] = await Promise.all([
    nativeUsd().catch(() => null),
    readCurveHistories([snapshot.launch.curve]).catch(() => new Map<string, CurveHistory>()),
  ]);
  const market = quoteUsd
    ? buildMarket(snapshot, histories.get(snapshot.launch.curve.toLowerCase()), quoteUsd, Math.floor(Date.now() / 1000))
    : null;
  return describe(snapshot, market, quoteUsd);
}

/** Recent trades on a launch's curve, newest first, in the app's Trade shape. */
export async function fetchPonsTrades(curve: string): Promise<Trade[]> {
  const [quoteUsd, decimals, histories] = await Promise.all([
    nativeUsd().catch(() => 0),
    readCurveTokenDecimals(curve).catch(() => 18),
    readCurveHistories([curve]),
  ]);
  const history = histories.get(curve.toLowerCase());
  if (!history) return [];

  return history.trades
    .slice(-60)
    .reverse()
    .map((trade) => {
      const price = tradePrice(trade, decimals);
      return {
        ts: trade.ts,
        kind: trade.kind,
        usd: fromUnits(trade.quote, PONS.nativeDecimals) * quoteUsd,
        amount: fromUnits(trade.tokens, decimals),
        price: price * quoteUsd,
        trader: trade.trader,
      };
    });
}
