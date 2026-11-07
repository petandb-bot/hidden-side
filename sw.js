const VERSION = 'hidden-side-v0.3.4';
const ASSETS = ['./', './index.html', './app.js?v=034', './style.css?v=034', './icon.svg', './icon-192.png', './icon-512.png', './manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('hidden-side-') && key !== VERSION).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const networkFirst = req.mode === 'navigate' || /\.(js|css)(\?|$)/i.test(new URL(req.url).pathname);
  if (networkFirst) {
    event.respondWith(fetch(req).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(VERSION).then(cache => cache.put(req, copy)).catch(() => {});
      }
      return response;
    }).catch(() => caches.match(req)));
  } else {
    event.respondWith(caches.match(req).then(cached => cached || fetch(req).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(VERSION).then(cache => cache.put(req, copy)).catch(() => {});
      }
      return response;
    })));
  }
});
