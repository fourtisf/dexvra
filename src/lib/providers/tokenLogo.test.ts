import test from "node:test";
import assert from "node:assert/strict";
import { _resetCgCooldown, cdnGuess, isImage, pickLogo, resolveLogo, type LogoDeps } from "./tokenLogo.ts";

const ADDR = "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce";
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const IMG = "https://img.example/logo.png";

/** Every source answers "nothing", every candidate verifies — the base the
 *  cases below vary one thing from. */
const none: LogoDeps = {
  ds: async () => null,
  gt: async () => null,
  cg: async () => null,
  tw: () => null, // silenced by default so the DS→GT→CG→CDN order is testable
  verify: async () => true,
};

test("the first source that really serves an image wins, in source order", async () => {
  const r = await resolveLogo("ethereum", ADDR, {
    ...none,
    ds: async () => IMG,
    gt: async () => "https://img.example/gt.png",
    cg: async () => "https://img.example/cg.png",
  });
  assert.equal(r.ok, true);
  assert.equal(r.url, IMG);
  assert.equal(r.source, "dexscreener");
  assert.deepEqual(r.tried, ["dexscreener"], "a winner stops the walk — no wasted fetches");
});

test("a candidate that does not verify is skipped, not stored", async () => {
  // The whole reason every candidate is fetched: an unverified url turns
  // "no logo" into "broken image", which is worse than the monogram.
  const r = await resolveLogo("ethereum", ADDR, {
    ...none,
    ds: async () => "https://img.example/404.png",
    gt: async () => IMG,
    verify: async (u) => u === IMG,
  });
  assert.equal(r.url, IMG);
  assert.equal(r.source, "geckoterminal");
  assert.deepEqual(r.tried, ["dexscreener", "geckoterminal"]);
});

test("CoinGecko is reached when the two indexes have nothing", async () => {
  const r = await resolveLogo("bsc", ADDR, { ...none, cg: async () => IMG });
  assert.equal(r.source, "coingecko");
});

test("Trust Wallet is a FREE source ahead of GeckoTerminal — it spends no GT quota", async () => {
  // A logo lookup that spends a GeckoTerminal request is a chart that does not
  // draw. Trust Wallet (GitHub CDN, EVM only) answers before GT is ever asked.
  let gtAsked = 0;
  const r = await resolveLogo("bsc", ADDR, {
    ...none,
    tw: () => "https://raw.githubusercontent.com/trustwallet/assets/x/logo.png",
    gt: async () => {
      gtAsked++;
      return IMG;
    },
  });
  assert.equal(r.source, "trustwallet");
  assert.equal(gtAsked, 0, "GeckoTerminal was never asked once a free source answered");
});

test("the CDN convention is the last candidate, never the first", async () => {
  const r = await resolveLogo("ethereum", ADDR, none);
  assert.equal(r.source, "dexscreener-cdn");
  assert.deepEqual(r.tried, ["dexscreener-cdn"]);
  assert.equal(r.ok, true);
});

test("every source answered and none had artwork — ok:true, url:null", async () => {
  // The ONLY state in which a caller may remember "this token has no logo".
  const r = await resolveLogo("ethereum", ADDR, { ...none, verify: async () => false });
  assert.equal(r.ok, true);
  assert.equal(r.url, null);
  assert.equal(r.source, null);
  assert.deepEqual(r.unreachable, []);
});

test("a source that could not be asked makes the answer UNDECIDED, not empty", async () => {
  // ⚠️ Caching this as "no logo" is how one rate-limited minute leaves a token
  // monogrammed for good.
  const r = await resolveLogo("ethereum", ADDR, {
    ...none,
    cg: async () => {
      throw new Error("CoinGecko 429");
    },
    verify: async () => false,
  });
  assert.equal(r.ok, false);
  assert.equal(r.url, null);
  assert.deepEqual(r.unreachable, ["coingecko: CoinGecko 429"]);
});

test("…but an unreachable source never costs a logo another source has", async () => {
  const r = await resolveLogo("ethereum", ADDR, {
    ...none,
    ds: async () => {
      throw new Error("DexScreener 500");
    },
    gt: async () => IMG,
  });
  assert.equal(r.ok, true);
  assert.equal(r.url, IMG);
  assert.equal(r.unreachable.length, 1, "and it still reports what it could not ask");
});

test("one source throwing does not stop the others being asked", async () => {
  let asked = 0;
  await resolveLogo("ethereum", ADDR, {
    ...none,
    ds: async () => {
      throw new Error("boom");
    },
    gt: async () => {
      asked++;
      return null;
    },
    cg: async () => {
      asked++;
      return null;
    },
    verify: async () => false,
  });
  assert.equal(asked, 2);
});

