import { describe, expect, it, vi } from "vitest";
import {
  createLatestConnectivityChecker,
  preserveSessionResolutionDuringRevalidation,
  type ConnectivityProbe,
} from "./app-lifecycle";

type PendingProbe = {
  signal: AbortSignal;
  resolve: (isOnline: boolean) => void;
  reject: (error: Error) => void;
};

function controlledProbe(options: { rejectOnAbort?: boolean } = {}): {
  probe: ConnectivityProbe;
  pending: PendingProbe[];
} {
  const pending: PendingProbe[] = [];
  return {
    pending,
    probe: (signal) => new Promise<boolean>((resolve, reject) => {
      const item = { signal, resolve, reject };
      pending.push(item);
      if (options.rejectOnAbort !== false) {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }
    }),
  };
}

describe("application lifecycle connectivity", () => {
  it("lets only the latest clustered resume check publish status", async () => {
    const source = controlledProbe();
    const statuses: boolean[] = [];
    const checker = createLatestConnectivityChecker(source.probe, (status) => statuses.push(status));

    const first = checker.check();
    const second = checker.check();
    const third = checker.check();

    expect(source.pending).toHaveLength(3);
    expect(source.pending[0].signal.aborted).toBe(true);
    expect(source.pending[1].signal.aborted).toBe(true);
    source.pending[2].resolve(true);
    await Promise.all([first, second, third]);

    expect(statuses).toEqual([true]);
  });

  it("still reports a genuine failure from the newest check", async () => {
    const statuses: boolean[] = [];
    const checker = createLatestConnectivityChecker(
      async () => { throw new Error("unreachable"); },
      (status) => statuses.push(status),
    );

    await checker.check();
    expect(statuses).toEqual([false]);
  });

  it("keeps an explicit offline event authoritative over a stale success", async () => {
    const source = controlledProbe({ rejectOnAbort: false });
    const statuses: boolean[] = [];
    const checker = createLatestConnectivityChecker(source.probe, (status) => statuses.push(status));

    const checking = checker.check();
    checker.markOffline();
    source.pending[0].resolve(true);
    await checking;

    expect(statuses).toEqual([false]);
  });

  it("reports a timeout from the current check as offline", async () => {
    vi.useFakeTimers();
    try {
      const source = controlledProbe();
      const statuses: boolean[] = [];
      const checker = createLatestConnectivityChecker(
        source.probe,
        (status) => statuses.push(status),
        50,
      );

      const checking = checker.check();
      await vi.advanceTimersByTimeAsync(50);
      await checking;
      expect(statuses).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes nothing after disposal", async () => {
    const source = controlledProbe({ rejectOnAbort: false });
    const statuses: boolean[] = [];
    const checker = createLatestConnectivityChecker(source.probe, (status) => statuses.push(status));

    const checking = checker.check();
    checker.dispose();
    source.pending[0].resolve(true);
    await checking;

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
