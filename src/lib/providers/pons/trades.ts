// Trade history for a Pons launch, read from its bonding curve's CurveBuy /
// CurveSell logs.
//
// There is no indexer to ask, so we keep a rolling in-process window per curve
// and extend it incrementally: each refresh spends a small, bounded number of
// eth_getLogs calls catching up to the chain head and reaching further back,
// until the configured history window is covered. A cold start therefore
// serves partial-but-real stats within seconds instead of blocking a page load
// on a full backfill — callers get `coverageMinutes` and must not present a
// period longer than that as complete.
import { PONS } from "@/config/pons";
import { decodeLogData, topic0, topicToAddress } from "@/lib/evm/abi";
import { getBlock, getLogs, rpcBatch, rpcSend, type RpcBlockHeader, type RpcLog } from "@/lib/evm/rpc";

const CURVE_BUY = topic0("CurveBuy(address,address,uint256,uint256,uint256,uint256)");
const CURVE_SELL = topic0("CurveSell(address,address,uint256,uint256,uint256,uint256)");

export interface PonsTrade {
  ts: number; // unix seconds (interpolated from the chain head — see blockSeconds)
  block: number;
  logIndex: number;
  kind: "buy" | "sell";
  /** Quote amount on the AMM leg, i.e. net of fee and creator tax. */
  quote: bigint;
  tokens: bigint;
  trader: string;
  tx: string;
}

export interface CurveHistory {
  trades: PonsTrade[]; // ascending by (block, logIndex)
  coverageMinutes: number;
}

interface HistoryState {
  trades: PonsTrade[];
  head: number; // highest block scanned
  tail: number; // lowest block scanned
}

interface ChainHead {
  number: number;
  ts: number;
}

// Survive dev-mode module reloads, like lib/cache.ts.
const g = globalThis as { __ponsHistories?: Map<string, HistoryState> };
const histories: Map<string, HistoryState> = (g.__ponsHistories ??= new Map());

const HEAD_TTL_MS = 5_000;
let headCache: { at: number; value: ChainHead } | null = null;
let secondsPerBlock: number | null = null;

async function fetchHead(): Promise<ChainHead> {
  const now = Date.now();
  if (headCache && now - headCache.at < HEAD_TTL_MS) return headCache.value;
  const block = await rpcSend<RpcBlockHeader>(PONS.rpcUrl, getBlock("latest"), PONS.rpcTimeoutMs);
  const value = { number: Number(BigInt(block.number)), ts: Number(BigInt(block.timestamp)) };
  headCache = { at: now, value };
  return value;
}

/**
 * Observed seconds per block, measured once per process from two real headers.
 * Logs carry no timestamp, so trade times are interpolated from the head; on a
 * fixed-cadence L2 the drift inside a 24h window is well under a bucket.
 */
async function fetchBlockSeconds(head: ChainHead): Promise<number> {
  if (secondsPerBlock !== null) return secondsPerBlock;
  const span = Math.min(100_000, Math.max(1, head.number - 1));
  try {
    const older = await rpcSend<RpcBlockHeader>(
      PONS.rpcUrl,
      getBlock(`0x${(head.number - span).toString(16)}`),
      PONS.rpcTimeoutMs,
    );
    const delta = head.ts - Number(BigInt(older.timestamp));
    secondsPerBlock = delta > 0 ? delta / span : PONS.blockSeconds;
  } catch {
    secondsPerBlock = PONS.blockSeconds;
  }
  return secondsPerBlock;
}

const decodeTrade = (log: RpcLog, tsOf: (block: number) => number): PonsTrade | null => {
  const kind = log.topics[0] === CURVE_BUY ? "buy" : log.topics[0] === CURVE_SELL ? "sell" : null;
  if (!kind) return null;
  let values: unknown[];
  try {
    values = decodeLogData(["uint256", "uint256", "uint256", "uint256"], log.data);
  } catch {
    return null;
  }
  const [a, b, fee, tax] = values as [bigint, bigint, bigint, bigint];
  // CurveBuy(quoteIn, tokensOut, fee, tax) — the trader's spend carries the
  // fee, so the AMM leg is what is left after it.
  // CurveSell(tokensIn, quoteOut, fee, tax) — the payout is already net, so
  // the AMM leg is the payout plus what was withheld.
  const quote = kind === "buy" ? a - fee - tax : b + fee + tax;
  const tokens = kind === "buy" ? b : a;
  if (quote <= 0n || tokens <= 0n) return null;
  const block = Number(BigInt(log.blockNumber));
  return {
    ts: tsOf(block),
    block,
    logIndex: Number(BigInt(log.logIndex ?? "0x0")),
    kind,
    quote,
    tokens,
    trader: log.topics[1] ? topicToAddress(log.topics[1]) : "",
    tx: log.transactionHash ?? "",
  };
};

interface RangeRequest {
  curve: string;
  from: number;
  to: number;
  direction: "forward" | "backward";
}

/**
 * Plans this refresh's log requests: catch up to the head first, then reach
 * further back, never more than `logChunksPerRefresh` calls per curve.
 * Pure with respect to the scanned range — `commitRanges` moves the cursors,
 * and only for ranges that actually came back, so a rejected request is
 * re-planned on the next refresh instead of leaving a hole in the history.
 */
