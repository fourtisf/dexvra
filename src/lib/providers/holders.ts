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
 * Three sources, ordered by what they cost us:
 *   1. The chain's BLOCKSCOUT explorers — a LIST, keyless, their own budget,
 *      and the ones that count every holder of the contract rather than an
 *      indexer's estimate. Each host is asked two ways: the token record
 *      (`holders_count`) and the dedicated `/counters` endpoint
 *      (`token_holders_count`), because an instance whose token record lags
 *      still answers the counter.
 *   2. DEXSCREENER — the number its own Holders tab shows, read off the pair
 *      details its site loads. ⚠️ UNVERIFIED: that host (`io.`) is internal,
 *      undocumented, and behind Cloudflare; the documented API publishes no
 *      holders at all. So it is env-overridable end to end and shares the
 *      chart client's refusal bench.
 *   3. GeckoTerminal's token info, which publishes `holders.count` for the
 *      networks it tracks. ⚠️ ASKED ONLY FOR A FREE SLOT (`waitMs: 0`): GT is
 *      the scarce per-IP budget the board and every chart share, and a count
 *      of holders is not worth a single candle. No slot → "could not ask".
 *
 * ⚠️ A ZERO IS NOT A COUNT HERE. A listed token has a supply and somebody holds
 * it, so "0 holders" from any source means "not indexed yet" — the round that
 * shipped the first version of this could not tell those apart, and a source
 * that answered 0 ended the lookup ahead of one that had the real number.
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
import { chartHeaders, dsArmCooldown, dsCooldownWhy, dsInCooldown, dsTopPair, type DsPair } from "./dsChart.ts";

export type HolderSource = "blockscout" | "dexscreener" | "geckoterminal";

export interface HolderCount {
  count: number | null;
  source: HolderSource | null;
  /** The host that answered — "which explorer" is the whole diagnosis when
   *  one of two is down. Never a url: nothing here carries a key, but a
   *  host is all a reader needs. */
  via: string | null;
  /** Why there is no count — every source's reason, so "—" is diagnosable. */
  why: string | null;
}

export interface HolderDeps {
  fetch?: typeof fetch;
  gtGet?: (path: string, params?: Record<string, string | number>, opts?: { waitMs?: number }) => Promise<GtResult<unknown>>;
  dsPair?: (chain: string, address: string) => Promise<{ ok: boolean; pair: DsPair | null; why: string | null }>;
  timeoutMs?: number;
}

const TIMEOUT_MS = 5_000;

/** A count as an explorer or an indexer spells it — number or numeric string. */
export function countOf(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Only a POSITIVE count is a reading — see the header. */
const reading = (n: number | null): n is number => n != null && n > 0;

const HOST_RE = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[^\s<>…]*)?$/i;
const strip = (u: string) => u.trim().replace(/\/+$/, "");
const hostOf = (u: string) => {
  try { return new URL(u).host; } catch { return u; }
};

/**
 * The Blockscout hosts for a chain, in order. `BLOCKSCOUT_<CHAIN>` REPLACES the
 * list (a comma list; a pin must not answer from a host the operator did not
 * choose) and `=0` switches it off. Blank is ABSENT (the `Number('')` rule). An
 * entry that cannot be a host — a pasted placeholder, `<your-explorer>`, a
 * dotless word, plain http — is REFUSED, and if nothing survives the built-ins
 * stand: CLAUDE.md's first rule, which a placeholder has broken five times.
 */
export function blockscoutHosts(chain: string): string[] {
  const raw = (process.env[`BLOCKSCOUT_${chain.toUpperCase()}`] ?? "").trim();
  if (raw === "0") return [];
  if (raw !== "") {
    const pinned = raw.split(",").map((x) => x.trim()).filter((x) => HOST_RE.test(x)).map(strip);
    if (pinned.length) return [...new Set(pinned)];
  }
  const c = CHAINS[chain];
  const built = [c?.blockscout, ...(c?.blockscoutAlt ?? [])].filter((x): x is string => !!x).map(strip);
  return [...new Set(built)];
}

