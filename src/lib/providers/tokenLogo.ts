// A LOGO FOR EVERY ROW ON THE BOARD, from whichever index has one.
//
// "beberapa token tidak punya logo — cari sumber projectnya dan tambahkan
// logo." The board was drawing `BT`, `SH`, `FL` monograms: the right fallback,
// and the wrong thing to have to draw for a project whose artwork is sitting on
// four public indexes.
//
// WHY THE SITE RESOLVES THIS AT ALL, when bot/src/services/tokenLogo.js exists
// The bot's resolver is richer (it can reach the launchpads and Trust Wallet)
// and it is the same idea — but it runs from `npm run listings:fix`, a manual
// script an operator has to remember. This repo has already learnt what that
// costs: "apt-get install is not a fix, it is a request" cost six days of
// banners publishing boxes. A row listed today gets its logo today, without
// anyone typing anything, or the monogram comes back with the next listing.
// What the site resolves it PERSISTS to the listing store, so the answer is
// found once and then belongs to the bot's board too.
//
// THE ORDER IS "HOW MUCH DOES THIS SOURCE KNOW ABOUT THE TOKEN":
//   1. DexScreener pair info — what the project itself uploaded
//   2. GeckoTerminal token   — a second index, different submissions
//   3. CoinGecko by contract — curated; a human has looked at this one
//   4. DexScreener's CDN     — a URL CONVENTION, not an answer (see below)
//
// Relative imports with extensions: node:test resolves this file, and "@/" is
// a Next-only alias.
import { CHAINS } from "../../config/chains.ts";

const TIMEOUT_MS = 8000;

export type LogoSource = "dexscreener" | "geckoterminal" | "coingecko" | "dexscreener-cdn";

export interface LogoResult {
  /**
   * ⚠️ THE WHOLE POINT OF THIS SHAPE. `ok: true, url: null` means every source
   * ANSWERED and none had artwork — the only state in which a caller may
   * remember "this token has no logo". `ok: false` means at least one source
   * could not be asked, and the honest answer is "not known yet": cache that
   * as a miss and one rate-limited minute leaves a token monogrammed for good.
   */
  ok: boolean;
  url: string | null;
  source: LogoSource | null;
  /** Candidates we actually fetched, in order — so a caller can report WHERE a
   *  logo came from. "42 of 50 from CoinGecko" is the difference between a
   *  working chain of sources and one source quietly carrying all of it. */
  tried: LogoSource[];
  /** Sources that could not be asked, with the reason. Never silently dropped:
   *  an outage on our side must not be reported as "the project has no logo". */
  unreachable: string[];
}

/** Only https. An http:// image is a mixed-content block in the browser, and a
 *  data: URI from an upstream is not artwork we want to store in a listing. */
const httpsUrl = (u: unknown): string | null => {
  const s = String(u ?? "").trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : null;
};

/**
 * Does this URL actually serve an image? Never throws.
 *
 * HEAD first because it costs no bytes, then GET — some CDNs answer HEAD with
 * 405 while serving the file perfectly well, and treating that as a miss throws
 * away a good logo. A 200 carrying HTML is a CDN's error page, which is exactly
 * what the CDN convention below returns for a token it has never seen.
 */
export async function isImage(url: string): Promise<boolean> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetch(url, {
        method,
        headers: { "user-agent": "Mozilla/5.0 (compatible; DexvraLogo/1.0)", accept: "image/*,*/*" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
        cache: "no-store",
      });
      if (res.status === 405 || res.status === 501) continue; // HEAD refused — try GET
      if (!res.ok) return false;
      const type = String(res.headers.get("content-type") ?? "").toLowerCase();
      if (type.startsWith("image/")) return true;
      if (type) return false;
      return method === "GET"; // no content-type at all: accept only real bytes
    } catch {
      return false; // a candidate we cannot reach is a candidate we cannot use
    }
  }
  return false;
}

/**
 * DexScreener's token-image CDN path.
 *
 * A CONVENTION we construct rather than an answer we were given, which is why
 * it is LAST and why it is verified like everything else: it can always be
 * built and is very often a 404. Storing one unverified turns "no logo" into
 * "broken image", and the monogram at least looks deliberate.
 */
