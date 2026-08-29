// THE SWEEP THAT MAKES "every token has a logo" TRUE WITHOUT ANYONE TYPING
// ANYTHING.
//
// resolveLogo() finds the artwork; this decides WHEN it is worth going to look,
// remembers what came back, and writes the answer into the listing store so it
// is found once and then belongs to the site, the bot's board and the channel
// posts alike.
//
// The three rules it is built around are all one lesson from this repo:
//
//  • IT NEVER BLOCKS A BOARD RENDER. CoinGecko is paced at one call every 2.5s
//    (its free tier is per IP and the bot suite shares that IP), so a sweep
//    that a page waited on would be a page that hangs. The board reads what is
//    already known and the sweep runs behind it; a logo appears on the next
//    refresh, never later than a minute.
//  • "NOTHING THERE" AND "COULD NOT ASK" ARE DIFFERENT FACTS. Only the first is
//    remembered as an answer. Caching a 429 as "this project has no logo" is
//    how one rate-limited minute leaves a row monogrammed for good.
//  • IT IS BOUNDED. A cap per sweep and one sweep at a time, so a board with
//    eighty logo-less rows costs a slow trickle rather than eighty concurrent
//    lookups against three rate-limited APIs.
//
// Relative imports with extensions: node:test resolves this file.
import { resolveLogo, type LogoResult } from "./tokenLogo.ts";

/** How many tokens one sweep may look up. At CoinGecko's pace this is ~20s of
 *  background work; the board rebuilds every 60s, so a backlog drains steadily
 *  instead of arriving as one burst against three rate-limited APIs. */
const MAX_PER_SWEEP = 8;

/** A token every source ANSWERED about and none had artwork for. Long enough
 *  not to re-ask on every board rebuild, short enough that a project that
 *  uploads artwork this morning is wearing it this evening. */
const MISS_TTL_MS = 12 * 60 * 60_000;

/** A token we could not get a decision on (an upstream was down or refusing).
 *
 *  ⚠️ This is a RATE LIMIT, not an answer: nothing is remembered about the
 *  token, we simply do not spend the next sweep's budget on the same row while
 *  the outage lasts. Without it one undecided token would be retried every
 *  cycle for ever and starve every other row of the cap above. */
const UNDECIDED_TTL_MS = 30 * 60_000;

interface Known {
  url: string | null;
  /** When this was decided. Absent expiry (a found logo) never expires. */
  at: number;
  kind: "found" | "miss" | "undecided";
}

// Per-process memory. The durable copy is the listing store — this only spares
// a restart from re-asking for rows it has already written.
const g = globalThis as { __dexvraLogoMem?: Map<string, Known>; __dexvraLogoSweeping?: { on: boolean } };
const mem: Map<string, Known> = g.__dexvraLogoMem ?? (g.__dexvraLogoMem = new Map());
// The "one sweep at a time" flag lives on the same global as the memory, and
// for the same reason: Next can hold more than one instance of a module, and a
// per-instance flag would let two sweeps run while sharing one memory — which
// is precisely the state the flag exists to prevent.
const running = g.__dexvraLogoSweeping ?? (g.__dexvraLogoSweeping = { on: false });

const key = (chain: string, address: string) => `${chain}:${String(address).toLowerCase()}`;

/** The logo this process has already resolved for a token, or null when it has
 *  none to show. A RENDERER's question — it never says why, because a row with
 *  no artwork and a row we have not looked at yet draw identically. */
export function knownLogo(chain: string, address: string): string | null {
  const hit = mem.get(key(chain, address));
  return hit?.kind === "found" ? hit.url : null;
}

/** Is it worth spending a lookup on this token? A SWEEP's question, and
 *  deliberately a different one from `knownLogo`.
 *
 *  Never asked before → yes. A found logo → never again. A miss → not until it
 *  goes stale, because "no artwork anywhere" is an answer with a shelf life. An
 *  undecided → not until the retry window passes, which is a rate limit on us
 *  rather than a claim about the token. */
export function shouldLookUp(chain: string, address: string, now = Date.now()): boolean {
  const hit = mem.get(key(chain, address));
  if (!hit) return true;
  if (hit.kind === "found") return false;
  return now - hit.at > (hit.kind === "miss" ? MISS_TTL_MS : UNDECIDED_TTL_MS);
}

/** Seed the memory with a logo we did not have to resolve — a listing that
 *  already carries one, or one a market provider supplied. Stops the sweep
 *  spending its budget on rows that were never missing anything. */
export function rememberLogo(chain: string, address: string, url: string, now = Date.now()): void {
  mem.set(key(chain, address), { url, at: now, kind: "found" });
}

