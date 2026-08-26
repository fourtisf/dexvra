import test from "node:test";
import assert from "node:assert/strict";
import { lostUploads, mediaName } from "./mediaFile.ts";

const A = "/api/media/aaaaaaaaaaaaaaaaaaaaaaaa.png";
const B = "/api/media/bbbbbbbbbbbbbbbbbbbbbbbb.webp";
const EXTERNAL = "https://dd.dexscreener.com/ds-data/tokens/solana/x.png";

const reader = (names: string[]) => ({ list: async () => names });
const broken = { list: async (): Promise<string[]> => { throw new Error("EACCES"); } };

test("mediaName reads our own upload shape and nothing else", () => {
  assert.equal(mediaName(A), "aaaaaaaaaaaaaaaaaaaaaaaa.png");
  assert.equal(mediaName(EXTERNAL), null);
  assert.equal(mediaName("data:image/png;base64,x"), null);
  assert.equal(mediaName(""), null);
  assert.equal(mediaName(null), null);
  // Traversal, a wrong length, an unknown extension — the media route would
  // 404 all three, so treating one as an upload we own would be a false claim.
  assert.equal(mediaName("/api/media/../../etc/passwd"), null);
  assert.equal(mediaName("/api/media/abc.png"), null);
  assert.equal(mediaName("/api/media/aaaaaaaaaaaaaaaaaaaaaaaa.svg"), null);
});

test("an upload whose file is gone is reported lost", async () => {
  const lost = await lostUploads([A, B], reader(["bbbbbbbbbbbbbbbbbbbbbbbb.webp"]));
  assert.deepEqual([...lost], [A]);
});

test("an upload that is still there is not", async () => {
  const lost = await lostUploads([A], reader(["aaaaaaaaaaaaaaaaaaaaaaaa.png"]));
  assert.equal(lost.size, 0);
});

test("an EXTERNAL logo is never reported lost", async () => {
  // Whether a CDN answers is not knowable from this server, and a bad minute
  // must never delete a project's artwork. Only our own disk is a local fact.
  const lost = await lostUploads([EXTERNAL, "ipfs://cid/logo.png", ""], reader([]));
  assert.equal(lost.size, 0);
});

test("⚠️ a directory that cannot be READ reports nothing missing", async () => {
  // An unmounted volume, a permissions change, a container mid-restore: all
  // answer identically, and reading that as "every uploaded logo was deleted"
  // would strip the artwork off every paid listing on the site in one sweep.
  const lost = await lostUploads([A, B], broken);
  assert.equal(lost.size, 0, "could not look is not everything is gone");
});

test("…but an EMPTY directory does report them, which is the case being healed", async () => {
  // A box restored from the Mongo mirror has every row and no uploads. That is
  // the state the whole module exists for, so it must not be confused with the
  // unreadable one above.
  const lost = await lostUploads([A, B], reader([]));
  assert.deepEqual([...lost].sort(), [A, B].sort());
});

test("it asks the directory ONCE, however many rows there are", async () => {
  let calls = 0;
  const counting = { list: async () => { calls++; return []; } };
  await lostUploads(Array.from({ length: 200 }, (_, i) => `/api/media/${String(i).padStart(24, "0").replace(/[^0-9]/g, "0")}.png`), counting);
  assert.equal(calls, 1, "one readdir, not one stat per row");
});

test("no upload in the list means no syscall at all", async () => {
  let calls = 0;
  const counting = { list: async () => { calls++; return []; } };
  const lost = await lostUploads([EXTERNAL, undefined, null], counting);
  assert.equal(calls, 0);
  assert.equal(lost.size, 0);
});

test("the returned value is the URL as given, so a caller can match its rows", async () => {
  const lost = await lostUploads([`  ${A}  `], reader([]));
  assert.deepEqual([...lost], [A], "trimmed, which is what the store would hold");
});
