// ONE GeckoTerminal client for the whole web app: one base, one key, one
// cooldown.
//
// WHY THIS FILE EXISTS
// A live server answered `{"why":"Couldn't read the chart just now
// (GeckoTerminal 429)."}` while a bare `curl` to GT from the same box also
// returned 429 — the IP was over its quota, which is ~30 requests a minute on
// the free tier and counted PER IP, not per process or per caller. The bot
// suite runs on that same box and that same IP.
//
// The web app was making it worse in the way this repo has already documented:
// SIX modules with their own `fetch` and their own idea of failure — the market
// pipeline, the pool resolver, the candles route, the trades feed, the token
// preview and the logo resolver. `bot/src/group/gtPairs.js` states the rule in
// its own header: "Two modules with their own fetch and their own backoff means
// one of them keeps hammering through a 429 that the other has already
// noticed." The web app had five more than that.
//
// So: a 429 seen by ANY caller silences ALL of them for the cooldown, nobody
// re-asks during it, and the key — if the operator has one — is read from the
// same env var the bot already uses.
//
// Relative imports with extensions: node:test resolves this file.

/** The API key raises the ceiling from ~30/min to the Pro tier's, and it is the
 *  ONLY real way past it. Same variable the bot reads, so one line in the
 *  server's env serves both processes. Unset — the default — nothing changes. */
const GT_KEY = String(process.env.GECKOTERMINAL_API_KEY || "").trim();

/** The Pro base a key unlocks, and the free one otherwise. `GECKOTERMINAL_API_BASE`
 *  pins a host and skips the choice — the same override-and-skip contract the
 *  launchpad registry uses. */
export const gtBaseFor = (key: string, override = ""): string =>
  override.trim().replace(/\/+$/, "") ||
  (key.trim() ? "https://pro-api.coingecko.com/api/v3/onchain" : "https://api.geckoterminal.com/api/v2");

export const gtHeadersFor = (key: string): Record<string, string> =>
  key.trim()
    ? { accept: "application/json;version=20230302", "x-cg-pro-api-key": key.trim() }
    : { accept: "application/json;version=20230302" };

export const GT_BASE = gtBaseFor(GT_KEY, String(process.env.GECKOTERMINAL_API_BASE || ""));
export const GT_HEADERS: Record<string, string> = gtHeadersFor(GT_KEY);

/** Whether a key is configured. Reported by /api/health-style checks and by the
 *  boot line — "is a key set" is the fact worth printing; WHICH key it is, is a
 *  secret, and this app's logs are not the place for one. */
export const GT_KEYED = Boolean(GT_KEY);

const num = (raw: string | undefined, dflt: number, min: number): number => {
  const s = String(raw ?? "").trim();
  // Number('') is 0 — finite and non-negative — so the blank check is the whole
  // guard, exactly as in the launchpad env reader.
  if (s === "") return dflt;
  const n = Number(s);
  return Number.isFinite(n) && n >= min ? n : dflt;
};

/** How long a 429 silences every caller. 120s matches the bot's, so there is
 *  one number to reason about across the two processes on one IP. */
const COOLDOWN_MS = num(process.env.GT_COOLDOWN_MS, 120_000, 1000);
/** A floor between two GT requests from this process. Not a budget — the
 *  cooldown is what enforces the ceiling — just enough that a page opening
 *  four panels at once does not arrive as one burst. */
const MIN_GAP_MS = num(process.env.GT_MIN_GAP_MS, 120, 0);
const TIMEOUT_MS = 9000;

// Next can hold more than one instance of a module; a per-instance cooldown
// would let one instance hammer through a 429 the other already saw, which is
// the exact failure this file exists to prevent.
const g = globalThis as { __dexvraGt?: { until: number; nextAt: number; chain: Promise<void> } };
const state = g.__dexvraGt ?? (g.__dexvraGt = { until: 0, nextAt: 0, chain: Promise.resolve() });

export const gtInCooldown = (at = Date.now()): boolean => at < state.until;
export const gtCooldownLeftMs = (at = Date.now()): number => Math.max(0, state.until - at);

/** Arm the shared cooldown. Exported so a caller that learns about a 429 by
 *  another route can silence everyone too. */
export function gtArmCooldown(ms = COOLDOWN_MS, at = Date.now()): void {
  const until = at + Math.max(1000, ms);
  if (until > state.until) state.until = until;
}

