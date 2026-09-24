// holders:check is DRIVEN against a stub web app: `node --check` proves syntax,
// and the thing worth knowing is what it prints and what it exits with.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/holders-check.mjs");

function stub(holders: (chain: string) => unknown) {
  const srv = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    res.setHeader("content-type", "application/json");
    if (u.pathname === "/api/tokens")
      return res.end(JSON.stringify({ build: "abc1234", tokens: [
        { chain: "robinhood", address: "0x0a574aae41da077713ba32aa05ca151c8759e2f6", symbol: "$SFX", mcap: 1_160_000 },
        { chain: "solana", address: "So11111111111111111111111111111111111111112", symbol: "SOLX", mcap: 5 },
      ] }));
    if (u.pathname === "/api/holders") return res.end(JSON.stringify({ build: "abc1234", ...(holders(u.searchParams.get("chain") ?? "") as object) }));
    res.statusCode = 404; res.end("{}");
  });
  return new Promise<{ base: string; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () => ok({ base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() })));
}

const run = (base: string, args: string[] = []) =>
  new Promise<{ code: number; out: string }>((ok) =>
    execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, BASE_URL: base } }, (err, stdout, stderr) =>
      ok({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr })));

test("it names the count AND the host that gave it, and a miss prints every source's reason", async () => {
  const s = await stub((c) => (c === "robinhood"
    ? { count: 1570, source: "blockscout", via: "explorer.mainnet.chain.robinhood.com", why: null }
    : { count: null, source: null, via: null, why: "dexscreener: io.dexscreener.com 403" }));
  try {
    const r = await run(s.base);
    assert.equal(r.code, 0, "a partial answer is not a broken box");
    assert.match(r.out, /1,570 holders · blockscout via explorer\.mainnet\.chain\.robinhood\.com/);
    assert.match(r.out, /no count — dexscreener: io\.dexscreener\.com 403/);
    assert.match(r.out, /build abc1234/);
    assert.match(r.out, /\$SFX robinhood\//, "one dollar sign, never two");
  } finally { s.close(); }
});

test("⚠️ no source answering anything exits non-zero", async () => {
  const s = await stub(() => ({ count: null, source: null, via: null, why: "robinhoodchain.blockscout.com unreachable (ENOTFOUND)" }));
  try {
    const r = await run(s.base, ["robinhood", "0x0a574aae41da077713ba32aa05ca151c8759e2f6"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /unreachable \(ENOTFOUND\)/);
  } finally { s.close(); }
});
