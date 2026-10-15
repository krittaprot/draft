// Tandem service worker: makes the app installable and keeps its shell (styles, fonts, icons) available offline.
// Documents, the API, MCP, sign-in and share links always go to the network; nothing private is cached.
const CACHE = 'tandem-shell-v1';
const SHELL = ['/offline.html', '/style.css', '/landing.css', '/tokens.css', '/app.js', '/pwa.js', '/manifest.webmanifest',
  '/fonts/Geist-Variable.woff2', '/fonts/GeistMono-Variable.woff2', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const STATIC = /^\/(fonts|icons|shots)\/|\.(css|js|webmanifest)$/;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // pages: always fresh from the server (sign-in state matters); a simple offline page when there is no network
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  // the app shell: serve from cache, refresh in the background
  if (STATIC.test(url.pathname) && !url.pathname.startsWith('/api/')) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
