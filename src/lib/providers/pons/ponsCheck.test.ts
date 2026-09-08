import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

// ⚠️ `pons:check` PRINTED A GREEN `token.logo() → ipfs://…` OVER AN APP THAT
// WAS DISCARDING IT. Sections 1–5 read the CONTRACT; the bot and the site read
// the APP, and those are different stacks — so the check was honest about the
// chain and silent about the only thing the listing form depends on. Section 6
// closes that, and it is DRIVEN here rather than read: `node --check` proves
// syntax, and the defect this catches is a runtime shape.

const SCRIPT = fileURLToPath(new URL("../../../../scripts/pons-check.mjs", import.meta.url));
const TOKEN = "0x85ad1ec672f2d589f21dd3ac8b2164127d4651af";
const LOGO = "ipfs://bafkreif3og7rosylkz34ho7mbgzdkyscslhnastl3qszh6qykfwzg6lk3m";

const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const abiString = (s: string) => {
  const hex = Buffer.from(s, "utf8").toString("hex");
  return `0x${w(32)}${w(s.length)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
};
const launchRecord = () => {
  const words = Array.from({ length: 16 }, () => w(0));
  words[1] = "1".repeat(40).padStart(64, "0"); // the curve
  words[8] = w(250); // creator tax
  words[14] = w(1); // exists
  return `0x${words.join("")}`;
};

const ANSWER: Record<string, string> = {
  "0x3cf28b5a": launchRecord(),
  "0x0902f1ac": `0x${w(1000)}${w(2000)}`,
  "0x4f1f58fd": `0x${w(900)}`,
  "0x808bcddc": `0x${w(500)}`,
  "0xe7c2b772": `0x${w(0)}`,
  "0x313ce567": `0x${w(18)}`,
  "0x18160ddd": `0x${w(10n ** 24n)}`,
  "0x95d89b41": abiString("TRENCHWIRE"),
  "0x06fdde03": abiString("Trenchwire"),
  "0xfb7f21eb": abiString(LOGO),
};

/** A Robinhood node and a dexvra server in one process. The CONTRACT always
 *  publishes the logo; `appLogo` is whether the APP serves it — the whole
 *  difference between the shipped bug and the fix. */
type ChainLogo = true | false | "revert"; // published · left blank · the call fails

async function stub(appLogo: boolean, chainLogo: ChainLogo = true) {
  const rpc = (req: { id?: number; method?: string; params?: { data?: string }[] }) => {
    if (req.method === "eth_chainId") return { jsonrpc: "2.0", id: req.id, result: "0x1237" };
    if (req.method === "eth_blockNumber") return { jsonrpc: "2.0", id: req.id, result: "0x1" };
    if (req.method === "eth_getCode") return { jsonrpc: "2.0", id: req.id, result: "0x6001" };
    const sel = String(req.params?.[0]?.data ?? "").slice(0, 10);
    if (sel === "0xfb7f21eb" && chainLogo === "revert") {
      return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "execution reverted" } };
    }
    const hit = sel === "0xfb7f21eb" && chainLogo === false ? abiString("") : ANSWER[sel];
    return hit
      ? { jsonrpc: "2.0", id: req.id, result: hit }
      : { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "stub: no answer" } };
  };

  const server = http.createServer((req, res) => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        send(200, Array.isArray(parsed) ? parsed.map(rpc) : rpc(parsed));
      });
      return;
    }
    const path = (req.url ?? "").split("?")[0];
    if (path === "/api/pons/launches") return send(200, { items: [{ address: TOKEN }] });
    if (path === "/api/pons") {
      return send(200, {
        launch: {
          address: TOKEN,
          name: "Trenchwire",
          symbol: "TRENCHWIRE",
          logo: appLogo ? LOGO : null,
          socials: { twitter: "https://x.com/Trenchwire_", telegram: null, website: null },
        },
      });
    }
    if (path === "/api/tokens") return send(200, { build: "stub" });
    return send(404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function run(appLogo: boolean, chainLogo: ChainLogo = true): Promise<string> {
  const s = await stub(appLogo, chainLogo);
  try {
    return await new Promise<string>((resolve) => {
      execFile(
        process.execPath,
        [SCRIPT],
        // ⚠️ The check reads a repo .env of its own; a real PONS_RPC_URL in it
        // would send this test at the live chain. Both are pinned here.
        { env: { ...process.env, PONS_RPC_URL: s.origin, SITE_ORIGIN: s.origin }, timeout: 60_000 },
        (_err, stdout) => resolve(String(stdout)),
      );
    });
  } finally {
    s.close();
  }
}

// The stripe of the run that matters. The exit code cannot carry this
// assertion: section 7 reaches GeckoTerminal, which is unreachable from a
// sandbox, so the code is 1 whatever section 6 found.
const section6 = (out: string) => out.slice(out.indexOf("6 · The listing autofill")).split("7 · ")[0];

test("the check goes RED when the app drops a logo the chain published", async () => {
  const out = section6(await run(false));
  assert.match(out, /drops 1 field\(s\) the chain published/);
  assert.match(out, /logo — the contract publishes ipfs:\/\//);
});

test("…and GREEN when the app serves it, naming what the form would fill", async () => {
  const out = section6(await run(true));
  assert.doesNotMatch(out, /drops \d+ field/);
  assert.match(out, /the form would autofill: symbol · name · logo · twitter/);
});

// ⚠️ "The creator filled nothing in" and "the app dropped it" are DIFFERENT
// FACTS, and only the second is a defect. A check that reddened on the first
// would be permanently red on any pad where most creators skip the artwork —
// the state `chart:preview` sat in for weeks, which trains the reader to
// ignore the red. The contract publishes no logo here, so this is the only
// fixture that reaches that branch: without it the rule is untested and a
// mutation run says so.
test("a token whose creator set no logo is not a red mark", async () => {
  const out = section6(await run(false, false));
  assert.doesNotMatch(out, /drops \d+ field/);
  assert.match(out, /the form would autofill: symbol · name · twitter/);
});

// ⚠️ ONE FAULT, ONE ALERT. A `logo()` that reverts is already a red mark in
// section 4 — the CONTRACT read failed. Reporting it again here as "the app
// serves nothing" would send the operator to the app over a chain problem,
// which is this file's whole subject pointing the other way.
test("a contract read that failed is not blamed on the app", async () => {
  const out = await run(false, "revert");
  assert.match(out, /token\.logo\(\) → /); // section 4 says so
  assert.doesNotMatch(section6(out), /drops \d+ field/);
});
