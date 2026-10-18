// Adds the two headers that make a page cross-origin isolated, which threads
// need (SharedArrayBuffer) and GitHub Pages cannot send. Once a response comes
// from here, what the server sent no longer decides what the page sees.
//
// Registered by coi.js. Only same-origin responses are touched. A
// cross-origin one passes through as it came, and under require-corp it loads
// only if it was fetched with CORS (crossorigin="anonymous") or carries its own
// Cross-Origin-Resource-Policy — stamping same-origin on it here would block it.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
    const r = e.request;
    // Chrome throws on these when they are not same-origin; leave them alone.
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
    if (new URL(r.url).origin !== self.location.origin) return;
    e.respondWith(fetch(r).then((res) => {
        if (res.status === 0) return res;   // opaque: headers cannot be read or set
        const headers = new Headers(res.headers);
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        headers.set('Cross-Origin-Resource-Policy', 'same-origin');
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }));
});
