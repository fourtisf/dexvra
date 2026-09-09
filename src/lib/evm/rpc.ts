// Tiny JSON-RPC client for EVM reads. Batches by default (a board refresh asks
// for ~6 values per listed token) and degrades to sequential calls when an
// endpoint rejects batch payloads, which some public gateways do.
//
// ⚠️ A REFUSAL IS NOT A FAILED CALL, AND IT IS NEVER RETRIED ONE AT A TIME.
// The public Robinhood node answered HTTP 429 to a whole batch on the box, and
// the fallback below — "the endpoint did not honour the batch, so send the
// calls singly" — then fired twenty-seven serial requests into a host that had
// just said no, each refused in turn, each pushing the box further past the
// limit that every process on it shares (the site, the bot, the trade bot,
// and the diagnostic the operator was running). That is the CoinGecko sweep's
// defect, the DexScreener 403 retry's, and `gt.ts`'s, one transport over.
//
// So a host that refuses (401/403/429, or a JSON-RPC item saying "rate limit")
// is PARKED for a bounded cooldown (Retry-After honoured, clamped) and the same
// calls go to the NEXT host — a rate limit is a fact about the bucket on THAT
// host, the same exception the Jupiter bases and the IPFS gateways carry —
// and with no host left every call fails with the refusal NAMED, so the reader
// can tell "the curve answered no price" from "the node refused to say".
// A transport error, a 5xx or an un-honoured batch still degrade to one call
// at a time on the same host, exactly as before: those say nothing about a
// quota. A sequential run that meets a refusal stops there.

export interface RpcCall {
  method: string;
  params: unknown[];
}

/** `unanswered` marks a failure that is OURS or the transport's — a refusal,
 *  a dead socket, a timeout, a host with nobody left to ask — as opposed to
 *  the node ANSWERING with an error (`execution reverted`, an empty result).
 *  The two are different facts to every caller: a reverted `logo()` is a
 *  token that publishes no logo; a refused one is a read that never
 *  happened, and rendering the second as the first is this file's subject. */
export type RpcOutcome<T> = { ok: true; value: T } | { ok: false; error: string; unanswered?: true };
export const unanswered = (o: RpcOutcome<unknown> | undefined): boolean => !!o && !o.ok && o.unanswered === true;

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string; code?: number };
}

const MAX_BATCH = 40;
const MAX_PARALLEL = 6;

/** How long a refusing host is left alone. Retry-After wins inside the clamp;
 *  a refusal with no Retry-After gets the default. Bounded above so one
 *  eccentric header cannot bench a node for an hour, below so a burst of
 *  callers cannot re-ask inside the same second. */
const COOLDOWN_DEFAULT_MS = 2_000;
const COOLDOWN_MIN_MS = 1_000;
const COOLDOWN_MAX_MS = 10_000;

/** HTTP statuses that are about US (credentials, quota), never about the call. */
const REFUSAL_STATUS = new Set([401, 403, 429]);
/** A JSON-RPC ITEM can carry the same refusal — some nodes answer 200 with
 *  `{"error":{"code":-32005,"message":"rate limit exceeded"}}` per call. */
const RATE_LIMIT_TEXT = /\b429\b|rate.?limit|too many requests|-32005\b/i;

export const isRefusalText = (s: string): boolean => /^rpc (401|403|429)\b/.test(s) || RATE_LIMIT_TEXT.test(s);

