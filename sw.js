/* SmartSaver AI — service worker
 *
 * The point is the home-screen icon opening instantly and still working with no
 * signal: the goal and the deposits live in localStorage, so once the shell is
 * cached the app is genuinely usable offline.
 *
 * Bump CACHE when you change any shell file, or browsers will keep serving the
 * old one from the cache forever.
 */
const CACHE = 'smartsaver-v18';

const SHELL = [
  './',
  './index.html',
  './dashboard.html',
  './supabase/ss-supabase.js',
  './favicon.svg',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // one missing file must not fail the whole install, so they are added singly
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch Supabase or the Sheets endpoint

  // HTML: network first, so an edit to the site shows up on the next load and
  // the cache is only the fallback when the network is gone
  const wantsHtml = req.mode === 'navigate' ||
                    (req.headers.get('accept') || '').indexOf('text/html') !== -1;

  // The auth layer joins it. Cache-first left a stale ss-supabase.js paired with
  // a fresh index.html — the sign-in button was there, the function behind it was
  // not, and the click failed silently. Icons and the manifest can go stale; this
  // file cannot.
  const isAuthScript = url.pathname.indexOf('ss-supabase.js') !== -1;

  if (wantsHtml || isAuthScript) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // everything else: cache first, it is all static
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }))
  );
});
