import test from "node:test";
import assert from "node:assert/strict";
import {
  _MAX_PER_SWEEP,
  _MISS_TTL_MS,
  _UNDECIDED_TTL_MS,
  _resetLogoMemory,
  backfillLogos,
  knownLogo,
  rememberLogo,
  shouldLookUp,
  sweepLogos,
  type FillDeps,
} from "./logoFill.ts";
import { resolveLogo, type LogoResult } from "./tokenLogo.ts";

const T = 1_700_000_000_000;
const found = (url: string): LogoResult => ({ ok: true, url, source: "dexscreener", tried: ["dexscreener"], unreachable: [] });
/** Every source answered; this project genuinely has no artwork. */
const nothing = (): LogoResult => ({ ok: true, url: null, source: null, tried: ["dexscreener-cdn"], unreachable: [] });
/** A source could not be asked — we know nothing, which is not the same. */
const undecided = (): LogoResult => ({ ok: false, url: null, source: null, tried: [], unreachable: ["coingecko: 429"] });

const tok = (n: number) => ({ chain: "ethereum", address: `0x${String(n).padStart(40, "0")}` });

test.beforeEach(() => _resetLogoMemory());

test("a resolved logo is remembered and written to the listing store", async () => {
  const wrote: string[] = [];
  const r = await sweepLogos([tok(1)], {
    resolve: async () => found("https://img.example/a.png"),
    persist: async (c, a) => {
      wrote.push(`${c}:${a}`);
      return true;
    },
    now: () => T,
  });
  assert.deepEqual(r, { looked: 1, found: 1, missing: 0, undecided: 0, persisted: 1, bySource: { dexscreener: 1 } });
  assert.equal(knownLogo("ethereum", tok(1).address), "https://img.example/a.png");
  assert.deepEqual(wrote, [`ethereum:${tok(1).address}`]);
  assert.equal(shouldLookUp("ethereum", tok(1).address, T + _MISS_TTL_MS * 10), false, "a found logo is never re-resolved");
});

test("a failed store write costs permanence, never the logo", async () => {
  const r = await sweepLogos([tok(2)], {
    resolve: async () => found("https://img.example/b.png"),
    persist: async () => {
      throw new Error("mongo down");
    },
    now: () => T,
  });
  assert.equal(r.found, 1);
  assert.equal(r.persisted, 0);
  assert.equal(knownLogo("ethereum", tok(2).address), "https://img.example/b.png");
});

test("'no artwork anywhere' is remembered as an answer, with a shelf life", async () => {
  await sweepLogos([tok(3)], { resolve: async () => nothing(), now: () => T });
  assert.equal(knownLogo("ethereum", tok(3).address), null);
  assert.equal(shouldLookUp("ethereum", tok(3).address, T + 60_000), false, "not on every board rebuild");
  assert.equal(
    shouldLookUp("ethereum", tok(3).address, T + _MISS_TTL_MS + 1),
    true,
    "a project that uploads artwork today should be wearing it today",
  );
});

test("⚠️ 'could not ask' is NOT remembered as 'no logo'", async () => {
  // One rate-limited minute must never leave a token monogrammed for good.
  await sweepLogos([tok(4)], { resolve: async () => undecided(), now: () => T });
  assert.equal(
    shouldLookUp("ethereum", tok(4).address, T + _UNDECIDED_TTL_MS + 1),
    true,
    "retried once the upstream has had time to recover",
  );
  assert.ok(_UNDECIDED_TTL_MS < _MISS_TTL_MS, "an outage must clear sooner than an answer goes stale");
});

test("…and it is still rate-limited, or one bad row eats every sweep", async () => {
  await sweepLogos([tok(5)], { resolve: async () => undecided(), now: () => T });
  assert.equal(shouldLookUp("ethereum", tok(5).address, T + 60_000), false);
});

