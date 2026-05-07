/* =============================================================
 * sw.js — service worker for offline use
 *
 * Strategy:
 *   - On install: precache the full app shell + libraries + model
 *   - On fetch:   "cache first, network fallback"
 *                 (so offline use is instant & predictable)
 *   - On activate: drop old caches
 *
 * BUMP CACHE_VERSION whenever you change the app shell or libs,
 * otherwise users will keep seeing the old version until the cache
 * happens to evict.
 * ============================================================= */

const CACHE_VERSION = 'v2';
const CACHE_NAME = `damage-inspector-${CACHE_VERSION}`;

// Files we want guaranteed available offline. Paths are relative to
// the SW location (which is the site root for GitHub Pages).
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './storage.js',
  './image-compress.js',
  './manifest.webmanifest',

  // local libraries (committed in /vendor)
  './vendor/three/build/three.module.js',
  './vendor/three/examples/jsm/loaders/GLTFLoader.js',
  './vendor/three/examples/jsm/controls/OrbitControls.js',
  './vendor/three/examples/jsm/utils/BufferGeometryUtils.js',
  './vendor/jszip/jszip.esm.js',

  // default model (best-effort — if neither exists, the precache step
  // for those URLs will fail silently because we use addAll(filtered))
  './model.glb',
  './model.gltf',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll is atomic — one missing URL fails the whole install. So we
    // add files individually and just log failures, so a missing model
    // doesn't break the worker.
    for (const url of PRECACHE_URLS) {
      try {
        await cache.add(url);
      } catch (err) {
        console.warn('[sw] precache miss:', url, err.message);
      }
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('damage-inspector-') && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  // Only handle GET. Things like ZIP downloads are blob: URLs and
  // never touch the SW; this is just a safety check.
  if (event.request.method !== 'GET') return;

  // Only cache same-origin requests + our pinned CDN libs (we don't
  // have any pinned CDN libs anymore, but kept simple for clarity).
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request, { ignoreSearch: false });
    if (cached) {
      // Update in the background (stale-while-revalidate) so the next
      // load gets fresh code, but the current one stays fast & offline.
      event.waitUntil(updateCache(cache, event.request));
      return cached;
    }
    try {
      const response = await fetch(event.request);
      // only cache successful basic responses
      if (response && response.ok && response.type === 'basic') {
        cache.put(event.request, response.clone());
      }
      return response;
    } catch (err) {
      // offline + nothing in cache: respond with a small JSON 503
      return new Response(
        JSON.stringify({ error: 'offline-and-uncached', url: event.request.url }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }
  })());
});

async function updateCache(cache, request) {
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      await cache.put(request, response);
    }
  } catch {
    // offline — that's fine, we already served from cache
  }
}

// Optional: allow the page to ask the SW to skip waiting on a new version
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
