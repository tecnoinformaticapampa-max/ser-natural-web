// SerNatural Service Worker v2 — network-first para HTML
const CACHE    = 'sernatural-v2';
const PRECACHE = ['/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // No cachear llamadas al Worker API, Cloudinary o GitHub
  if (url.hostname.includes('workers.dev') ||
      url.hostname.includes('cloudinary.com') ||
      url.hostname.includes('api.github.com')) {
    return;
  }

  if (e.request.method !== 'GET') return;

  const isHTML = e.request.mode === 'navigate' ||
                 e.request.destination === 'document' ||
                 url.pathname === '/' ||
                 url.pathname.endsWith('.html');

  if (isHTML) {
    // Network-first: siempre intenta traer la version mas nueva.
    // Solo usa cache si el usuario esta sin conexion.
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request).then(cached => cached || caches.match('/index.html')))
    );
    return;
  }

  // Cache-first para el resto de assets estaticos (no HTML)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && e.request.url.startsWith(self.location.origin)) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