export interface FillDeps {
  /** How many rows are waiting, so the line can say how long the queue is.
   *  Absent, it reports no backlog rather than guessing one. */
  queued?: number;
  resolve?: (chain: string, address: string) => Promise<LogoResult>;
  /** Writes the resolved logo into the listing store. Best-effort: a failed
   *  write costs permanence, never the logo — the process memory still has it. */
  persist?: (chain: string, address: string, url: string) => Promise<unknown>;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface SweepReport {
  looked: number;
  found: number;
  missing: number;
  undecided: number;
  persisted: number;
  /** Which source each logo came from — "6 of 7 from CoinGecko" is the
   *  difference between a working chain of sources and one carrying all of it. */
  bySource: Record<string, number>;
}

/**
 * Resolve logos for tokens that have none. Awaited by the tests; called
 * FIRE-AND-FORGET by the board pipeline (see backfillLogos below).
 *
 * Candidates are taken in the ORDER GIVEN and the cap bites at MAX_PER_SWEEP,
 * so the order is a decision, not a detail: the board pipeline sorts featured
 * rows first and then by 24h volume before calling this.
 */
export async function sweepLogos(
  candidates: { chain: string; address: string }[],
  deps: FillDeps = {},
): Promise<SweepReport> {
  const resolve = deps.resolve ?? ((c: string, a: string) => resolveLogo(c, a));
  const now = deps.now ?? Date.now;
  const report: SweepReport = { looked: 0, found: 0, missing: 0, undecided: 0, persisted: 0, bySource: {} };

  for (const t of candidates) {
    if (report.looked >= MAX_PER_SWEEP) break;
    if (!shouldLookUp(t.chain, t.address, now())) continue; // decided since the list was built
    report.looked++;
    let r: LogoResult;
    try {
      r = await resolve(t.chain, t.address);
    } catch (e) {
      // resolveLogo does not throw, but a caller's stub or a future edit might,
      // and a sweep that dies takes every later row with it.
      r = { ok: false, url: null, source: null, tried: [], unreachable: [String((e as Error)?.message ?? e)] };
    }

    if (r.url) {
      mem.set(key(t.chain, t.address), { url: r.url, at: now(), kind: "found" });
      report.found++;
      report.bySource[r.source ?? "?"] = (report.bySource[r.source ?? "?"] ?? 0) + 1;
      if (deps.persist) {
        try {
          if (await deps.persist(t.chain, t.address, r.url)) report.persisted++;
        } catch {
          /* permanence is best-effort; the logo is already in memory */
        }
      }
      continue;
    }
    // ⚠️ THE ONE LINE THIS FILE IS ABOUT. `ok` is what separates "every source
    // answered and this project has no artwork" from "an upstream refused".
    mem.set(key(t.chain, t.address), { url: null, at: now(), kind: r.ok ? "miss" : "undecided" });
    if (r.ok) report.missing++;
    else report.undecided++;
  }

  if (deps.log && report.looked > 0) {
    const src = Object.entries(report.bySource).map(([k, n]) => `${n} ${k}`).join(", ");
    // ⚠️ THE BACKLOG, because without it the line cannot answer the question it
    // is read for. "Some tokens have no logo" has two completely different
    // causes that this line rendered identically: the resolver is failing, or
    // it is working through a queue at 8 rows a minute and simply has not
    // reached that row yet. `queued` turns the second into arithmetic an
    // operator can do — 214 left is under half an hour — instead of a fault
    // they go hunting for.
    const left = Math.max(0, (deps.queued ?? report.looked) - report.looked);
    const eta = left > 0 ? ` · ${left} still queued (~${Math.ceil(left / MAX_PER_SWEEP)} more rebuild(s))` : "";
    deps.log(
      `[logos] looked up ${report.looked}: ${report.found} found${src ? ` (${src})` : ""}` +
        `, ${report.missing} with no artwork anywhere, ${report.undecided} undecided (an upstream could not be asked)` +
        `, ${report.persisted} written to the listing store` +
        eta +
        // A store that refuses every write is a sweep whose work dies with the
        // process — the logos come back on the next restart and nothing said
        // why. The count alone reads as a detail; this reads as a fault.
        (report.found > 0 && report.persisted === 0 ? " ⚠️ NONE of them could be written — they will be lost on restart" : ""),
    );
  }
  return report;
}

/**
 * Kick a sweep off behind a board render. Returns immediately, always.
 *
 * One at a time: the board rebuilds on a 60s cache and CoinGecko is paced in
 * seconds, so overlapping sweeps would multiply the upstream calls for no extra
 * coverage — and the second sweep would be working from a list the first one is
 * already halfway through.
 */
export function backfillLogos(candidates: { chain: string; address: string }[], deps: FillDeps = {}): void {
  if (running.on || candidates.length === 0) return;
  running.on = true;
  void sweepLogos(candidates, deps)
    .catch(() => {})
    .finally(() => {
      running.on = false;
    });
}

/** Test seam only — the memory is a module singleton by design (it must
 *  survive between board rebuilds), so a test that asserts on a fresh sweep has
 *  to be able to clear it. */
export function _resetLogoMemory(): void {
  mem.clear();
  running.on = false;
}

export const _MAX_PER_SWEEP = MAX_PER_SWEEP;
export const _MISS_TTL_MS = MISS_TTL_MS;
export const _UNDECIDED_TTL_MS = UNDECIDED_TTL_MS;
