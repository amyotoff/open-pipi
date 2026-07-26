/**
 * App shell caching only.
 *
 * Deliberately not an offline message store: showing a stale conversation as if
 * it were current is worse than saying the network is gone. Requests to /api
 * always go to the network and fail honestly when it is unavailable.
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
        caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
});
