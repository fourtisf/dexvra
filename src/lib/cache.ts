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
}

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
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

// Survive Next.js dev-mode module reloads with a global singleton.
const g = globalThis as { __appCache?: KVCache };
export const cache: KVCache = g.__appCache ?? (g.__appCache = new MemoryCache());

/** Fetch-through helper: fresh hit → cached; miss → loader; loader failure → stale if any. */
export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = cache.get<T>(key);
  if (hit !== undefined) return hit;
  try {
    const value = await loader();
    cache.set(key, value, ttlMs);
    return value;
  } catch (err) {
    const stale = cache.getStale<T>(key);
    if (stale !== undefined) return stale;
    throw err;
  }
}
