import { describe, expect, it } from "vitest";
import {
  preserveSessionResolutionDuringRevalidation,
  sessionFailureInvalidatesIdentity,
  shouldRefreshProtectedCatalog,
  subscribeToBrowserConnectivity,
  subscribeToSessionRevalidation,
  type BrowserConnectivityTarget,
  type BrowserRevalidationTarget,
} from "./app-lifecycle";

function connectivityTarget(): BrowserConnectivityTarget & BrowserRevalidationTarget & {
  dispatch: (type: "online" | "offline" | "pageshow" | "focus") => void;
} {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener(type, listener) {
      const registered = listeners.get(type) ?? new Set<EventListener>();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) ?? []) listener(new Event(type));
    },
  };
}

describe("application lifecycle connectivity", () => {
  it("publishes the browser-reported state on connectivity changes and page restore", () => {
    const target = connectivityTarget();
    let online = true;
    const statuses: boolean[] = [];
    const unsubscribe = subscribeToBrowserConnectivity(
      target,
      () => online,
      (status) => statuses.push(status),
    );

    online = false;
    target.dispatch("offline");
    online = true;
    target.dispatch("online");
    target.dispatch("pageshow");

    expect(statuses).toEqual([false, true, true]);
    unsubscribe();
  });

  it("stops publishing after cleanup", () => {
    const target = connectivityTarget();
    const statuses: boolean[] = [];
    const unsubscribe = subscribeToBrowserConnectivity(target, () => false, (status) => statuses.push(status));
    unsubscribe();
    target.dispatch("offline");

    expect(statuses).toEqual([]);
  });
});

describe("session revalidation lifecycle", () => {
  it("keeps an already resolved protected session mounted during revalidation", () => {
    expect(preserveSessionResolutionDuringRevalidation(true)).toBe(true);
  });

  it("keeps the initial unresolved state unresolved until the first check finishes", () => {
    expect(preserveSessionResolutionDuringRevalidation(false)).toBe(false);
  });

  it("revalidates when a restored page or focused app may have a changed session", () => {
    const target = connectivityTarget();
    let calls = 0;
    const unsubscribe = subscribeToSessionRevalidation(target, () => { calls += 1; });

    target.dispatch("pageshow");
    target.dispatch("focus");
    expect(calls).toBe(2);
    unsubscribe();
    target.dispatch("focus");
    expect(calls).toBe(2);
  });

  it("clears identity only for definitive authentication or authorization failures", () => {
    expect(sessionFailureInvalidatesIdentity({ status: 401 })).toBe(true);
    expect(sessionFailureInvalidatesIdentity({ status: 403 })).toBe(true);
    expect(sessionFailureInvalidatesIdentity({ status: 503 })).toBe(false);
    expect(sessionFailureInvalidatesIdentity(new TypeError("network"))).toBe(false);
  });

  it("refreshes protected catalog data only with connectivity and a validated session", () => {
    expect(shouldRefreshProtectedCatalog(true, true)).toBe(true);
    expect(shouldRefreshProtectedCatalog(true, false)).toBe(false);
    expect(shouldRefreshProtectedCatalog(false, true)).toBe(false);
    expect(shouldRefreshProtectedCatalog(false, false)).toBe(false);
  });
});
