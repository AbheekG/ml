const CACHE_PREFIX = "music-library-shell";
const BUILD_ID = "development"; // INJECT_BUILD_ID
const PRECACHE_URLS = ["/"]; // INJECT_PRECACHE_URLS
const CACHE_VERSION = `${CACHE_PREFIX}-${BUILD_ID}`;
const NAVIGATION_TIMEOUT_MS = 8_000;
const TRANSIENT_NAVIGATION_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const OFFLINE_READINESS_REQUEST = "music-library-offline-readiness";
const OFFLINE_READINESS_RESPONSE = "music-library-offline-readiness-result";

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

self.addEventListener("message", (event) => {
  if (event.data?.type !== OFFLINE_READINESS_REQUEST) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const shell = await cache.match("/app-shell") ?? await cache.match("/");
    event.ports[0]?.postMessage({
      type: OFFLINE_READINESS_RESPONSE,
      ready: Boolean(shell),
      buildId: BUILD_ID,
    });
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
      const cachedShell = async () => (
        (await cache.match("/app-shell")) ?? (await cache.match("/")) ?? null
      );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
      try {
        const response = await fetch(request, { signal: controller.signal });
        if (isCacheableAppResponse(response)) await cache.put("/app-shell", response.clone());
        if (TRANSIENT_NAVIGATION_STATUSES.has(response.status)) {
          return (await cachedShell()) ?? response;
        }
        return response;
      } catch {
        return (await cachedShell()) ?? Response.error();
      } finally {
        clearTimeout(timeout);
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
