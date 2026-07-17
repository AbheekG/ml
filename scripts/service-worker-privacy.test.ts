import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("service worker privacy boundaries", () => {
  it("keeps API and Cloudflare Access control paths outside fetch handling", async () => {
    const source = await readFile("public/sw.js", "utf8");
    expect(source).toContain('url.pathname.startsWith("/api/")');
    expect(source).toContain('url.pathname.startsWith("/cdn-cgi/access/")');
  });
});
