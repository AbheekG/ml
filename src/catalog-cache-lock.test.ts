import { describe, expect, it, vi } from "vitest";
import { CATALOG_CACHE_LOCK_NAME, withCatalogCacheLock } from "./catalog-cache-lock";

describe("catalog cache serialization", () => {
  it("uses one origin-wide browser lock when available", async () => {
    const requestSpy = vi.fn();
    const lockManager = {
      async request<T>(name: string, callback: () => Promise<T>): Promise<T> {
        requestSpy(name, callback);
        return callback();
      },
    };
    await expect(withCatalogCacheLock(async () => "complete", lockManager)).resolves.toBe("complete");
    expect(requestSpy).toHaveBeenCalledWith(CATALOG_CACHE_LOCK_NAME, expect.any(Function));
  });

  it("serializes refreshes in browsers without Web Locks", async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withCatalogCacheLock(async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
    }, null);
    const second = withCatalogCacheLock(async () => {
      events.push("second-start");
      events.push("second-end");
    }, null);

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });
});