/** Test seam — the cooldown is process-wide by design. */
export function _gtReset(): void {
  state.until = 0;
  state.nextAt = 0;
}

// ⚠️ SAID OUT LOUD, ONCE, AT BOOT. Whether a key is set is the single thing
// most likely to make a busy deployment look broken — and from outside, "the
// chart is empty" looks identical whether the ceiling is 30 requests a minute
// or the Pro tier's. The trade bot prints the same kind of line for its RPC
// (`rpc PUBLIC default (rate-limited)`), and for the same reason.
//
// The KEY is never printed: it would land in pm2's log. The base carries none.
if (typeof window === "undefined") {
  console.log(
    `[gt] ${
      GT_KEYED
        ? "API key set"
        : "PUBLIC free tier (~30 req/min per IP, shared with the bot suite on this box) — set GECKOTERMINAL_API_KEY to raise it"
    } · base ${GT_BASE}`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialise the gap so concurrent callers space out instead of all firing at
 *  once (the same shape as the CoinGecko pacer in tokenLogo). */
function slot(): Promise<void> {
  const wait = state.chain.then(async () => {
    const now = Date.now();
    const delay = Math.max(0, state.nextAt - now);
    if (delay) await sleep(delay);
    state.nextAt = Math.max(now, state.nextAt) + MIN_GAP_MS;
  });
  state.chain = wait.catch(() => {});
  return wait;
}

export interface GtResult<T = unknown> {
  ok: boolean;
  /** HTTP status, or 0 when no request was made (cooldown) or none arrived. */
  status: number;
  /** Why it failed, in words — never dropped. `null` on success. */
  reason: string | null;
  body: T | null;
}

/**
 * One GET against GeckoTerminal.
 *
 * Returns rather than throws, so every caller has to look at `ok` — and can
 * tell a 404 (an answer about the token) from a 429 (a fact about our quota)
 * from a dead socket (a fact about the box).
 *
 *  • WHILE THE COOLDOWN IS ARMED NO REQUEST IS MADE. It answers
 *    `status: 0, reason: "rate limited — cooling down for Ns"`, which every
 *    caller must treat as "could not ask", never as "nothing there".
 *  • A 429 ARMS IT, honouring `Retry-After` when GT sends one.
 *  • A 5xx OR A TIMEOUT DOES NOT. Those are per-request failures and say
 *    nothing about the quota; arming a process-wide cooldown for one slow pool
 *    would take every chart on the site down for two minutes. 429 is the only
 *    status that means "all of you, stop" — the bot's client draws the same
 *    line for the same reason.
 */
export async function gtGet<T = unknown>(path: string, params?: Record<string, string | number>): Promise<GtResult<T>> {
  if (gtInCooldown())
    return { ok: false, status: 0, reason: `rate limited — cooling down for ${Math.ceil(gtCooldownLeftMs() / 1000)}s`, body: null };

  const qs = params ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : "";
  const url = `${GT_BASE}${path}${qs ? `?${qs}` : ""}`;
  await slot();
  // Re-checked AFTER the gap: a request that waited its turn may have been
  // overtaken by a 429 armed by whatever went out ahead of it, and firing it
  // anyway is how a cooldown gets extended.
  if (gtInCooldown())
    return { ok: false, status: 0, reason: `rate limited — cooling down for ${Math.ceil(gtCooldownLeftMs() / 1000)}s`, body: null };

  try {
    const res = await fetch(url, { headers: GT_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      gtArmCooldown(Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 10 * 60_000) : COOLDOWN_MS);
      void res.body?.cancel().catch(() => {});
      return { ok: false, status: 429, reason: "GeckoTerminal 429 (rate limited)", body: null };
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status, reason: `GeckoTerminal ${res.status}`, body: null };
    }
    return { ok: true, status: res.status, reason: null, body: (await res.json()) as T };
  } catch (err) {
    // undici hides the syscall in err.cause; `fetch failed` alone names neither
    // the host nor what went wrong.
    const e = err as { message?: string; cause?: { code?: string } };
    const code = e?.cause?.code;
    return { ok: false, status: 0, reason: `${e?.message || "request failed"}${code ? `: ${code}` : ""}`, body: null };
  }
}
