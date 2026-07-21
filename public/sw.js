const CACHE_PREFIX = "music-library-shell";
const BUILD_ID = "development"; // INJECT_BUILD_ID
const PRECACHE_URLS = ["/"]; // INJECT_PRECACHE_URLS
const CACHE_VERSION = `${CACHE_PREFIX}-${BUILD_ID}`;

function isCacheableAppResponse(response) {
  if (!response.ok || response.redirected || response.type === "opaqueredirect" || !response.url) {
    return false;
  }
  const url = new URL(response.url);
  return url.origin === self.location.origin
    && !url.pathname.startsWith("/api/")
    && !url.pathname.startsWith("/cdn-cgi/access/");
}

async function precacheShell() {
  const cache = await caches.open(CACHE_VERSION);
  for (const url of PRECACHE_URLS) {
    const request = new Request(url, { credentials: "include", cache: "reload" });
    const response = await fetch(request);
    if (!isCacheableAppResponse(response)) {
      throw new Error(`Could not precache ${url}`);
    }
    await cache.put(url, response.clone());
    if (url === "/") await cache.put("/app-shell", response.clone());
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_VERSION)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin
    || url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/cdn-cgi/access/")
  ) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        const response = await fetch(request);
        if (isCacheableAppResponse(response)) await cache.put("/app-shell", response.clone());
        return response;
      } catch {
        return (await cache.match("/app-shell")) ?? (await cache.match("/")) ?? Response.error();
      }
    })());
    return;
  }

  if (["script", "style", "font", "image"].includes(request.destination)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      if (isCacheableAppResponse(response)) await cache.put(request, response.clone());
      return response;
    })());
  }
});
