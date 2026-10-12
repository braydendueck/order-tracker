// App shell only. Order data comes from api.github.com (cross-origin) and is never cached here;
// the app keeps its own offline copy in localStorage.
const CACHE = 'ordertracker-v4';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== LOGOS).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
const LOGOS = 'ordertracker-logos';
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // retailer logos (favicons): cache-first, they rarely change. Product photos are left to the browser's HTTP cache.
  if (e.request.method === 'GET' && u.hostname === 'www.google.com' && u.pathname === '/s2/favicons') {
    e.respondWith(caches.open(LOGOS).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }))));
    return;
  }
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