function planRanges(curve: string, head: number, oldestWanted: number): RangeRequest[] {
  let state = histories.get(curve);
  if (!state) {
    // An empty scanned range ([start, start - 1]) so the forward pass below
    // plans the first chunk like any other catch-up.
    const start = Math.max(oldestWanted, head - PONS.logChunkBlocks + 1);
    state = { trades: [], head: start - 1, tail: start };
    histories.set(curve, state);
  }

  const chunk = PONS.logChunkBlocks;
  const plan: RangeRequest[] = [];
  let budget = PONS.logChunksPerRefresh;

  let cursor = state.head;
  while (budget > 0 && cursor < head) {
    const from = cursor + 1;
    const to = Math.min(cursor + chunk, head);
    plan.push({ curve, from, to, direction: "forward" });
    cursor = to;
    budget--;
  }

  let tail = state.tail;
  while (budget > 0 && tail > oldestWanted) {
    const to = tail - 1;
    const from = Math.max(oldestWanted, to - chunk + 1);
    plan.push({ curve, from, to, direction: "backward" });
    tail = from;
    budget--;
  }

  return plan;
}

/** Advances the scanned range over the longest contiguous run of successful
 *  ranges in each direction. */
function commitRanges(curve: string, ranges: { range: RangeRequest; ok: boolean }[]): void {
  const state = histories.get(curve);
  if (!state) return;

  const forward = ranges.filter((r) => r.range.direction === "forward").sort((a, b) => a.range.from - b.range.from);
  for (const entry of forward) {
    if (!entry.ok || entry.range.from !== state.head + 1) break;
    state.head = entry.range.to;
  }

  const backward = ranges.filter((r) => r.range.direction === "backward").sort((a, b) => b.range.to - a.range.to);
  for (const entry of backward) {
    if (!entry.ok || entry.range.to !== state.tail - 1) break;
    state.tail = entry.range.from;
  }
}

function merge(state: HistoryState, incoming: PonsTrade[], cutoffTs: number): void {
  if (incoming.length) {
    const seen = new Set(state.trades.map((t) => `${t.block}:${t.logIndex}`));
    for (const trade of incoming) {
      const key = `${trade.block}:${trade.logIndex}`;
      if (!seen.has(key)) {
        seen.add(key);
        state.trades.push(trade);
      }
    }
    state.trades.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
  }
  const kept = state.trades.filter((t) => t.ts >= cutoffTs);
  if (kept.length !== state.trades.length) state.trades = kept;
}

/**
 * Extends the rolling history of every given curve and returns it. Failures
 * are per-curve: a rejected range leaves that curve's existing window intact.
 */
export async function readCurveHistories(curves: string[]): Promise<Map<string, CurveHistory>> {
  const out = new Map<string, CurveHistory>();
  const unique = [...new Set(curves.map((c) => c.toLowerCase()))];
  if (unique.length === 0) return out;

  const head = await fetchHead();
  const seconds = await fetchBlockSeconds(head);
  const tsOf = (block: number) => Math.round(head.ts - (head.number - block) * seconds);
  const windowBlocks = Math.ceil((PONS.historyMinutes * 60) / Math.max(seconds, 0.01));
  const oldestWanted = Math.max(0, head.number - windowBlocks);
  const cutoffTs = head.ts - PONS.historyMinutes * 60;

  const plan = unique.flatMap((curve) => planRanges(curve, head.number, oldestWanted));
  const results = await rpcBatch(
    PONS.rpcUrl,
    plan.map((range) =>
      getLogs({
        address: range.curve,
        topics: [[CURVE_BUY, CURVE_SELL]],
        fromBlock: `0x${range.from.toString(16)}`,
        toBlock: `0x${range.to.toString(16)}`,
      }),
    ),
    PONS.rpcTimeoutMs,
  );

  const byCurve = new Map<string, PonsTrade[]>();
  const outcomes = new Map<string, { range: RangeRequest; ok: boolean }[]>();
  plan.forEach((range, i) => {
    const outcome = results[i];
    const good = outcome?.ok === true && Array.isArray(outcome.value);
    const entries = outcomes.get(range.curve) ?? [];
    entries.push({ range, ok: good });
    outcomes.set(range.curve, entries);
    if (!good) return;
    const trades = (outcome.value as RpcLog[])
      .map((log) => decodeTrade(log, tsOf))
      .filter((t): t is PonsTrade => t !== null);
    const bucket = byCurve.get(range.curve) ?? [];
    bucket.push(...trades);
    byCurve.set(range.curve, bucket);
  });

  for (const curve of unique) {
    commitRanges(curve, outcomes.get(curve) ?? []);
    const state = histories.get(curve);
    if (!state) continue;
    merge(state, byCurve.get(curve) ?? [], cutoffTs);
    const coveredBlocks = Math.max(0, state.head - state.tail + 1);
    out.set(curve, {
      trades: state.trades,
      coverageMinutes: Math.min(PONS.historyMinutes, Math.floor((coveredBlocks * seconds) / 60)),
    });
  }
  return out;
}

/** Test seam: forget every rolling window (used by the offline unit tests). */
export const __resetHistories = (): void => {
  histories.clear();
  headCache = null;
  secondsPerBlock = null;
};