class RpcHttpError extends Error {
  status: number;
  retryAfterMs: number | null;
  constructor(status: number, retryAfterMs: number | null) {
    super(`rpc ${status}${status === 429 ? " (rate limited)" : ""}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// ── the bench ─────────────────────────────────────────────────────────────
const cooling = new Map<string, { until: number; why: string }>();

function park(url: string, why: string, retryAfterMs: number | null): void {
  const ms = Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, retryAfterMs ?? COOLDOWN_DEFAULT_MS));
  cooling.set(url, { until: Date.now() + ms, why });
}

/** Why this host is currently benched, or null. */
export function rpcCooling(url: string): string | null {
  const c = cooling.get(url);
  if (!c) return null;
  if (Date.now() >= c.until) {
    cooling.delete(url);
    return null;
  }
  return `${c.why} — cooling down for ${Math.ceil((c.until - Date.now()) / 1000)}s`;
}

/** Test seam: forget every bench. */
export const __resetRpc = (): void => {
  cooling.clear();
};

const hostsOf = (urls: string | string[]): string[] => {
  const list = (Array.isArray(urls) ? urls : [urls]).map((u) => String(u || "").trim()).filter(Boolean);
  if (list.length === 0) throw new Error("no RPC url configured");
  return list;
};

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === "string" ? err : "rpc failed";

async function post(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new RpcHttpError(res.status, parseRetryAfter(res.headers.get("retry-after")));
  return res.json();
}

function unwrap(entry: JsonRpcResponse | undefined): RpcOutcome<unknown> {
  if (!entry) return { ok: false, error: "no response", unanswered: true };
  if (entry.error) return { ok: false, error: entry.error.message ?? `rpc error ${entry.error.code ?? ""}`.trim() };
  if (entry.result === undefined || entry.result === null) return { ok: false, error: "empty result" };
  return { ok: true, value: entry.result };
}

/** One host's answer to one set of calls — outcomes aligned to `calls`, and
 *  `refused` set when the host turned us away part-way or entirely. */
interface HostAttempt {
  outcomes: RpcOutcome<unknown>[];
  refused: string | null;
}

async function sendOne(url: string, call: RpcCall, timeoutMs: number): Promise<RpcOutcome<unknown>> {
  const json = (await post(url, { jsonrpc: "2.0", id: 1, ...call }, timeoutMs)) as JsonRpcResponse;
  return unwrap(json);
}

/** One call at a time, a few in flight — and a refusal STOPS the run: every
 *  call still queued is answered with the refusal, without a request. */
async function sequential(url: string, calls: RpcCall[], timeoutMs: number): Promise<HostAttempt> {
  const out = new Array<RpcOutcome<unknown>>(calls.length);
  let refused: string | null = null;
  let cursor = 0;
  const worker = async () => {
    for (let i = cursor++; i < calls.length; i = cursor++) {
      if (refused) {
        out[i] = { ok: false, error: refused };
        continue;
      }
      try {
        const o = await sendOne(url, calls[i], timeoutMs);
        if (!o.ok && RATE_LIMIT_TEXT.test(o.error)) {
          refused = o.error;
          park(url, o.error, null);
        }
        out[i] = o;
      } catch (err) {
        if (err instanceof RpcHttpError && REFUSAL_STATUS.has(err.status)) {
          refused = err.message;
          park(url, err.message, err.retryAfterMs);
        }
        // A thrown request is one the node never answered — a dead socket, a
        // timeout, an HTTP status. A refusal among them is ALSO carried on
        // to the next host by `batchSlice`, which flags it again there; a
        // transport failure is not carried, so this is its only flag.
        out[i] = { ok: false, error: errorText(err), unanswered: true };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, calls.length) }, worker));
  return { outcomes: out, refused };
}

async function attemptHost(url: string, calls: RpcCall[], timeoutMs: number): Promise<HostAttempt> {
  let answered: RpcOutcome<unknown>[];
  try {
    const json = await post(
      url,
      calls.map((call, i) => ({ jsonrpc: "2.0", id: i, ...call })),
      timeoutMs,
    );
    if (!Array.isArray(json)) throw new Error("endpoint did not honour the batch");
    const byId = new Map<number, JsonRpcResponse>();
    (json as JsonRpcResponse[]).forEach((entry, i) => byId.set(typeof entry?.id === "number" ? entry.id : i, entry));
    answered = calls.map((_, i) => unwrap(byId.get(i)));
  } catch (err) {
    if (err instanceof RpcHttpError && REFUSAL_STATUS.has(err.status)) {
      // The host turned the whole payload away. NOT one call at a time — that
      // is the hammering this file's header is about.
      park(url, err.message, err.retryAfterMs);
      return { outcomes: calls.map(() => ({ ok: false, error: err.message })), refused: err.message };
    }
    // Batch unsupported, a transport failure or a 5xx — none of which says
    // anything about a quota. One call at a time on this host, as before.
    return sequential(url, calls, timeoutMs);
  }

  // ⚠️ A BATCHED CALL AND A SINGLE ONE ARE DIFFERENT REQUESTS TO THE SAME
  // HOST, which is the one case the standing "never retry a status" rule
  // does not cover — the same exception the logo resolver records for HEAD
  // versus GET. A node that caps, truncates or rate-limits batched state
  // reads while serving them perfectly one at a time answers with a
  // well-formed array whose ITEMS carry the refusal, so the whole-payload
  // fallback above never fires and every one of them reads as permanent.
  //
  // It matters because the callers GROUP: token metadata is dropped unless
  // BOTH decimals and totalSupply answer, and curve state unless all four
  // reads do — so one item lost inside an otherwise healthy batch empties a
  // whole row, which is indistinguishable from a token that has no data.
  //
  // …EXCEPT an item that says "rate limit": that is the HOST refusing, and
  // re-asking it singly is the hammering again. Those carry to the next host.
  const lost = answered.flatMap((outcome, i) => (outcome.ok ? [] : [i]));
  const limited = lost.find((i) => !answered[i].ok && RATE_LIMIT_TEXT.test((answered[i] as { error: string }).error));
  if (limited !== undefined) {
    const why = (answered[limited] as { error: string }).error;
    park(url, why, null);
    return { outcomes: answered, refused: why };
  }
  if (lost.length > 0) {
    const again = await sequential(url, lost.map((i) => calls[i]), timeoutMs);
    // Only a SUCCESS replaces the first answer: a second failure keeps the
    // batch's own reason, which is the one that explains the shape.
    lost.forEach((i, k) => {
      if (again.outcomes[k]?.ok) answered[i] = again.outcomes[k];
    });
    if (again.refused) return { outcomes: answered, refused: again.refused };
  }
  return { outcomes: answered, refused: null };
}

/** One slice across the host list: what one host refused goes to the next;
 *  what a host ANSWERED (a value, a revert) is final. */
async function batchSlice(hosts: string[], slice: RpcCall[], timeoutMs: number): Promise<RpcOutcome<unknown>[]> {
  const out = new Array<RpcOutcome<unknown>>(slice.length);
  let pending = slice.map((_, i) => i);
  let lastWhy: string | null = null;
  for (const url of hosts) {
    if (pending.length === 0) break;
    const benched = rpcCooling(url);
    if (benched) {
      lastWhy = benched;
      continue;
    }
    const attempt = await attemptHost(url, pending.map((i) => slice[i]), timeoutMs);
    const carry: number[] = [];
    pending.forEach((i, k) => {
      const o = attempt.outcomes[k] ?? { ok: false, error: "no response" };
      if (!o.ok && attempt.refused && isRefusalText(o.error)) carry.push(i);
      else out[i] = o;
    });
    if (attempt.refused) lastWhy = attempt.refused;
    pending = carry;
  }
  // ⚠️ THE ONE PLACE A REFUSAL IS FLAGGED `unanswered`. Every refused outcome
  // — a whole payload turned away, an item saying "rate limit", a single
  // call refused mid-run — is carried here by the `isRefusalText` test above
  // and re-filled with the last host's reason, so a flag set on the attempt's
  // own fill would be dead code (a mutation run said so: removing it changed
  // nothing). "No response" and a thrown request are flagged where they
  // arise, because those are never carried.
  for (const i of pending) out[i] = { ok: false, error: lastWhy ?? "rpc unavailable", unanswered: true };
  return out;
}

/** Single call. Throws on transport failure or an RPC-level error. Tries the
 *  host list in order; a refusing host is parked and the next one asked. */
export async function rpcSend<T>(urls: string | string[], call: RpcCall, timeoutMs = 9000): Promise<T> {
  const [outcome] = await rpcBatch(urls, [call], timeoutMs);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.value as T;
}

/**
 * Batched call. One outcome per input call, in order — a single failing call
 * never fails its neighbours, so one unreadable token can't blank the board.
 * `urls` may be a LIST: the first host is asked, and one that refuses us
 * (a quota, a credential) is parked while the next takes the same calls.
 */
export async function rpcBatch(urls: string | string[], calls: RpcCall[], timeoutMs = 9000): Promise<RpcOutcome<unknown>[]> {
  if (calls.length === 0) return [];
  const hosts = hostsOf(urls);
  const results: RpcOutcome<unknown>[] = [];
  for (let start = 0; start < calls.length; start += MAX_BATCH) {
    results.push(...(await batchSlice(hosts, calls.slice(start, start + MAX_BATCH), timeoutMs)));
  }
  return results;
}

export const ethCall = (to: string, data: string): RpcCall => ({
  method: "eth_call",
  params: [{ to, data }, "latest"],
});

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

export const getLogs = (params: {
  address: string | string[];
  topics: (string | string[] | null)[];
  fromBlock: string;
  toBlock: string;
}): RpcCall => ({ method: "eth_getLogs", params: [params] });

export interface RpcBlockHeader {
  number: string;
  timestamp: string;
}

export const getBlock = (block: string): RpcCall => ({
  method: "eth_getBlockByNumber",
  params: [block, false],
});
