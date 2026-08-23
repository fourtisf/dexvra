// The one write the background logo sweep may make to the public listing store.
//
// Driven for real rather than scanned: "never overwrites" is a MUTATION rule,
// and a source scan cannot tell a guard from a comment about one.
import test from "node:test";
import assert from "node:assert/strict";
import { applyResolvedLogo, type LogoRow } from "./logoWrite.ts";

const SHIB = "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce";
const rows = (): LogoRow[] => [
  { chain: "ethereum", address: SHIB },
  { chain: "ethereum", address: "0x1111111111111111111111111111111111111111", logoUrl: "https://img.example/theirs.png" },
  { chain: "base", address: SHIB },
];
const OURS = "https://img.example/ours.png";

test("a resolved logo fills a row that had none", () => {
  const out = applyResolvedLogo(rows(), "ethereum", SHIB, OURS);
  assert.equal(out.wrote, true);
  assert.equal(out.rows[0].logoUrl, OURS);
});

test("⚠️ it NEVER overwrites a logo somebody chose", () => {
  // An admin-set logo and a project's own upload are decisions; a resolved one
  // is the site filling a blank. That asymmetry is what makes this safe to call
  // from a background sweep nobody is watching.
  const out = applyResolvedLogo(rows(), "ethereum", "0x1111111111111111111111111111111111111111", OURS);
  assert.equal(out.wrote, false);
  assert.equal(out.rows[1].logoUrl, "https://img.example/theirs.png");
});

test("the address matches case-insensitively, the chain exactly", () => {
  // A checksummed address from a market provider and a lowercased one in the
  // store are the same token; the same address on two chains is two tokens.
  const upper = applyResolvedLogo(rows(), "ethereum", SHIB.toUpperCase(), OURS);
  assert.equal(upper.wrote, true);
  assert.equal(upper.rows[0].logoUrl, OURS);
  assert.equal(upper.rows[2].logoUrl, undefined, "the base row with the same address is untouched");

  const onBase = applyResolvedLogo(rows(), "base", SHIB, OURS);
  assert.equal(onBase.rows[0].logoUrl, undefined);
  assert.equal(onBase.rows[2].logoUrl, OURS);
});

test("only one row is written, even if the store somehow holds a duplicate", () => {
  const dupes: LogoRow[] = [
    { chain: "ethereum", address: SHIB },
    { chain: "ethereum", address: SHIB },
  ];
  const out = applyResolvedLogo(dupes, "ethereum", SHIB, OURS);
  assert.equal(out.rows.filter((r) => r.logoUrl).length, 1);
});

test("a url that is not an https image url is refused", () => {
  // The value lands on a public board and in the bot's channel posts.
  for (const bad of ["", "   ", "javascript:alert(1)", "http://img.example/x.png", "/api/media/x.png", "https://a b/c.png"]) {
    const out = applyResolvedLogo(rows(), "ethereum", SHIB, bad);
    assert.equal(out.wrote, false, `refused: ${bad || "(blank)"}`);
  }
});

test("a token that is not listed changes nothing at all", () => {
  const before = rows();
  const out = applyResolvedLogo(before, "ethereum", "0x9999999999999999999999999999999999999999", OURS);
  assert.equal(out.wrote, false);
  assert.equal(out.rows, before, "the same array back — nothing to persist");
});
