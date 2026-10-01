const CACHE = 'isobar-shell-v1';
const SHELL = ['./', './style.css', './app.js'];

function shellName(url) {
  if (url.origin !== self.location.origin) return null;
  const scopePath = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scopePath)) return null;
  const relative = url.pathname.slice(scopePath.length);
  if (relative === '' || relative === 'index.html') return 'index.html';
  if (relative === 'style.css' || relative === 'app.js') return relative;
  return null;
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !shellName(new URL(event.request.url))) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch (error) {
      const hit = await cache.match(event.request, { ignoreSearch: true });
      if (hit) return hit;
      if (shellName(new URL(event.request.url)) === 'index.html') {
        const index = await cache.match(new URL('./', self.registration.scope), { ignoreSearch: true });
        if (index) return index;
      }
      throw error;
    }
  })());
});