test("an http:// or junk candidate is refused before it is ever fetched", async () => {
  // Mixed content is a blocked image in the browser — a logo that renders as
  // nothing, with no error anywhere.
  const seen: string[] = [];
  const r = await resolveLogo("ethereum", ADDR, {
    ...none,
    ds: async () => "http://img.example/insecure.png",
    gt: async () => "not a url",
    cg: async () => IMG,
    verify: async (u) => {
      seen.push(u);
      return true;
    },
  });
  assert.equal(r.source, "coingecko");
  assert.deepEqual(seen, [IMG]);
});

test("a chain DexScreener does not carry has no CDN convention to fall back on", async () => {
  // Robinhood: no DexScreener slug, so the guess cannot be built — and a
  // fabricated path would 404 on every row of that chain.
  assert.equal(cdnGuess("robinhood", ADDR), null);
  const r = await resolveLogo("robinhood", ADDR, { ...none, verify: async () => true });
  assert.equal(r.url, null);
  assert.deepEqual(r.tried, []);
  assert.equal(r.ok, true);
});

test("the CDN path lowercases EVM and leaves base58 alone", async () => {
  // A Solana mint is case-SIGNIFICANT: lowercasing one asks for an address
  // that does not exist.
  assert.ok(cdnGuess("ethereum", "0x95AD61B0A150D79219DCF64E1E6CC01F0B64C4CE")?.includes(ADDR));
  assert.ok(cdnGuess("solana", MINT)?.includes(MINT));
});

test("an unknown chain resolves to nothing rather than throwing", async () => {
  const r = await resolveLogo("notachain", ADDR, { ...none, verify: async () => true });
  assert.equal(r.url, null);
  assert.equal(r.ok, true);
});

// ── isImage: the guard that keeps a 404 from becoming a broken image ────────

const withFetch = async (impl: typeof fetch, fn: () => Promise<void>) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
};

const reply = (status: number, type: string | null): Response =>
  new Response(status === 204 ? null : "x", {
    status,
    headers: type ? { "content-type": type } : {},
  });

test("isImage: image bytes pass, an HTML error page does not", async () => {
  await withFetch(async () => reply(200, "image/png"), async () => {
    assert.equal(await isImage(IMG), true);
  });
  // A 200 carrying HTML is a CDN's error page — exactly what the CDN
  // convention returns for a token it has never seen.
  await withFetch(async () => reply(200, "text/html"), async () => {
    assert.equal(await isImage(IMG), false);
  });
  await withFetch(async () => reply(404, "text/plain"), async () => {
    assert.equal(await isImage(IMG), false);
  });
});

test("isImage: a HEAD refused with 405 is retried as GET, not read as a miss", async () => {
  const methods: string[] = [];
  await withFetch(
    async (_u, init) => {
      methods.push(String(init?.method));
      return methods.length === 1 ? reply(405, "text/plain") : reply(200, "image/webp");
    },
    async () => {
      assert.equal(await isImage(IMG), true);
    },
  );
  assert.deepEqual(methods, ["HEAD", "GET"]);
});

test("isImage: a host we cannot reach is a candidate we cannot use", async () => {
  await withFetch(
    async () => {
      throw new Error("ENOTFOUND");
    },
    async () => {
      assert.equal(await isImage(IMG), false);
    },
  );
});

// ── the ladder ──────────────────────────────────────────────────────────────

test("⚠️ THE REGRESSION: a constructed CDN path never outranks a real logo", () => {
  // `rowToBoardToken` filled every row's logoUrl with cdnGuess(), and the board
  // merged live data with `t.logoUrl ?? m.logoUrl` — so the guess, which is
  // never null on a DexScreener chain, could never lose. Rows drew monograms
  // with GeckoTerminal's image_url sitting one field away.
  const live = pickLogo({ stored: null, live: IMG, chain: "ethereum", address: ADDR });
  assert.deepEqual(live, { url: IMG, kind: "live" });
  const resolved = pickLogo({ stored: null, live: null, resolved: IMG, chain: "ethereum", address: ADDR });
  assert.deepEqual(resolved, { url: IMG, kind: "resolved" });
});

test("a stored logo is a decision somebody made — it wins over everything", () => {
  const p = pickLogo({ stored: "https://cdn.example/admin.png", live: IMG, resolved: IMG, chain: "ethereum", address: ADDR });
  assert.equal(p.kind, "stored");
  // Our own uploads are relative paths, not https urls, and must survive too.
  assert.equal(pickLogo({ stored: "/api/media/logo.png", chain: "ethereum", address: ADDR }).url, "/api/media/logo.png");
});

test("with nothing asserted the convention is used, and MARKED as a guess", () => {
  // `kind` is how the board knows the row is still effectively logo-less and
  // belongs in the resolver's queue.
  const p = pickLogo({ chain: "ethereum", address: ADDR });
  assert.equal(p.kind, "convention");
  assert.ok(p.url?.startsWith("https://dd.dexscreener.com/"));
});

