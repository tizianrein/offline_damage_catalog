const CACHE_NAME = 'three-cube-cache-v1';

const FILES_TO_CACHE = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  'https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.module.js',
  'https://cdn.jsdelivr.net/npm/three@0.183.0/examples/jsm/controls/OrbitControls.js',
  'https://cdn.jsdelivr.net/npm/three@0.183.0/examples/jsm/webxr/VRButton.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const url of FILES_TO_CACHE) {
        try {
          await cache.add(url);
        } catch (error) {
          console.warn('Konnte nicht cachen:', url, error);
        }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request);
    })
  );
});