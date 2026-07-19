// Server-only banner-ad booking store (node:fs). The Telegram bot sells Banner
// Ad packages, takes payment, and books a slot here via the internal API; the
// homepage carousel + /advertise read active bookings via /api/banners.
// Persisted as data/banners.json (gitignored, survives restarts). Mirrors the
// listings store's atomic-write + serialized-mutation pattern.
import { promises as fs } from "node:fs";
import path from "node:path";

export interface BannerBooking {
  id: string;
  slot: string; // "Standard Banner" | "Wide Banner"
  size: string; // "728 × 90" etc.
  imageUrl: string; // /api/media/<name> or full https URL
  linkUrl: string; // click-through
  title?: string; // project / token name
  chain?: string;
  address?: string;
  startsAt: number; // ms epoch
  endsAt: number; // ms epoch
  createdAt: number;
  source?: "bot" | "admin";
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "banners.json");
const MAX = 200; // hard cap; oldest ended bookings evicted past it

let cache: BannerBooking[] | null = null;
let writeChain: Promise<void> = Promise.resolve();
let tmpSeq = 0;

async function load(): Promise<BannerBooking[]> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8"));
    cache = Array.isArray(parsed) ? (parsed as BannerBooking[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(rows: BannerBooking[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.${tmpSeq++}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8");
  await fs.rename(tmp, FILE);
  cache = rows;
}

function mutate(fn: (rows: BannerBooking[]) => BannerBooking[]): Promise<BannerBooking[]> {
  const run = writeChain.then(async () => {
    const rows = await load();
    const next = fn(rows.map((r) => ({ ...r })));
    await persist(next);
    return next;
  });
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

export async function allBanners(): Promise<BannerBooking[]> {
  return [...(await load())];
}

/** Bookings whose window covers `now`, newest first. */
export async function activeBanners(now = Date.now()): Promise<BannerBooking[]> {
  return (await load())
    .filter((b) => b.startsAt <= now && b.endsAt > now)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function addBanner(
  rec: Omit<BannerBooking, "id" | "createdAt">,
): Promise<BannerBooking> {
  const created: BannerBooking = {
    ...rec,
    id: `b_${Math.abs(hashId(`${rec.imageUrl}:${rec.startsAt}:${rec.linkUrl}`)).toString(36)}`,
    createdAt: Date.now(),
  };
  await mutate((rows) => {
    const next = [created, ...rows.filter((r) => r.id !== created.id)];
    if (next.length > MAX) {
      // evict the oldest already-ended bookings first
      const now = Date.now();
      const keep = next.filter((r) => r.endsAt > now);
      const ended = next.filter((r) => r.endsAt <= now).sort((a, b) => b.endsAt - a.endsAt);
      return [...keep, ...ended].slice(0, MAX);
    }
    return next;
  });
  return created;
}

/** Remove a booking (admin panel). Returns true when something was deleted. */
export async function removeBanner(id: string): Promise<boolean> {
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
