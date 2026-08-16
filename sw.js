/* Service worker.
 *
 * Two caches with different lifetimes:
 *
 *   - SHELL holds the HTML/CSS/JS, a few hundred KB. Its name carries the build
 *     id, which CI rewrites on every deploy, so a release changes this file's
 *     bytes, installs a new worker, and replaces the whole shell atomically.
 *     Without that, a deploy that touched only app.js would never reach anyone
 *     who had already installed the app.
 *
 *   - ENGINE holds the ~6 MB Tesseract runtime and training data, written by
 *     the page itself. Its name is bumped by hand and only when those files
 *     actually change, so a normal release never costs the user another 6 MB.
 */

// Replaced at deploy time with the commit sha. Left as-is during local
// development, where an unregister-and-reload is the normal way to refresh.
const BUILD = '__BUILD__';

const SHELL = 'vpc-shell-' + BUILD;
const ENGINE = 'vpc-engine-v2';

const SHELL_ASSETS = [
  'index.html',
  'styles.css',
  'app.js',
  'parser.js',
  'rate.json',
  'manifest.webmanifest',
  'vendor/tesseract/tesseract.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

// The big files the page downloads once and keeps. Matched by filename rather
// than by directory, so tesseract.min.js — which ships with app.js and has to
// update alongside it — stays part of the shell.
const ENGINE_FILES = new Set([
  'worker.min.js',
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'eng.traineddata.gz',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith('vpc-shell-') && k !== SHELL)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function isEngineAsset(url) {
  return ENGINE_FILES.has(url.pathname.split('/').pop());
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Exchange-rate lookups are always live; the app deals with failure itself.
  if (url.origin !== self.location.origin) return;

  // Navigations: serve the cached shell immediately, refresh it in the
  // background. Only the app's own entry point is answered this way — a deeper
  // path would render index.html with relative scripts that resolve wrongly.
  if (req.mode === 'navigate') {
    const scope = new URL(self.registration.scope).pathname;
    const isEntry = url.pathname === scope || url.pathname === scope + 'index.html';
    if (!isEntry) return;

    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const cached = await cache.match('index.html');
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) event.waitUntil(cache.put('index.html', res.clone()));
            return res;
          })
          .catch(() => null);
        return cached || (await network) || new Response(
          '<h1>Offline</h1><p>Open this once with a connection to finish setup.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html' } }
        );
      })
    );
    return;
  }

  const cacheName = isEngineAsset(url) ? ENGINE : SHELL;

  event.respondWith(
    caches.open(cacheName).then(async (cache) => {
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok && res.type === 'basic') event.waitUntil(cache.put(req, res.clone()));
        return res;
      } catch (err) {
        const fallback = await caches.match(req);
        if (fallback) return fallback;
        throw err;
      }
    })
  );
});
