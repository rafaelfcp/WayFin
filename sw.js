/* Wayfin service worker
 * - Navegação (index.html): network-first, com fallback para o cache (abre offline).
 * - Assets do próprio domínio: stale-while-revalidate.
 * - Libs/fonts de CDN (Leaflet, supabase-js, Google Fonts): stale-while-revalidate,
 *   para o app conseguir abrir sem rede.
 * - Supabase, tiles, Nominatim, Overpass, Wikipedia: NÃO passam pelo SW (sempre rede).
 * Para forçar atualização do shell, incremente VERSION. */
const VERSION = 'wayfin-v9';
const SHELL = ['/', '/index.html', '/css/wayfin-v2.css?v=8', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
const CDN_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const net = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put('/index.html', copy));
        return res;
      }).catch(() => caches.match('/index.html').then(r => r || caches.match('/')))
    );
    return;
  }
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return;   // funções do Pages: sempre rede
    e.respondWith(staleWhileRevalidate(req));
    return;
  }
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req));
  }
});
