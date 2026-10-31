// Service worker: deja la app (HTML/JS/CSS) disponible sin señal.
// Los datos (patentes, movimientos) viven en IndexedDB, no acá.
// Al publicar una versión nueva, subí el número de CACHE.
const CACHE = 'garita-v31';
const ARCHIVOS = [
  './',
  'index.html',
  'vecino.html',
  'vecino.js',
  'vecino.css',
  'styles.css',
  'app.js',
  'db.js',
  'logic.js',
  'fonts/inter-latin-wght-normal.woff2',
  'fonts/ibm-plex-mono-latin-500-normal.woff2',
  'fonts/ibm-plex-mono-latin-600-normal.woff2',
  'fonts/ibm-plex-mono-latin-700-normal.woff2',
  'config.js',
  'vendor/supabase.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate para los archivos propios; la API de Supabase (otro origen) no se toca.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const guardado = await cache.match(req, { ignoreSearch: true });
      const red = fetch(req)
        .then((resp) => {
          if (resp.ok) cache.put(req, resp.clone());
          return resp;
        })
        .catch(() => null);
      if (guardado) {
        e.waitUntil(red);
        return guardado;
      }
      const resp = await red;
      return resp || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
    })
  );
});

// Notificaciones push: aviso al vecino cuando la garita registra la entrada de un auto a su casa.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* sin cuerpo */ }
  e.waitUntil(self.registration.showNotification(d.titulo || 'Garita Oasis', {
    body: d.cuerpo || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag,
    data: { url: d.url || 'vecino.html' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || 'vecino.html', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    const abierta = ws.find((w) => w.url.startsWith(self.location.origin + '/vecino'));
    return abierta ? abierta.navigate(url).then((w) => w?.focus()) : self.clients.openWindow(url);
  }));
});
