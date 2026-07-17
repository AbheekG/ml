import { describe, expect, it } from "vitest";
import {
  preserveSessionResolutionDuringRevalidation,
  subscribeToBrowserConnectivity,
  type BrowserConnectivityTarget,
} from "./app-lifecycle";

function connectivityTarget(): BrowserConnectivityTarget & { dispatch: (type: "online" | "offline" | "pageshow") => void } {
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
});
