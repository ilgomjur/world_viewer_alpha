
const CACHE_NAME = 'fictional-world-map-v1';
// The core assets that will be pre-cached.
// Use relative paths to ensure it works when hosted in a subdirectory.
const urlsToCache = [
    '.',
    'index.html',
    'index.tsx',
    'manifest.json'
];

self.addEventListener('install', event => {
    // Perform install steps
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache and pre-caching core assets');
                // Use new Request objects to bypass the HTTP cache and fetch fresh files from the network.
                const requests = urlsToCache.map(url => new Request(url, {cache: 'reload'}));
                return cache.addAll(requests);
            })
    );
});

self.addEventListener('fetch', event => {
    // We only want to cache GET requests.
    if (event.request.method !== 'GET') {
        // For non-GET requests, just perform a network request.
        return;
    }

    event.respondWith(
        caches.open(CACHE_NAME).then(cache => {
            return cache.match(event.request).then(response => {
                // If the response is in the cache, return it immediately.
                if (response) {
                    return response;
                }

                // If the response is not in the cache, fetch it from the network.
                return fetch(event.request).then(networkResponse => {
                    // Check if we received a valid response.
                    // Opaque responses (from cross-origin requests like CDNs) are fine to cache.
                    if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
                         // We need to clone the response because it's a stream
                         // that can only be consumed once. We need one for the
                         // cache and one for the browser.
                         const responseToCache = networkResponse.clone();
                         cache.put(event.request, responseToCache);
                    }
                    
                    return networkResponse;
                });
            });
        })
    );
});


self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        // Delete old caches that are no longer needed.
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});