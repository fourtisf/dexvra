import test from "node:test";
import assert from "node:assert/strict";
import { hedge, type Rung } from "./hedge.ts";

// `$DLYN` (Pons, Robinhood) went out to 12,436 subscribers drawing the Dexvra
// mark over artwork its own pad page rendered that minute. The proxy's ladder
// was SERIAL at 5s a gateway: a fresh CID is a DHT walk that routinely takes
// longer than that on the first public gateway, so the walk was killed a moment
// before it answered and the next gateway restarted it from zero. These drive
// the scheduler with fake gateways, because "killed one second too early" is a
// timing shape no source scan can see.

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("aborted"));
    });
  });

/** A fake gateway: answers after `ms` with an image or a miss. */
const gw = (ms: number, hit: boolean, name: string, log: string[]) => async (signal: AbortSignal): Promise<Rung<string>> => {
  log.push(`start ${name}`);
  try {
    await sleep(ms, signal);
  } catch {
    log.push(`abort ${name}`);
    return { done: false, miss: `${name}: aborted` };
  }
  return hit ? { done: true, value: name } : { done: false, miss: `${name}: HTTP 404` };
};

test("⚠️ a SLOW first gateway is never killed by the ladder — it wins if it answers first", async () => {
  // The reported shape: gateway 0 needs 400ms (the "5–10s DHT walk", scaled),
  // the stagger is 100ms, and gateways 1–3 miss slowly. A serial ladder with a
  // per-try cap below 400ms can never return an image here.
  const log: string[] = [];
  const g = [gw(400, true, "ipfs.io", log), gw(700, false, "pinata", log), gw(700, false, "w3s", log), gw(700, false, "dweb", log)];
  const t0 = Date.now();
  const v = await hedge(g.length, (i, s) => g[i](s), { staggerMs: 100, deadline: Date.now() + 2000 });
  assert.equal(v, "ipfs.io");
  assert.ok(Date.now() - t0 < 600, "it answered when the slow gateway did, not after the others gave up");
  assert.ok(log.includes("abort pinata"), "…and the losers are cancelled, not left downloading");
});

test("the next gateway is STARTED while the first is still slow, and the first to answer wins", async () => {
  const log: string[] = [];
  const g = [gw(1000, true, "slow", log), gw(50, true, "fast", log)];
  const v = await hedge(g.length, (i, s) => g[i](s), { staggerMs: 100, deadline: Date.now() + 2000 });
  assert.equal(v, "fast");
  assert.deepEqual(log.slice(0, 2), ["start slow", "start fast"]);
});

test("a WARM answer costs exactly one request — the hedge only fires when a gateway is already slow", async () => {
  const log: string[] = [];
  const g = [gw(20, true, "a", log), gw(20, true, "b", log), gw(20, true, "c", log)];
  const v = await hedge(g.length, (i, s) => g[i](s), { staggerMs: 200, deadline: Date.now() + 2000 });
  assert.equal(v, "a");
  await sleep(250);
  assert.deepEqual(log, ["start a"], "no second gateway was asked");
});

test("a MISS starts the next gateway at once rather than waiting out the stagger", async () => {
  const log: string[] = [];
  const g = [gw(10, false, "a", log), gw(10, true, "b", log)];
  const t0 = Date.now();
  const v = await hedge(g.length, (i, s) => g[i](s), { staggerMs: 1000, deadline: Date.now() + 5000 });
  assert.equal(v, "b");
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0}ms — the miss waited for the stagger`);
});

test("every gateway missing → null, with every reason kept in arrival order", async () => {
  const log: string[] = [];
  const misses: string[] = [];
  const g = [gw(30, false, "a", log), gw(10, false, "b", log), gw(20, false, "c", log)];
  const v = await hedge(g.length, (i, s) => g[i](s), { staggerMs: 5, deadline: Date.now() + 2000, misses });
  assert.equal(v, null);
  assert.equal(misses.length, 3, "one reason per gateway, or x-logo-why names fewer than were asked");
  assert.ok(misses.every((m) => /HTTP 404/.test(m)));
});

test("a gateway that THROWS is a miss, never a crash of the whole ladder", async () => {
  const misses: string[] = [];
  const v = await hedge<string>(2, async (i) => {
    if (i === 0) throw new Error("boom");
    return { done: true, value: "second" };
  }, { staggerMs: 1000, deadline: Date.now() + 2000, misses });
  assert.equal(v, "second");
  assert.match(misses[0], /boom/);
});

test("no rung STARTS past the deadline — but the first always does", async () => {
  const log: string[] = [];
  const g = [gw(10, false, "a", log), gw(10, true, "b", log)];
  const v = await hedge(g.length, (i, s) => g[i](s), { staggerMs: 5, deadline: Date.now() - 1 });
  assert.equal(v, null);
  assert.deepEqual(log, ["start a"]);
});

test("the stagger timer is cleared on a win — a fast logo does not hold the event loop open", async () => {
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  await hedge(3, async () => ({ done: true, value: 1 }), { staggerMs: 60_000, deadline: Date.now() + 60_000 });
  const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.ok(after <= before, `a ${60}s stagger timer survived the win (${before} → ${after})`);
});
