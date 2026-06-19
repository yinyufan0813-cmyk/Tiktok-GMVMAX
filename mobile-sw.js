const CACHE_NAME = "gmvmax-mobile-v2";
const STATIC_FILES = ["/", "/mobile.html", "/mobile.webmanifest"];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_FILES)).catch(() => undefined)
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  if (event.request.url.includes("/api/latest")) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(
        JSON.stringify({ error: "GMV Max mobile data service is temporarily unavailable." }),
        {
          status: 503,
          headers: { "content-type": "application/json; charset=utf-8" }
        }
      ))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => undefined);
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        return new Response("GMV Max mobile panel is offline. Please refresh after the Mac service is running.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      })
  );
});
