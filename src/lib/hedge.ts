/**
 * A HEDGED ladder: start rung 0; if it has not settled after `staggerMs`,
 * start rung 1 WITHOUT cancelling rung 0; and so on. The first rung whose
 * answer is `done` wins and every rung still running is aborted. A rung that
 * answers with a MISS starts the next one immediately rather than waiting out
 * the stagger.
 *
 * Pure and alias-free, so `npm test` can DRIVE it — the logo proxy is a Next
 * route the test runner cannot load, and the defect this exists for (a slow
 * gateway killed at 5s, one second before it would have answered) is a TIMING
 * shape no source scan can see. See `/api/logo` for the incident.
 *
 * Returns the winning value, or null once every rung missed (or no rung was
 * allowed to start before `deadline`). `misses` collects each miss in the
 * order it ARRIVED, which is the order an operator reads the reasons in.
 */
export type Rung<T> = { done: true; value: T } | { done: false; miss: string };

export async function hedge<T>(
  count: number,
  start: (i: number, signal: AbortSignal) => Promise<Rung<T>>,
  opts: { staggerMs: number; deadline: number; misses?: string[] },
): Promise<T | null> {
  const stop = new AbortController();
  const misses = opts.misses ?? [];
  const out = await new Promise<T | null>((resolve) => {
    let next = 0;
    let running = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (v: T | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    const launch = () => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = null;
      // Only START another rung while there is time for it. The first rung
      // always starts — a request with no attempt at all is not a request.
      if (next >= count || (next > 0 && Date.now() > opts.deadline)) {
        if (running === 0) finish(null);
        return;
      }
      const i = next++;
      running++;
      // A rung that THROWS is a miss, never a crash of the whole ladder: the
      // next rung may still have it.
      Promise.resolve()
        .then(() => start(i, stop.signal))
        .catch((e): Rung<T> => ({ done: false, miss: `rung ${i} threw: ${e instanceof Error ? e.message : String(e)}` }))
        .then((r) => {
          running--;
          if (settled) return;
          if (r.done) return finish(r.value);
          misses.push(r.miss);
          launch(); // a miss frees its slot now — never wait out the stagger
        });
      if (next < count) timer = setTimeout(launch, opts.staggerMs);
    };
    launch();
  });
  // The losers are still downloading bytes nobody will read.
  stop.abort();
  return out;
}
