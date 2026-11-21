// Offline shell; schedule/history are network-first. The MTA feed (cross-origin) is never cached.
const CACHE = "gcm-track-v2";
const SHELL = ["./", "index.html", "style.css", "app.js", "gtfsrt.js", "manifest.webmanifest", "icon-180.png", "icon-512.png", "data/schedule.json", "data/history.json"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
