/**
 * How many wallets hold a token — MEASURED, or not at all.
 *
 * ⚠️ "HOLDERS 0" WAS NEVER A READING. Reported on $SFX (Safix, Robinhood):
 * DexScreener's own Holders tab counted 1,570 while dexvra.io printed `0`.
 * Nothing on the site had ever asked anyone. `holders` is a field of the
 * listing ROW, which defaults to 0 and which no market provider fills — so
 * every listed token rendered a confident zero, and the Dexvra Score's
 * "holder base" term (15%) scored it as a token nobody holds. The rows are
 * fixed at `rowToBoardToken` (a stored 0 is "unknown", not "zero"); this is
 * the half that puts a real number there.
 *
 * Two sources, ordered by what they cost us:
 *   1. The chain's BLOCKSCOUT explorer — keyless, its own budget, and the one
 *      that counts every holder of the contract rather than an indexer's
 *      estimate. Robinhood Chain's explorer is Blockscout (the host the site
 *      already links every Robinhood token to), which is the chain this was
 *      reported on.
 *   2. GeckoTerminal's token info, which publishes `holders.count` for the
 *      networks it tracks. ⚠️ ASKED ONLY FOR A FREE SLOT (`waitMs: 0`): GT is
 *      the scarce per-IP budget the board and every chart share, and a count
 *      of holders is not worth a single candle. No slot → "could not ask".
 *
 * ⚠️ "WE COULD NOT ASK" IS NEVER RENDERED AS A NUMBER. `count: null` is the
 * page's "—". A 0 is returned only when a source ANSWERED zero — which on a
 * real listing is itself worth doubting, but it is a measurement.
 *
 * Alias-free and dependency-injected so `npm test` drives it by being CALLED;
 * the route wires the real fetch and GT client.
 */
import { CHAINS } from "../../config/chains.ts";
import { gtGet as realGtGet, type GtResult } from "./gt.ts";

export interface HolderCount {
  count: number | null;
  source: "blockscout" | "geckoterminal" | null;
  /** Why there is no count — every source's reason, so "—" is diagnosable. */
  why: string | null;
}

export interface HolderDeps {
  fetch?: typeof fetch;
  gtGet?: (path: string, params?: Record<string, string | number>, opts?: { waitMs?: number }) => Promise<GtResult<unknown>>;
  timeoutMs?: number;
}

const TIMEOUT_MS = 5_000;

/** A count as an explorer or an indexer spells it — number or numeric string. */
export function countOf(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** The Blockscout host for a chain, or null. Env-overridable per chain
 *  (`BLOCKSCOUT_<CHAIN>`), because an explorer host is a fact about a third
 *  party that can move — a line in `.env`, not a deploy. */
export function blockscoutFor(chain: string): string | null {
  const raw = (process.env[`BLOCKSCOUT_${chain.toUpperCase()}`] ?? "").trim();
  if (raw === "0") return null; // switched off
  // Blank is ABSENT (the `Number('')` rule). A value that cannot be a host — a
  // pasted placeholder, `<your-explorer>`, a dotless word — is REFUSED and the
  // built-in kept: CLAUDE.md's first rule, which a placeholder has broken four
  // times on this box.
  if (raw !== "" && /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[^\s<>…]*)?$/i.test(raw)) return raw.replace(/\/+$/, "");
  return CHAINS[chain]?.blockscout ?? null;
}

async function fromBlockscout(host: string, address: string, deps: HolderDeps): Promise<{ count: number | null; why: string | null }> {
  const f = deps.fetch ?? fetch;
  try {
    const r = await f(`${host}/api/v2/tokens/${address}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
    if (!r.ok) {
      try { await r.body?.cancel(); } catch { /* nothing to release */ }
      return { count: null, why: `blockscout ${r.status}` };
    }
    const j = (await r.json()) as Record<string, unknown>;
    // Newer Blockscout spells it `holders_count`; older builds `holders`. Both
    // are strings on the wire.
    const c = countOf(j.holders_count ?? j.holders);
    return c == null ? { count: null, why: "blockscout published no holder count" } : { count: c, why: null };
  } catch (e) {
    const cause = (e as { cause?: { code?: string } })?.cause?.code;
    return { count: null, why: `blockscout unreachable${cause ? ` (${cause})` : (e as Error)?.name === "TimeoutError" ? " (timeout)" : ""}` };
  }
}

async function fromGeckoTerminal(network: string, address: string, deps: HolderDeps): Promise<{ count: number | null; why: string | null }> {
  const g = deps.gtGet ?? realGtGet;
  const res = await g(`/networks/${network}/tokens/${address}/info`, undefined, { waitMs: 0 });
  if (!res.ok) return { count: null, why: `geckoterminal: ${res.reason ?? res.status}` };
  const attrs = (res.body as { data?: { attributes?: { holders?: { count?: unknown } } } } | null)?.data?.attributes;
  const c = countOf(attrs?.holders?.count);
  return c == null ? { count: null, why: "geckoterminal published no holder count" } : { count: c, why: null };
}

export async function readHolders(chain: string, address: string, deps: HolderDeps = {}): Promise<HolderCount> {
  const why: string[] = [];
  const host = blockscoutFor(chain);
  if (host) {
    const b = await fromBlockscout(host, address, deps);
    if (b.count != null) return { count: b.count, source: "blockscout", why: null };
    if (b.why) why.push(b.why);
  }
  const network = CHAINS[chain]?.geckoNetwork;
  if (network) {
    const g = await fromGeckoTerminal(network, address, deps);
    if (g.count != null) return { count: g.count, source: "geckoterminal", why: null };
    if (g.why) why.push(g.why);
  }
  return { count: null, source: null, why: why.length ? why.join("; ") : "no source covers this chain" };
}
