/* Minimal service worker: cache-first for static assets, network-first with
 * cache fallback for pages and the tokens API — keeps the watchlist readable
 * offline with the last-seen data.
 *
 * IMPORTANT: never intercept Next.js build output (/_next/). Those files are
 * content-hashed and immutable; letting the SW cache them risks serving a
 * stale chunk after a redeploy → ChunkLoadError / blank "client-side
 * exception" page. We hand /_next/ straight to the network/browser cache. */
const CACHE = "app-cache-v2";
const PRECACHE = ["/manifest.webmanifest", "/icons/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // Never touch Next.js build chunks — let the browser fetch them directly.
  if (url.pathname.startsWith("/_next/")) return;

  const networkFirst = url.pathname.startsWith("/api/") || e.request.mode === "navigate";
  if (networkFirst) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/")))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
    )
  );
});
