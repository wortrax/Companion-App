// Tiny service worker: lets the app open instantly and offline once it has been loaded once.
// Model weights are cached separately by the AI engine itself.
const SHELL = "companion-shell-v1";
const LIB = "companion-lib-v1";
const FILES = ["./", "index.html", "style.css", "app.js", "characters.js", "manifest.webmanifest", "icon-180.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== SHELL && k !== LIB && k.startsWith("companion-")).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // app files: network first (so updates arrive), cache as fallback (so it works offline)
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return r;
    }).catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
  } else if (url.hostname === "esm.run" || url.hostname === "cdn.jsdelivr.net") {
    // the AI engine library: cache first
    e.respondWith(caches.open(LIB).then(c => c.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok) c.put(req, r.clone());
      return r;
    }))));
  }
});