test("a sweep is bounded — a board of eighty logo-less rows drains, it does not burst", async () => {
  const asked: string[] = [];
  const many = Array.from({ length: 40 }, (_, i) => tok(100 + i));
  const r = await sweepLogos(many, {
    resolve: async (_c, a) => {
      asked.push(a);
      return nothing();
    },
    now: () => T,
  });
  assert.equal(r.looked, _MAX_PER_SWEEP);
  assert.equal(asked.length, _MAX_PER_SWEEP);
  assert.deepEqual(asked, many.slice(0, _MAX_PER_SWEEP).map((t) => t.address), "in the order the board ranked them");
});

test("a row already decided is skipped without spending the budget", async () => {
  rememberLogo("ethereum", tok(6).address, "https://img.example/c.png", T);
  let asked = 0;
  const r = await sweepLogos([tok(6), tok(7)], {
    resolve: async () => {
      asked++;
      return nothing();
    },
    now: () => T,
  });
  assert.equal(asked, 1);
  assert.equal(r.looked, 1);
});

test("a resolver that throws costs one row, never the rest of the sweep", async () => {
  const r = await sweepLogos([tok(8), tok(9)], {
    resolve: async (_c, a) => {
      if (a === tok(8).address) throw new Error("boom");
      return found("https://img.example/d.png");
    },
    now: () => T,
  });
  assert.equal(r.undecided, 1, "a thrown resolver is undecided, not 'no logo'");
  assert.equal(r.found, 1);
  assert.equal(knownLogo("ethereum", tok(9).address), "https://img.example/d.png");
});

test("the log line reports WHERE the logos came from", async () => {
  const lines: string[] = [];
  await sweepLogos([tok(10)], {
    resolve: async () => ({ ...found("https://img.example/e.png"), source: "coingecko" }),
    now: () => T,
    log: (m) => lines.push(m),
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /1 coingecko/, "one source quietly carrying all of it is worth being able to see");
});

test("a sweep that looked at nothing says nothing", async () => {
  const lines: string[] = [];
  await sweepLogos([], { resolve: async () => nothing(), now: () => T, log: (m) => lines.push(m) });
  assert.deepEqual(lines, []);
});

test("backfillLogos returns instantly and never runs two sweeps at once", async () => {
  // A board render calls this. If it could block, the board would wait on three
  // rate-limited APIs and a verification fetch.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let asked = 0;
  const deps: FillDeps = {
    resolve: async () => {
      asked++;
      await gate;
      return nothing();
    },
    now: () => T,
  };

  const before = Date.now();
  backfillLogos([tok(20), tok(21)], deps);
  backfillLogos([tok(22)], deps); // second render, first sweep still in flight
  assert.ok(Date.now() - before < 50, "returned without awaiting the lookup");
  assert.equal(asked, 1, "the second call did not start a second sweep");

  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asked, 2, "the first sweep carried on through its own list");
});

test("a store that refuses every write is reported as a FAULT, not a count", () => {
  // "0 written" reads as a detail in a line that also says "3 found". A sweep
  // whose work cannot be persisted loses it on the next restart, and the logos
  // come back with nothing anywhere saying why.
  const lines: string[] = [];
  return sweepLogos([tok(30)], {
    resolve: async () => found("https://img.example/f.png"),
    persist: async () => false,
    now: () => T,
    log: (m) => lines.push(m),
  }).then(() => {
    assert.match(lines[0], /NONE of them could be written/);
  });
});

test("…and it stays quiet when there was nothing to write", async () => {
  const lines: string[] = [];
  await sweepLogos([tok(31)], { resolve: async () => nothing(), now: () => T, log: (m) => lines.push(m) });
  assert.ok(!/NONE of them/.test(lines[0]), "no logos found is not a store fault");
});

// ── the two halves as one chain ─────────────────────────────────────────────

