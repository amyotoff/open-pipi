/**
 * App shell caching only.
 *
 * Deliberately not an offline message store: showing a stale conversation as if
 * it were current is worse than saying the network is gone. Requests to /api
 * always go to the network and fail honestly when it is unavailable.
 *
 * The shell is fetched network-first and cached as it goes. Serving the cache
 * first would be faster by a few milliseconds on a LAN and would hand everyone
 * a stale client after every deploy — the wrong trade for a tool you run on
 * your own machine. The cache is there for when the server is not.
 */

const SHELL_CACHE = 'pipi-shell-v1';
const SHELL_FILES = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((names) => Promise.all(names.filter((name) => name !== SHELL_CACHE).map((name) => caches.delete(name))))
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET') return;
    // Conversations are never served from cache.
    if (url.pathname.startsWith('/api/')) return;

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    void caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
                }
                return response;
            })
            .catch(() => caches.match(event.request).then((cached) => cached || Response.error()))
    );
});