test("a chain with no convention reports none rather than inventing a path", () => {
  const p = pickLogo({ chain: "robinhood", address: ADDR });
  assert.deepEqual(p, { url: null, kind: "none" });
});

test("junk in any rung is skipped, not rendered", () => {
  const p = pickLogo({ stored: "  ", live: "not-a-url", resolved: "http://insecure/x.png", chain: "solana", address: MINT });
  assert.equal(p.kind, "convention");
});

// ── CoinGecko: the quota nobody else can spend for us ───────────────────────

test("CoinGecko is not asked at all when an index already has the artwork", async () => {
  // Its free tier is per IP and the bot suite shares that IP: a call made when
  // we already have the logo is a call the next row does not get.
  let cgCalls = 0;
  const r = await resolveLogo("ethereum", ADDR, {
    ...none,
    ds: async () => IMG,
    cg: async () => {
      cgCalls++;
      return null;
    },
  });
  assert.equal(r.source, "dexscreener");
  assert.equal(cgCalls, 0);
});

test("…and it IS asked the moment they have nothing", async () => {
  let cgCalls = 0;
  await resolveLogo("ethereum", ADDR, {
    ...none,
    cg: async () => {
      cgCalls++;
      return null;
    },
    verify: async () => false,
  });
  assert.equal(cgCalls, 1);
});

test("⚠️ a CoinGecko 429 benches it for the whole process, not just that row", async () => {
  // Pacing alone is not enough: eight rows in a sweep meant eight more requests
  // into a service that was already refusing, and every one came back
  // undecided anyway. The bot's resolver states the same rule about GT.
  process.env.CG_MIN_GAP_MS = "0"; // the pacing is not what is under test
  _resetCgCooldown();
  let hits = 0;
  const noIndexes: LogoDeps = { ds: async () => null, gt: async () => null, verify: async () => false };
  await withFetch(
    async () => {
      hits++;
      return new Response("{}", { status: 429, headers: { "content-type": "application/json" } });
    },
    async () => {
      const first = await resolveLogo("ethereum", ADDR, noIndexes);
      assert.equal(first.ok, false, "a refusal is undecided, never 'no logo'");
      assert.match(first.unreachable.join(" "), /429/);

      const second = await resolveLogo("ethereum", "0x2222222222222222222222222222222222222222", noIndexes);
      assert.equal(second.ok, false);
      assert.match(second.unreachable.join(" "), /benched/, "the second row is told why, without asking again");
    },
  );
  assert.equal(hits, 1, "one request, not one per row");
  _resetCgCooldown();
  delete process.env.CG_MIN_GAP_MS;
});

// ── a source that refuses us is benched, for every source ───────────────────
//
// These drive the REAL `dsLogo` (no `ds:` dep) by stubbing global fetch, which
// is the only way to exercise the HTTP status handling the rule lives in.

function stubStatus(status: number): { asked: () => number; restore: () => void } {
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (u: string | URL) => {
    if (String(u).includes("dexscreener")) {
      n++;
      return new Response(status === 404 ? "[]" : "no", { status });
    }
    return new Response("{}", { status: 404 }); // every other source: an answer, nothing there
  }) as typeof globalThis.fetch;
  return { asked: () => n, restore: () => { globalThis.fetch = orig; } };
}

const OTHER = "GUmbtfjSZkybSFgPibBcvwExEBdXwewJHR5PkTjzpump";

test("⚠️ a DexScreener 403 benches it — a sweep must not spend a row proving the same refusal", async () => {
  // CoinGecko got this rule when a 429 on row one cost a request per row for
  // the rest of the sweep. DexScreener never did, and it is the source that
  // matters MOST here: pump.fun artwork lives there and `resolveLogo` asks it
  // first. A box whose IP DexScreener refuses would spend eight requests a
  // sweep, every sweep, for ever — and every one of those rows came back
  // `undecided` and got requeued 30 minutes later.
  _resetCgCooldown();
  const f = stubStatus(403);
  try {
    await resolveLogo("solana", MINT, { tw: () => null, verify: async () => false });
    const spent = f.asked();
    assert.ok(spent >= 1, "the first row asked");
    await resolveLogo("solana", OTHER, { tw: () => null, verify: async () => false });
    assert.equal(f.asked(), spent, "the next row made no DexScreener request at all");
  } finally {
    f.restore();
    _resetCgCooldown();
  }
});

test("…but a DexScreener 404 does not — that is an answer about the token", async () => {
  // Treating a curated miss as an outage is how one absent token blinds the
  // source for every other row on the board.
  _resetCgCooldown();
  const f = stubStatus(404);
  try {
    await resolveLogo("solana", MINT, { tw: () => null, verify: async () => false });
    const spent = f.asked();
    await resolveLogo("solana", OTHER, { tw: () => null, verify: async () => false });
    assert.ok(f.asked() > spent, "the next row is still asked");
  } finally {
    f.restore();
    _resetCgCooldown();
  }
});
