// Client for the dexvra web app's token-guarded internal API (/api/internal/*).
// The web process is the sole writer of data/listings.json — the bot only ever
// mutates the store through these calls. Uses global fetch/FormData/Blob (Node 18+).
const { DEXVRA_API_BASE, INTERNAL_API_TOKEN } = require("../config/constants");
const log = require("../helpers/logger");

const TIMEOUT_MS = 15000;

function authHeaders(extra) {
  return { authorization: `Bearer ${INTERNAL_API_TOKEN}`, ...extra };
}

async function call(method, path, body) {
  if (!INTERNAL_API_TOKEN) throw new Error("INTERNAL_API_TOKEN is not set — bot cannot write listings");
  const url = `${DEXVRA_API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: authHeaders(body != null ? { "content-type": "application/json" } : {}),
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = (json && json.error) || text || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return json;
}

// ── Listings ─────────────────────────────────────────────────────────────────
/** Create an APPROVED listing (a paid order that cleared payment). Returns the
 *  StoredListing (with .id). `input` is a ListingInput (see adminValidate.ts). */
async function createListing(input) {
  const out = await call("POST", "/api/internal/listings", input);
  return out?.listing || null;
}

async function updateListing(id, patch) {
  const out = await call("PATCH", `/api/internal/listings/${encodeURIComponent(id)}`, patch);
  return out?.listing || null;
}

/** Every stored listing (bot reads for pump/trending). */
async function getListings() {
  const out = await call("GET", "/api/internal/listings");
  return (out && out.listings) || [];
}

/** Find the stored listing for a chain+address (case-insensitive), or null. */
async function findListing(chain, address) {
  const addr = String(address || "").toLowerCase();
  const all = await getListings();
  return all.find((r) => r.chain === chain && String(r.address).toLowerCase() === addr) || null;
}

// ── Trending ─────────────────────────────────────────────────────────────────
async function bookTrending(chain, address, durationHours) {
  const out = await call("POST", "/api/internal/trending", { chain, address, durationHours });
  return out?.listing || null;
}

/** Clear ended slots in the store. Returns count cleared. */
async function expireTrending() {
  const out = await call("POST", "/api/internal/trending/expire", {});
  return (out && out.cleared) || 0;
}

// ── Banners ──────────────────────────────────────────────────────────────────
async function bookBanner(rec) {
  const out = await call("POST", "/api/internal/banners", rec);
  return out?.banner || null;
}

// ── Upload (multipart) ───────────────────────────────────────────────────────
/** Upload an image buffer; returns a "/api/media/<name>" URL. */
async function uploadImage(buffer, filename = "logo.png", mime = "image/png") {
  if (!INTERNAL_API_TOKEN) throw new Error("INTERNAL_API_TOKEN is not set");
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), filename);
  const res = await fetch(`${DEXVRA_API_BASE}/api/internal/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`upload → ${res.status}: ${(json && json.error) || "failed"}`);
  return json && json.url ? `${DEXVRA_API_BASE}${json.url}` : null;
}

/** Best-effort health check of the internal API + token. */
async function ping() {
  try {
    await getListings();
    return true;
  } catch (e) {
    log.warn(`[api] internal API not reachable: ${e.message}`);
    return false;
  }
}

module.exports = {
  createListing,
  updateListing,
  getListings,
  findListing,
  bookTrending,
  expireTrending,
  bookBanner,
  uploadImage,
  ping,
};
