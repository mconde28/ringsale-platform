/* RingSale POS platform service worker — precaches the app shell for offline use.
   Same-origin GETs only. Cross-origin requests (Supabase API, CDN libraries)
   ALWAYS go straight to the network and are NEVER cached. */
const CACHE = 'ringsale-app-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/js/config.js',
  '/js/supabase.js',
  '/js/auth.js',
  '/js/register.js',
  '/js/app.js',
  '/icons/icon-512.png',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // NEVER cache cross-origin traffic: Supabase API and the supabase-js CDN
  // (and anything else off-origin) always go to the network.
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        // Cache only successful same-origin responses; never cache opaque/error responses.
        if (!res || res.status !== 200) return res;
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return res;
      }).catch(function () {
        // Offline fallback: navigations get the app shell.
        if (e.request.mode === 'navigate') return caches.match('/index.html');
        return caches.match('/index.html');
      });
    })
  );
});