test("⚠️ END TO END: a logo we were handed but could not open is UNDECIDED, not a 12h miss", async () => {
  // The two rules above are each pinned at their own seam, and the defect lived
  // in the JOIN: resolveLogo collapsed "could not verify" into "not artwork",
  // so `ok` stayed true and this sweep wrote a twelve-hour miss about a token
  // whose url DexScreener had just handed us. Driving the REAL resolver is the
  // only thing that catches that — a stubbed LogoResult asserts the shape the
  // stub was given.
  const IMG = "https://cdn.example/logo.png";
  const r = await sweepLogos([tok(9)], {
    now: () => T,
    resolve: (c, a) =>
      resolveLogo(c, a, {
        ds: async () => IMG,
        gt: async () => null,
        cg: async () => null,
        tw: () => null,
        verify: async () => "unreachable",
      }),
  });
  assert.equal(r.undecided, 1);
  assert.equal(r.missing, 0, "we were handed artwork — 'no artwork anywhere' is a false claim here");
  // …and it is retried in half an hour rather than half a day.
  assert.equal(shouldLookUp("ethereum", tok(9).address, T + _UNDECIDED_TTL_MS + 1), true);
});

test("…and one that really is not an image stays a decided miss", async () => {
  const r = await sweepLogos([tok(10)], {
    now: () => T,
    resolve: (c, a) =>
      resolveLogo(c, a, {
        ds: async () => "https://cdn.example/logo.png",
        gt: async () => null,
        cg: async () => null,
        tw: () => null,
        verify: async () => "not-image",
      }),
  });
  assert.equal(r.missing, 1);
  assert.equal(r.undecided, 0);
  assert.equal(shouldLookUp("ethereum", tok(10).address, T + _UNDECIDED_TTL_MS + 1), false, "a real miss is not re-asked in 30 minutes");
});

// ── The backlog ──────────────────────────────────────────────────────────────
// "bagaimana dengan logonya?" — and the line that was supposed to answer it
// could not. "Some tokens have no logo" has two completely different causes
// this rendered identically: the resolver is failing, or it is working through
// a queue at MAX_PER_SWEEP a minute and has not reached that row yet.
test("the sweep line says how much is LEFT, so the wait is arithmetic not a fault", async () => {
  _resetLogoMemory();
  const lines: string[] = [];
  const many = Array.from({ length: 214 }, (_, i) => ({ chain: "solana", address: `a${i}` }));
  await sweepLogos(many, {
    resolve: async () => ({ ok: true, url: "https://x/l.png", source: "dexscreener", tried: [], unreachable: [] }),
    log: (m) => lines.push(m),
    queued: many.length,
  });
  const line = lines.join("\n");
  assert.match(line, /206 still queued/, "214 queued minus the 8 this pass looked at");
  assert.match(line, /~26 more rebuild\(s\)/, "…and how many rebuilds that is");
});

test("no backlog line when the queue fits in one pass — a finished queue is not news", async () => {
  _resetLogoMemory();
  const lines: string[] = [];
  const few = [{ chain: "solana", address: "z1" }, { chain: "solana", address: "z2" }];
  await sweepLogos(few, {
    resolve: async () => ({ ok: true, url: "https://x/l.png", source: "dexscreener", tried: [], unreachable: [] }),
    log: (m) => lines.push(m),
    queued: few.length,
  });
  assert.doesNotMatch(lines.join("\n"), /still queued/);
});

test("⚠️ an absent `queued` reports NO backlog rather than guessing one", async () => {
  // A caller that does not know the queue length must not make the line invent
  // a number: a fabricated backlog is the same class of claim as a fabricated
  // 0%, on the line an operator reads to decide whether to go hunting.
  _resetLogoMemory();
  const lines: string[] = [];
  await sweepLogos(
    Array.from({ length: 50 }, (_, i) => ({ chain: "solana", address: `q${i}` })),
    {
      resolve: async () => ({ ok: true, url: "https://x/l.png", source: "dexscreener", tried: [], unreachable: [] }),
      log: (m) => lines.push(m),
    },
  );
  assert.doesNotMatch(lines.join("\n"), /still queued/);
});