/** The first Blockscout host, or null — what the page links to. */
export const blockscoutFor = (chain: string): string | null => blockscoutHosts(chain)[0] ?? null;

type Got = { count: number | null; why: string | null };

async function getJson(url: string, deps: HolderDeps, headers: Record<string, string> = { accept: "application/json" }): Promise<{ ok: boolean; status: number; body: unknown; why: string | null }> {
  const f = deps.fetch ?? fetch;
  const host = hostOf(url);
  try {
    const r = await f(url, { headers, signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS) });
    if (!r.ok) {
      try { await r.body?.cancel(); } catch { /* nothing to release */ }
      return { ok: false, status: r.status, body: null, why: `${host} ${r.status}` };
    }
    return { ok: true, status: r.status, body: await r.json(), why: null };
  } catch (e) {
    const cause = (e as { cause?: { code?: string } })?.cause?.code;
    const what = cause ? ` (${cause})` : (e as Error)?.name === "TimeoutError" ? " (timeout)" : (e as Error)?.name === "SyntaxError" ? " (not JSON)" : "";
    return { ok: false, status: 0, body: null, why: `${host} unreachable${what}` };
  }
}

/** One Blockscout host, asked the two ways it publishes a holder count. */
async function fromBlockscoutHost(host: string, address: string, deps: HolderDeps): Promise<Got> {
  const why: string[] = [];
  const t = await getJson(`${host}/api/v2/tokens/${address}`, deps);
  if (t.ok) {
    const j = (t.body ?? {}) as Record<string, unknown>;
    // Newer Blockscout spells it `holders_count`; older builds `holders`.
    const c = countOf(j.holders_count ?? j.holders);
    if (reading(c)) return { count: c, why: null };
    why.push(c === 0 ? `${hostOf(host)} counts 0 (not indexed yet)` : `${hostOf(host)} published no holder count`);
  } else {
    why.push(t.why ?? `${hostOf(host)} failed`);
    // A host we cannot REACH will not answer the second path either — asking
    // it again is the same silence twice at a full timeout each.
    if (t.status === 0) return { count: null, why: why.join(", ") };
  }
  const k = await getJson(`${host}/api/v2/tokens/${address}/counters`, deps);
  if (k.ok) {
    const c = countOf((k.body as Record<string, unknown> | null)?.token_holders_count);
    if (reading(c)) return { count: c, why: null };
    why.push(`counters ${c === 0 ? "0" : "empty"}`);
  } else why.push(`counters ${k.why ?? "failed"}`);
  return { count: null, why: why.join(", ") };
}

// ─── DexScreener ─────────────────────────────────────────────────────────────

const DS_ON = (process.env.DS_HOLDERS ?? "").trim() !== "0";
const DS_IO = strip(process.env.DS_HOLDERS_API ?? "") || "https://io.dexscreener.com";

/** The pair-details path templates, tried in order on a 404/400 (a different
 *  SPELLING, which is exactly when another spelling is worth trying — the
 *  dsChart path rule). `DS_HOLDERS_PATH` REPLACES the list. A placeholder is
 *  refused: only `{chain}` and `{pair}` are fillers. */
export function dsHolderPaths(override = process.env.DS_HOLDERS_PATH ?? ""): string[] {
  const pinned = override.split(",").map((x) => x.trim()).filter((x) => x.startsWith("/") && !/[<>…\s]|\.\.\./.test(x));
  if (pinned.length) return pinned;
  return ["/dex/pair-details/v4/{chain}/{pair}", "/dex/pair-details/v3/{chain}/{pair}", "/dex/pair-details/v2/{chain}/{pair}"];
}

