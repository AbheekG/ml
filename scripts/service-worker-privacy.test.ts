import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type ServiceWorkerListener = (event: {
  data?: unknown;
  ports: Array<{ postMessage: (message: unknown) => void }>;
  request?: { method: string; url: string; mode: string; destination: string };
  respondWith?: (response: Promise<Response>) => void;
  waitUntil: (work: Promise<unknown>) => void;
}) => void;

async function serviceWorkerHarness(options: {
  fetcher?: typeof fetch;
  cachedShell?: Response;
} = {}) {
  const source = await readFile("public/sw.js", "utf8");
  const listeners = new Map<string, ServiceWorkerListener>();
  const cache = {
    match: vi.fn(async (key: string) => (
      (key === "/app-shell" || key === "/") ? options.cachedShell : undefined
    )),
    put: vi.fn(async () => undefined),
  };
  runInNewContext(source, {
    self: {
      location: { origin: "https://music.invalid" },
      addEventListener(type: string, listener: ServiceWorkerListener) {
        listeners.set(type, listener);
      },
    },
    caches: {
      open: vi.fn(async () => cache),
      keys: vi.fn(async () => []),
      delete: vi.fn(async () => true),
    },
    fetch: options.fetcher ?? vi.fn(async () => new Response(null, { status: 204 })),
    AbortController,
    Headers,
    Request,
    Response,
    URL,
    clearTimeout,
    setTimeout,
  });
  return { cache, listeners };
}

describe("service worker privacy boundaries", () => {
  it("keeps API and Cloudflare Access control paths outside fetch handling", async () => {
    const source = await readFile("public/sw.js", "utf8");
    expect(source).toContain('url.pathname.startsWith("/api/")');
    expect(source).toContain('url.pathname.startsWith("/cdn-cgi/access/")');
  });

  it("never admits redirects, cross-origin responses, or Access pages to runtime caches", async () => {
    const source = await readFile("public/sw.js", "utf8");
    expect(source).toContain("response.redirected");
    expect(source).toContain('response.type === "opaqueredirect"');
    expect(source).toContain("url.origin === self.location.origin");
    expect(source.match(/isCacheableAppResponse\(response\)/gu)).toHaveLength(4);
  });

  it("uses the cached shell for a transient navigation response", async () => {
    const { listeners } = await serviceWorkerHarness({
      cachedShell: new Response("cached shell"),
      fetcher: vi.fn(async () => new Response("temporarily unavailable", { status: 503 })),
    });
    let handled: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      ports: [],
      request: {
        method: "GET",
        url: "https://music.invalid/songs",
        mode: "navigate",
        destination: "document",
      },
      respondWith(response) { handled = response; },
      waitUntil() {},
    });

    const response = await handled;
    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe("cached shell");
  });

  it("does not hide an authentication response behind the cached shell", async () => {
    const { listeners } = await serviceWorkerHarness({
      cachedShell: new Response("cached shell"),
      fetcher: vi.fn(async () => new Response("sign in", { status: 401 })),
    });
    let handled: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      ports: [],
      request: {
        method: "GET",
        url: "https://music.invalid/songs",
        mode: "navigate",
        destination: "document",
      },
      respondWith(response) { handled = response; },
      waitUntil() {},
    });

    const response = await handled;
    expect(response?.status).toBe(401);
    await expect(response?.text()).resolves.toBe("sign in");
  });

  it("reports readiness only when the current build has a cached shell", async () => {
    const { listeners } = await serviceWorkerHarness({ cachedShell: new Response("cached shell") });
    const postMessage = vi.fn();
    let work: Promise<unknown> | undefined;
    listeners.get("message")?.({
      data: { type: "music-library-offline-readiness" },
      ports: [{ postMessage }],
      waitUntil(promise) { work = promise; },
    });
    await work;
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "music-library-offline-readiness-result",
      ready: true,
    }));
  });
});
