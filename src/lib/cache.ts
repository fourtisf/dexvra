// TTL cache behind a minimal interface so the in-memory impl can be swapped
// for Redis (Upstash) without touching providers. stale value is kept and
// served when a refresh fails — providers are flaky free tiers.
interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface KVCache {
  get<T>(key: string): T | undefined;
  getStale<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  /** How many entries are held. Present so the bound below can be tested. */
  readonly size?: number;
}

/**
 * ⚠️ THE CACHE IS BOUNDED, because half its keys come from a query string.
 *
 * `/api/token-preview`, `/api/pool` and `/api/ohlcv` all key on an address a
 * stranger typed, and nothing here ever removed an entry — an expired one just
 * sat in the Map until something overwrote it. So a loop over random addresses
 * grew this process's memory without limit, and the biggest entries are candle
 * arrays (a couple of hundred rows each).
 *
 * Evicted by INSERTION ORDER of the last write, not by expiry: an expired entry
 * is still the stale copy `cached()` serves when a provider is down, and that
 * safety net is the difference between a stale board and a demo one. The keys
 * the app actually lives on are rewritten every cycle, so they move to the back
 * of the queue and are never the ones dropped.
 */
const MAX_ENTRIES = 1200;

class MemoryCache implements KVCache {
  private store = new Map<string, Entry<unknown>>();

  get<T>(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) return undefined;
    return e.value as T;
  }

  getStale<T>(key: string): T | undefined {
    return this.store.get(key)?.value as T | undefined;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    // Delete before set: a Map keeps a key's ORIGINAL insertion position on
    // overwrite, so without this the most-written key would be the first one
    // evicted — exactly backwards.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (this.store.size > MAX_ENTRIES) {
      for (const k of this.store.keys()) {
        this.store.delete(k);
        if (this.store.size <= MAX_ENTRIES) break;
      }
    }
  }

  /** Entries currently held — exported for the test that pins the bound. */
  get size(): number {
    return this.store.size;
  }
}

// Survive Next.js dev-mode module reloads with a global singleton.
const g = globalThis as { __appCache?: KVCache };
export const cache: KVCache = g.__appCache ?? (g.__appCache = new MemoryCache());
export const CACHE_MAX_ENTRIES = MAX_ENTRIES;

// In-flight loads coalesced by key so a burst of concurrent misses triggers
// one provider call, not N — the third-party free tiers are rate-limited.
const g2 = globalThis as { __appInflight?: Map<string, Promise<unknown>> };
const inflight: Map<string, Promise<unknown>> =
  g2.__appInflight ?? (g2.__appInflight = new Map());

/** Fetch-through helper: fresh hit → cached; miss → loader (deduped);
 *  loader failure → stale if any. */
export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = cache.get<T>(key);
  if (hit !== undefined) return hit;

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const load = (async () => {
    try {
      const value = await loader();
      cache.set(key, value, ttlMs);
      return value;
    } catch (err) {
      const stale = cache.getStale<T>(key);
      if (stale !== undefined) return stale;
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, load);
  return load;
}
