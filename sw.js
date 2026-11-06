// Cache versioned assets for offline use after the first successful load.
const VERSION = 'hidden-side-v0.3.0';
const LOCAL = ['./', './index.html', './app.js', './style.css', './icon.svg', './icon-192.png', './icon-512.png', './manifest.webmanifest'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(LOCAL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok || response.type === 'opaque') {
      const copy = response.clone();
      caches.open(VERSION).then(cache => cache.put(event.request, copy)).catch(() => {});
    }
    return response;
  })));
});
