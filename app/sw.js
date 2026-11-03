/* RowSkan service worker: the app opens even with no internet. Never touches sync or sign-in requests. */
const CACHE = 'rowskan-app-v6';
const SHELL = ['./', 'index.html', 'app.js', 'net.js', 'store.js', 'sync.js', 'fsrelay.js', 'qr.js', 'code39.js', 'vinlocal.js', 'config.js', 'icon.svg', 'icon-192.png', 'manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => { // open instantly from the saved copy, refresh it in the background (next visit gets the newest)
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const net = fetch(e.request, { cache: 'no-cache' }).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; });
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((m) => { if (m) { net.catch(() => { }); return m; } return net.catch(() => caches.match('./')); }));
});
