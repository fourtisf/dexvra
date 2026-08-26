// IS THE FILE BEHIND AN UPLOADED LOGO STILL THERE?
//
// A listing's logo can be an UPLOAD — `/api/media/<24hex>.<ext>`, written to
// `data/uploads/` by the admin uploader or by the bot when a project sends
// their artwork on the listing form. That is the strongest kind of logo there
// is: somebody chose it, and `pickLogo` ranks it above every index.
//
// ⚠️ AND IT IS THE ONLY KIND THAT CAN VANISH WITHOUT ANYTHING SAYING SO.
// `data/listings.json` is mirrored to Mongo and restored from it on a fresh
// container ("File missing/corrupt (e.g. fresh container after a VPS reset) →
// restore from the durable Mongo mirror" — store.ts). `data/uploads/` is NOT
// mirrored. So a box that loses its disk comes back with every listing intact,
// every one of them still asserting `/api/media/<hex>.png`, and not one of
// those files on disk. The row draws a monogram for ever after:
//
//   · `pickLogo` answers `kind: "stored"`, so the board never queues it for the
//     resolver — the queue is `"convention" || "none"`;
//   · `applyResolvedLogo` refuses to write over a row that already has a
//     `logoUrl`, so even a logo resolved in memory could never be persisted.
//
// Two guards, each correct on its own, holding a dead URL in place between
// them. This module is what breaks that: a stored upload whose file is gone is
// not a stored logo, and the row goes back through the ladder.
//
// ⚠️ "THE DIRECTORY COULD NOT BE READ" IS NOT "THE FILES ARE GONE". An
// unmounted volume, a permissions change or a container mid-restore all answer
// the same way, and reading that as "every uploaded logo has been deleted"
// would wipe the artwork off every paid listing on the site in one sweep —
// a failure rendered as a fact, which is the shape this repo keeps paying for.
// When the directory cannot be listed, NOTHING is reported missing.
//
// PURE + an injected reader, so the rule above is driven by a test rather than
// described in a comment.

/** `/api/media/<24hex>.<ext>` → the file name, or null for anything else (an
 *  external https logo, a data: URI, a blank). Deliberately the same shape the
 *  media route serves and `adminValidate`'s LOGO_RE accepts. */
export function mediaName(url: unknown): string | null {
  const s = String(url ?? "").trim();
  const m = /^\/api\/media\/([a-f0-9]{24}\.(?:png|jpe?g|gif|webp))$/i.exec(s);
  return m ? m[1].toLowerCase() : null;
}

export interface UploadsReader {
  /** Names in the uploads directory. THROWS when it cannot be read — that is
   *  the distinction the whole module turns on, so it must not be swallowed
   *  into an empty list by the caller that supplies it. */
  list: () => Promise<string[]>;
}

/**
 * Which uploaded FILES a set of logo URLs points at that are no longer on disk.
 *
 * ⚠️ IT ANSWERS IN FILE NAMES, NOT IN URLS, and `isLostUpload` below is the
 * only way to ask about a row. The first cut returned the URLs — trimmed on the
 * way in — so the caller's `lost.has(row.logoUrl)` compared an untrimmed store
 * value against a trimmed key and quietly answered "not lost" for exactly the
 * rows this module exists to find. Two normalisers for one lookup key is the
 * shape this repo keeps paying for; `mediaName` is now the only one, and both
 * sides go through it.
 *
 * ONE directory listing, not one stat per row: the board reprices ~200 rows
 * every 60s, and 200 syscalls to answer a question about one directory is 199
 * more than it takes.
 */
export async function lostUploads(urls: readonly unknown[], reader: UploadsReader): Promise<Set<string>> {
  const wanted = new Set<string>();
  for (const u of urls) {
    const n = mediaName(u);
    if (n) wanted.add(n);
  }
  if (wanted.size === 0) return new Set();

  let present: Set<string>;
  try {
    present = new Set((await reader.list()).map((n) => n.toLowerCase()));
  } catch {
    // See the header: unreadable is not empty. Nothing is missing.
    return new Set();
  }

  const lost = new Set<string>();
  for (const name of wanted) if (!present.has(name)) lost.add(name);
  return lost;
}

/** Is THIS row's logo an upload whose file is gone? The one way to ask — see
 *  the warning on `lostUploads`. Anything that is not one of our own uploads is
 *  never lost: what an external host does is not knowable from this server. */
export function isLostUpload(lost: ReadonlySet<string>, url: unknown): boolean {
  if (lost.size === 0) return false;
  const n = mediaName(url);
  return n != null && lost.has(n);
}
