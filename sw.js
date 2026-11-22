// Offline shell + push notifications. App files are revalidated on every load; the MTA feeds are never cached.
const CACHE = "gcm-track-v8";
const SHELL = ["./", "index.html", "style.css", "app.js", "gtfsrt.js", "alerts.js", "pro.js", "privacy.html", "manifest.webmanifest", "icon-180.png", "icon-512.png", "data/schedule.json", "data/history.json"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
self.addEventListener("push", e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: "GCM Track", body: e.data?.text() || "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "GCM Track", { body: d.body || "", tag: d.tag, icon: "icon-180.png", badge: "icon-180.png" }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => ws.length ? ws[0].focus() : clients.openWindow("./")));
});
