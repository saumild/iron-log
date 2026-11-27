/* Iron Log service worker — makes the app open offline.
   The page itself: network first (so every online launch gets the newest version), cached copy when offline.
   Icons, manifest, fonts: cache first. Account data (Supabase) and AI calls are never cached.
   __VERSION__ is replaced at build time with a hash of index.html. */
const VERSION = '__VERSION__';
const CACHE = 'ironlog-' + VERSION;
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('ironlog-') && k !== CACHE && k !== 'ironlog-fonts').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // the app page: network first (4 s), else the cached copy
  if (req.mode === 'navigate' && url.origin === location.origin) {
    e.respondWith((async () => {
      try {
        const res = await Promise.race([fetch(req), timeout(4000)]);
        if (res && res.ok) { const c = await caches.open(CACHE); c.put('./index.html', res.clone()); }
        return res;
      } catch (err) {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }
  // same-origin static files: cache first
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    })));
    return;
  }
  // web fonts: cache first, kept across versions
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open('ironlog-fonts').then(c => c.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }))));
  }
  // everything else (Supabase, AI providers): straight to the network, never cached
});
