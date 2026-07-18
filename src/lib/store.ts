// Server-only: uses node:fs. Never import from a client component (the dashboard
// uses `import type` only, which is erased at compile time).
import { promises as fs } from "node:fs";
import path from "node:path";
import { SEED_ROWS, type ListingRow } from "./listings";

// Server-side listing store — the admin panel's source of truth. Persisted as a
// JSON file on disk (writable on a VPS; survives restarts and `git pull` since
// data/ is gitignored). Seeded from SEED_ROWS on first run.

export type ListingStatus = "approved" | "pending" | "rejected";

export interface StoredListing extends ListingRow {
  id: string;
  status: ListingStatus;
  createdAt: number;
  source?: "seed" | "submission" | "admin";
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "listings.json");
// Cap the public-submission (pending) queue so a flood can't grow the store
// without bound. Oldest pending rows are evicted once the cap is hit.
const MAX_PENDING = 200;

let cache: StoredListing[] | null = null;
let writeChain: Promise<void> = Promise.resolve();
let tmpSeq = 0;
let createdSeq = 1; // monotonic stamp for FIFO ordering of new rows

function seed(): StoredListing[] {
  return SEED_ROWS.map((r, i) => ({
    ...r,
    id: `seed-${i}`,
    status: "approved" as ListingStatus,
    createdAt: 0,
    source: "seed" as const,
  }));
}

async function load(): Promise<StoredListing[]> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      cache = parsed as StoredListing[];
      return cache;
    }
    throw new Error("corrupt store");
  } catch {
    // Seed in memory only — the file is written on the first mutation. Reads
    // must never write (and never race the mutation write path).
    cache = seed();
    return cache;
  }
}

async function persist(rows: StoredListing[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.${tmpSeq++}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8");
  await fs.rename(tmp, FILE);
  cache = rows;
}

/** Serialize mutations so concurrent writes never clobber each other. */
function mutate(fn: (rows: StoredListing[]) => StoredListing[]): Promise<StoredListing[]> {
  const run = writeChain.then(async () => {
    const rows = await load();
    const next = fn(rows.map((r) => ({ ...r })));
    await persist(next);
    return next;
  });
  // keep the chain alive even if this mutation throws
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── Reads ───────────────────────────────────────────────────────────────
export async function allListings(): Promise<StoredListing[]> {
  return [...(await load())];
}

export async function approvedRows(): Promise<ListingRow[]> {
  return (await load()).filter((r) => r.status === "approved");
}

// ── Mutations ───────────────────────────────────────────────────────────
export async function addListing(rec: ListingRow, opts?: { status?: ListingStatus; source?: StoredListing["source"] }): Promise<StoredListing> {
  const id = `l_${Math.abs(hashId(`${rec.chain}:${rec.address}:${rec.sym}`)).toString(36)}`;
  let created!: StoredListing;
  await mutate((rows) => {
    const dupIdx = rows.findIndex(
      (r) => r.chain === rec.chain && r.address.toLowerCase() === rec.address.toLowerCase(),
    );
    created = {
      ...rec,
      id: dupIdx >= 0 ? rows[dupIdx].id : id,
      status: opts?.status ?? "pending",
      createdAt: dupIdx >= 0 ? rows[dupIdx].createdAt : createdSeq++,
      source: opts?.source ?? "submission",
    };
    if (dupIdx >= 0) {
      rows[dupIdx] = created;
      return rows;
    }
    const next = [created, ...rows];
    // Bound the pending queue: evict the oldest pending rows past the cap.
    if (created.status === "pending") {
      const pending = next.filter((r) => r.status === "pending");
      if (pending.length > MAX_PENDING) {
        const evict = new Set(
          pending
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(0, pending.length - MAX_PENDING)
            .map((r) => r.id),
        );
        return next.filter((r) => !evict.has(r.id));
      }
    }
    return next;
  });
  return created;
}

export async function updateListing(id: string, patch: Partial<ListingRow>): Promise<StoredListing | null> {
  let found: StoredListing | null = null;
  await mutate((rows) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i >= 0) {
      // Never allow id/status to be overwritten through the field patch path.
      const { ...safe } = patch;
      rows[i] = { ...rows[i], ...safe, id: rows[i].id, status: rows[i].status };
      found = rows[i];
    }
    return rows;
  });
  return found;
}

export async function setStatus(id: string, status: ListingStatus): Promise<StoredListing | null> {
  let found: StoredListing | null = null;
  await mutate((rows) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i >= 0) {
      rows[i] = { ...rows[i], status };
      found = rows[i];
    }
    return rows;
  });
  return found;
}

export async function deleteListing(id: string): Promise<boolean> {
  let removed = false;
  await mutate((rows) => {
    const next = rows.filter((r) => r.id !== id);
    removed = next.length !== rows.length;
    return next;
  });
  return removed;
}

function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
