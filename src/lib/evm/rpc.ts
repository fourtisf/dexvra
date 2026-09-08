// Tiny JSON-RPC client for EVM reads. Batches by default (a board refresh asks
// for ~6 values per listed token) and degrades to sequential calls when an
// endpoint rejects batch payloads, which some public gateways do.

export interface RpcCall {
  method: string;
  params: unknown[];
}

export type RpcOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string; code?: number };
}

const MAX_BATCH = 40;
const MAX_PARALLEL = 6;

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
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  return res.json();
}

function unwrap(entry: JsonRpcResponse | undefined): RpcOutcome<unknown> {
  if (!entry) return { ok: false, error: "no response" };
  if (entry.error) return { ok: false, error: entry.error.message ?? `rpc error ${entry.error.code ?? ""}`.trim() };
  if (entry.result === undefined || entry.result === null) return { ok: false, error: "empty result" };
  return { ok: true, value: entry.result };
}

/** Single call. Throws on transport failure or an RPC-level error. */
export async function rpcSend<T>(url: string, call: RpcCall, timeoutMs = 9000): Promise<T> {
  const json = (await post(url, { jsonrpc: "2.0", id: 1, ...call }, timeoutMs)) as JsonRpcResponse;
  const out = unwrap(json);
  if (!out.ok) throw new Error(out.error);
  return out.value as T;
}

async function sequential(url: string, calls: RpcCall[], timeoutMs: number): Promise<RpcOutcome<unknown>[]> {
  const out = new Array<RpcOutcome<unknown>>(calls.length);
  let cursor = 0;
  const worker = async () => {
    for (let i = cursor++; i < calls.length; i = cursor++) {
      try {
        out[i] = { ok: true, value: await rpcSend(url, calls[i], timeoutMs) };
      } catch (err) {
        out[i] = { ok: false, error: errorText(err) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, calls.length) }, worker));
  return out;
}

/**
 * Batched call. One outcome per input call, in order — a single failing call
 * never fails its neighbours, so one unreadable token can't blank the board.
 */
export async function rpcBatch(url: string, calls: RpcCall[], timeoutMs = 9000): Promise<RpcOutcome<unknown>[]> {
  if (calls.length === 0) return [];

  const results: RpcOutcome<unknown>[] = [];
  for (let start = 0; start < calls.length; start += MAX_BATCH) {
    const slice = calls.slice(start, start + MAX_BATCH);
    try {
      const json = await post(
        url,
        slice.map((call, i) => ({ jsonrpc: "2.0", id: i, ...call })),
        timeoutMs,
      );
      if (!Array.isArray(json)) throw new Error("endpoint did not honour the batch");
      const byId = new Map<number, JsonRpcResponse>();
      (json as JsonRpcResponse[]).forEach((entry, i) => byId.set(typeof entry?.id === "number" ? entry.id : i, entry));
      const answered = slice.map((_, i) => unwrap(byId.get(i)));

      // ⚠️ A BATCHED CALL AND A SINGLE ONE ARE DIFFERENT REQUESTS TO THE SAME
      // HOST, which is the one case the standing "never retry a status" rule
      // does not cover — the same exception the logo resolver records for HEAD
      // versus GET. A node that caps, truncates or rate-limits batched state
      // reads while serving them perfectly one at a time answers with a
      // well-formed array whose ITEMS carry the refusal, so the whole-payload
      // fallback below never fires and every one of them reads as permanent.
      //
      // It matters because the callers GROUP: token metadata is dropped unless
      // BOTH decimals and totalSupply answer, and curve state unless all four
      // reads do — so one item lost inside an otherwise healthy batch empties a
      // whole row, which is indistinguishable from a token that has no data.
      const lost = answered.flatMap((outcome, i) => (outcome.ok ? [] : [i]));
      if (lost.length > 0) {
        const again = await sequential(url, lost.map((i) => slice[i]), timeoutMs);
        // Only a SUCCESS replaces the first answer: a second failure keeps the
        // batch's own reason, which is the one that explains the shape.
        lost.forEach((i, k) => {
          if (again[k]?.ok) answered[i] = again[k];
        });
      }
      results.push(...answered);
    } catch {
      // Batch unsupported or the whole payload failed — retry this slice one
      // call at a time so a single bad call doesn't cost us the rest.
      results.push(...(await sequential(url, slice, timeoutMs)));
    }
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