export function cdnGuess(chain: string, address: string): string | null {
  const slug = CHAINS[chain]?.dexscreener;
  if (!slug || !address) return null;
  // EVM addresses are stored lowercased on that CDN; base58/base64 chains are
  // case-significant and must go verbatim.
  const addr = /^0x[a-fA-F0-9]{40}$/.test(address) ? address.toLowerCase() : address;
  return `https://dd.dexscreener.com/ds-data/tokens/${slug}/${addr}.png?size=lg`;
}

// ── the sources ─────────────────────────────────────────────────────────────
// Each returns a url or null ("asked, nothing there") and THROWS when it could
// not be asked. That distinction is the whole contract above; a source that
// swallowed its own failure would report an outage as an absence of artwork.

async function dsLogo(chain: string, address: string): Promise<string | null> {
  const slug = CHAINS[chain]?.dexscreener;
  if (!slug) return null; // DexScreener does not carry this chain — an answer
  const res = await fetch(`https://api.dexscreener.com/tokens/v1/${slug}/${encodeURIComponent(address)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const pairs = (await res.json()) as { baseToken?: { address?: string }; info?: { imageUrl?: string } }[];
  const want = address.toLowerCase();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    // Only pairs where our token is the BASE side: a token also appears as the
    // quote side of someone else's pair, and that pair's image is the OTHER
    // token's — a wrong logo, which is worse than none.
    if ((p.baseToken?.address ?? "").toLowerCase() !== want) continue;
    const u = httpsUrl(p.info?.imageUrl);
    if (u) return u;
  }
  return null;
}

async function gtLogo(chain: string, address: string): Promise<string | null> {
  const net = CHAINS[chain]?.geckoNetwork;
  if (!net) return null;
  const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${encodeURIComponent(address)}`, {
    headers: { accept: "application/json;version=20230302" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 404) return null; // GT does not index it — an answer
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
  const json = (await res.json()) as { data?: { attributes?: { image_url?: string | null } } };
  const img = json.data?.attributes?.image_url;
  // GT sends the literal string "missing.png" for a token with no artwork.
  return img && !String(img).endsWith("missing.png") ? httpsUrl(img) : null;
}

/*
 * ⚠️ COINGECKO IS PACED, AND IT IS THE SOURCE THAT ACTUALLY FINDS THINGS.
 *
 * Its free tier is a handful of calls a minute PER IP — and the bot suite runs
 * on the same box, against the same ceiling, for the same reason. A backfill
 * that fires one call per row is a 429 by the tenth row, and a 429 is `ok:false`
 * for every row after it. So: one call at a time, a minimum gap between them,
 * `Retry-After` honoured once. Slower than an unpaced run; an unpaced run does
 * not finish.
 */
const cgGapMs = (): number => {
  const n = Number(String(process.env.CG_MIN_GAP_MS ?? "").trim());
  // Number('') is 0 — finite, non-negative, and it would silently delete the
  // pacing this comment exists to describe. The blank check is the whole guard.
  return String(process.env.CG_MIN_GAP_MS ?? "").trim() !== "" && Number.isFinite(n) && n >= 0 ? n : 2500;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cgNextAt = 0;
let cgChain: Promise<void> = Promise.resolve();

/** Serialise CoinGecko calls and space them out. Concurrent callers queue
 *  rather than all firing at once, which is what a `Promise.all` would do. */
function cgSlot(): Promise<void> {
  const wait = cgChain.then(async () => {
    const now = Date.now();
    const delay = Math.max(0, cgNextAt - now);
    if (delay) await sleep(delay);
    cgNextAt = Math.max(now, cgNextAt) + cgGapMs();
  });
  cgChain = wait.catch(() => {});
  return wait;
}

async function cgLogo(chain: string, address: string, retried = false): Promise<string | null> {
  const plat = CHAINS[chain]?.coingecko;
  if (!plat) return null; // no platform id — nothing to ask, and that is an answer
  await cgSlot();
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/${plat}/contract/${encodeURIComponent(address)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 429 && !retried) {
    const h = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(h) && h > 0 ? Math.min(h * 1000, 60_000) : cgGapMs() * 4);
    return cgLogo(chain, address, true); // once; a second refusal is a real limit
  }
  // 404 is the ORDINARY answer here — CoinGecko is curated, so most memecoins
  // simply are not in it. A 429 or a 5xx is the opposite: it never looked, and
  // reporting that as "not in CoinGecko" is how a rate limit becomes a
  // permanent monogram.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const j = (await res.json()) as { image?: { large?: string; small?: string; thumb?: string } };
  return httpsUrl(j.image?.large ?? j.image?.small ?? j.image?.thumb ?? null);
}

export interface LogoDeps {
  ds?: (chain: string, address: string) => Promise<string | null>;
  gt?: (chain: string, address: string) => Promise<string | null>;
  cg?: (chain: string, address: string) => Promise<string | null>;
  verify?: (url: string) => Promise<boolean>;
}

/**
 * The best logo url for a token, or `null` when no source has one.
 *
 * The three API sources are asked CONCURRENTLY — they are independent services
 * and a backfill walks dozens of rows, so serial timeouts per token are the
 * difference between a sweep and an afternoon. Only the CANDIDATES are then
 * tried in order, and the first one that really serves an image wins.
 */
export async function resolveLogo(chain: string, address: string, deps: LogoDeps = {}): Promise<LogoResult> {
  const ds = deps.ds ?? dsLogo;
  const gt = deps.gt ?? gtLogo;
  const cg = deps.cg ?? cgLogo;
  const verify = deps.verify ?? isImage;

  const unreachable: string[] = [];
  const ask = (name: string, fn: () => Promise<string | null>): Promise<string | null> =>
    Promise.resolve()
      .then(fn)
      .catch((e: unknown) => {
        unreachable.push(`${name}: ${(e as Error)?.message || "failed"}`);
        return null;
      });

  const [dsUrl, gtUrl, cgUrl] = await Promise.all([
    ask("dexscreener", () => ds(chain, address)),
    ask("geckoterminal", () => gt(chain, address)),
    ask("coingecko", () => cg(chain, address)),
  ]);

  const candidates: [LogoSource, string | null][] = [
    ["dexscreener", httpsUrl(dsUrl)],
    ["geckoterminal", httpsUrl(gtUrl)],
    ["coingecko", httpsUrl(cgUrl)],
    ["dexscreener-cdn", cdnGuess(chain, address)],
  ];

  const tried: LogoSource[] = [];
  for (const [source, url] of candidates) {
    if (!url) continue;
    tried.push(source);
    if (await verify(url)) return { ok: true, url, source, tried, unreachable };
  }

  return { ok: unreachable.length === 0, url: null, source: null, tried, unreachable };
}

// ── which of the logos we hold does a row actually render? ───────────────────

export type LogoKind = "stored" | "live" | "resolved" | "convention" | "none";

export interface PickedLogo {
  url: string | null;
  kind: LogoKind;
}

/**
 * THE LADDER, and the bug it exists to fix.
 *
 * `rowToBoardToken` filled every row's `logoUrl` with `cdnGuess()` — a URL we
 * CONSTRUCT and that is very often a 404 — and the board pipeline then merged
 * live market data with `t.logoUrl ?? m.logoUrl`. Since the guess is never
 * null on a DexScreener chain, the `??` could never reach the second operand:
 * a made-up path permanently outranked the real `image_url` GeckoTerminal and
 * DexScreener were handing us, and the row drew a monogram while a logo sat
 * one field away. A guess must always lose to an answer.
 *
 *   stored     — the listing's own: an admin set it, or the project uploaded it
 *   live       — what a market provider asserted this cycle
 *   resolved   — what our own multi-source resolver verified
 *   convention — the DexScreener CDN path; unverified, so LAST, and marked
 *
 * `kind` is not decoration: it is how the caller knows the row is still
 * effectively logo-less and belongs in the resolver's queue.
 */
export function pickLogo(x: {
  stored?: string | null;
  live?: string | null;
  resolved?: string | null;
  chain: string;
  address: string;
}): PickedLogo {
  const stored = httpsUrl(x.stored) ?? (String(x.stored ?? "").startsWith("/") ? String(x.stored) : null);
  if (stored) return { url: stored, kind: "stored" }; // includes our own /api/media uploads
  const live = httpsUrl(x.live);
  if (live) return { url: live, kind: "live" };
  const resolved = httpsUrl(x.resolved);
  if (resolved) return { url: resolved, kind: "resolved" };
  const guess = cdnGuess(x.chain, x.address);
  // Still worth rendering: the browser 404s quietly and <Coin> falls back to
  // the monogram, so an unverified guess costs nothing and sometimes hits.
  return guess ? { url: guess, kind: "convention" } : { url: null, kind: "none" };
}
