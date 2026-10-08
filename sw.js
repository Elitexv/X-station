// X-Station service worker: lets the app open instantly and work offline.
// Bump VERSION whenever the app files change so phones download the new version.
const VERSION = 'x-station-v3';
const APP_SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'charts.js',
  'firebase.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];
// Firebase's own code (versioned, never changes) is cached the first time it is downloaded.
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page asks the new version to take over when the person presses "Update now".
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Firebase SDK files: cache first (the URL contains the version number).
  if (url.href.startsWith(FIREBASE_SDK)) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  // Everything else from other sites (Firestore, Auth, Analytics) goes straight to the network.
  if (url.origin !== self.location.origin) return;

  // Our own files: network first so updates arrive quickly, cached copy when offline.
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
