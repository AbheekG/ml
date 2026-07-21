import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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
});