/** The holder count in a pair-details body, however it is spelled. */
export function dsHolderCount(body: unknown): number | null {
  const at = (...keys: string[]): unknown =>
    keys.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), body);
  for (const v of [at("holders", "count"), at("holders", "total"), at("holdersCount"), at("ti", "holders", "count"), at("ti", "holders"), at("pair", "holders", "count")]) {
    const c = countOf(v);
    if (c != null) return c;
  }
  return null;
}

async function fromDexScreener(chain: string, address: string, deps: HolderDeps): Promise<Got & { via?: string }> {
  if (!DS_ON) return { count: null, why: "dexscreener switched off (DS_HOLDERS=0)" };
  if (!CHAINS[chain]?.dexscreener) return { count: null, why: null }; // not a source for this chain
  if (dsInCooldown()) return { count: null, why: `dexscreener: ${dsCooldownWhy()}` };
  const p = await (deps.dsPair ?? dsTopPair)(chain, address);
  if (!p.pair) return { count: null, why: `dexscreener: ${p.why ?? "no pair"}` };
  const why: string[] = [];
  for (const tpl of dsHolderPaths()) {
    const url = DS_IO + tpl.replace("{chain}", encodeURIComponent(p.pair.chainId)).replace("{pair}", encodeURIComponent(p.pair.pairAddress));
    const r = await getJson(url, deps, chartHeaders());
    if (r.ok) {
      const c = dsHolderCount(r.body);
      if (reading(c)) return { count: c, why: null, via: hostOf(DS_IO) };
      return { count: null, why: `dexscreener: ${hostOf(DS_IO)} answered with no holder count` };
    }
    why.push(r.why ?? "failed");
    // A refusal is about US, and it is the same refusal on every path — bench
    // the host with the chart client's one bench, so neither asks again.
    if ([401, 403, 429, 451].includes(r.status)) {
      dsArmCooldown(undefined, Date.now(), `${hostOf(DS_IO)} is ${r.status === 429 ? "rate limited" : `${r.status}, refusing this server`}`);
      break;
    }
    if (r.status !== 404 && r.status !== 400) break; // only a spelling miss tries the next spelling
  }
  return { count: null, why: `dexscreener: ${why.join(", ")}` };
}

// ─── GeckoTerminal ───────────────────────────────────────────────────────────

async function fromGeckoTerminal(network: string, address: string, deps: HolderDeps): Promise<Got> {
  const g = deps.gtGet ?? realGtGet;
  const res = await g(`/networks/${network}/tokens/${address}/info`, undefined, { waitMs: 0 });
  if (!res.ok) return { count: null, why: `geckoterminal: ${res.reason ?? res.status}` };
  const attrs = (res.body as { data?: { attributes?: { holders?: { count?: unknown } } } } | null)?.data?.attributes;
  const c = countOf(attrs?.holders?.count);
  if (reading(c)) return { count: c, why: null };
  return { count: null, why: c === 0 ? "geckoterminal counts 0 (not indexed yet)" : "geckoterminal published no holder count" };
}

export async function readHolders(chain: string, address: string, deps: HolderDeps = {}): Promise<HolderCount> {
  const why: string[] = [];
  for (const host of blockscoutHosts(chain)) {
    const b = await fromBlockscoutHost(host, address, deps);
    if (reading(b.count)) return { count: b.count, source: "blockscout", via: hostOf(host), why: null };
    if (b.why) why.push(b.why);
  }
  const d = await fromDexScreener(chain, address, deps);
  if (reading(d.count)) return { count: d.count, source: "dexscreener", via: d.via ?? null, why: null };
  if (d.why) why.push(d.why);
  const network = CHAINS[chain]?.geckoNetwork;
  if (network) {
    const g = await fromGeckoTerminal(network, address, deps);
    if (reading(g.count)) return { count: g.count, source: "geckoterminal", via: "api.geckoterminal.com", why: null };
    if (g.why) why.push(g.why);
  }
  return { count: null, source: null, via: null, why: why.length ? why.join("; ") : "no source covers this chain" };
}
