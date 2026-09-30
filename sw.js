// LocalDrop service worker — offline app shell (bump VERSION to force an update).
const VERSION = 'localdrop-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'storage.js', 'clipboard.js', 'devices.js', 'pairing.js', 'signal.js', 'history.js', 'transfer.js', 'pwa.js',
  'assets/vendor/qrcode.min.js', 'assets/vendor/jsQR.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // stale-while-revalidate; navigations fall back to the cached shell when offline
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; })
      .catch(() => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined));
    return hit || net;
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('./index.html'))));
});
