import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// $GG loaded on two deploys and failed on two with ZERO lines changed on the
// logo path. Three independent diagnostic lenses converged: pump.fun's own pin
// (pump.mypinata.cloud) was allowlisted but never in the gateway ladder, and
// IPFS_MAX_TRIES counted the caller's own url — so for a stored ipfs.io url
// only two fallbacks ever ran, and whether the artwork loaded depended on what
// a public gateway happened to have cached that minute.
const src = readFileSync(new URL("../app/api/logo/route.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

test("⚠️ pump.fun's own pin is in the DEFAULT gateway ladder", () => {
  assert.match(src, /"https:\/\/pump\.mypinata\.cloud\/ipfs\/"/);
  // …and early enough that a stored ipfs.io url still reaches it: the caller's
  // url is slot one, so the pin has to be within the first (MAX_TRIES - 1)
  // entries that differ from it.
  const list = src.slice(src.indexOf("IPFS_GATEWAYS"), src.indexOf("const IPFS_MAX_TRIES"));
  const order = [...list.matchAll(/"(https:\/\/[^"]+\/ipfs\/)"/g)].map((m) => m[1]);
  const idx = order.indexOf("https://pump.mypinata.cloud/ipfs/");
  assert.ok(idx >= 0 && idx <= 1, `the pin must be first or second in the ladder, found at ${idx}: ${order.join(", ")}`);
});

test("⚠️ the caller's own url no longer eats a fallback slot", () => {
  const m = /const IPFS_MAX_TRIES = (\d+);/.exec(src);
  assert.ok(m, "IPFS_MAX_TRIES must be declared");
  assert.ok(Number(m[1]) >= 4, `three real fallbacks behind the caller's url need MAX_TRIES ≥ 4, got ${m[1]}`);
});

test("the pin's host is allowlisted, or the ladder entry could never fire", () => {
  // A gateway in the list that the allowlist refuses is a fallback that cannot
  // fire — which reads exactly like one that never helps.
  assert.match(src, /"mypinata\.cloud"/);
});
