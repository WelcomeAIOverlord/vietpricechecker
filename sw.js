/* Service worker.
 *
 * Two caches with different lifetimes:
 *   - SHELL is versioned and replaced on every deploy (a few hundred KB).
 *   - ENGINE holds the ~6 MB Tesseract runtime and traineddata, written by the
 *     page itself. It survives deploys so an update never costs the user
 *     another 6 MB download.
 */

const SHELL = 'vpc-shell-v1';
const ENGINE = 'vpc-engine-v1';

const SHELL_ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'parser.js',
  'rate.json',
  'manifest.webmanifest',
  'vendor/tesseract/tesseract.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

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
  return url.pathname.includes('/vendor/tesseract/') || url.pathname.includes('/vendor/tessdata/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Exchange-rate lookups are always live; the app deals with failure itself.
  if (url.origin !== self.location.origin) return;

  // Navigations: serve the cached shell immediately, refresh it in the background.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const cached = await cache.match('index.html');
        const network = fetch(req)
          .then((res) => { if (res && res.ok) cache.put('index.html', res.clone()); return res; })
          .catch(() => null);
        return cached || (await network) || new Response('Offline', { status: 503 });
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
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch (err) {
        const fallback = await caches.match(req);
        if (fallback) return fallback;
        throw err;
      }
    })
  );
});
