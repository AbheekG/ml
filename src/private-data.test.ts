import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_LOGOUT_NAVIGATION_KEY,
  ACCESS_LOGOUT_PATH,
  PENDING_ACCESS_LOGOUT_KEY,
  PRIVATE_CACHE_NAMESPACE_KEY,
  PRIVATE_DATA_BARRIER_KEY,
  PrivateDataBlockedError,
  acknowledgeAccessLogoutReturn,
  beginPrivateDataClearing,
  completePendingAccessLogout,
  isAccessLogoutPending,
  isPrivateDataBlocked,
  isPrivateDataClearedMessage,
  logoutAndClearPrivateData,
  markAccessLogoutNavigation,
  privateDataBoundaryPresentation,
  reconcilePrivateDataSession,
  requestPrivateBrowserCacheClear,
} from "./private-data";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, value); },
  };
}

describe("private local data lifecycle", () => {
  it("places a persistent barrier before removing the previous cache namespace", () => {
    const storage = memoryStorage({ [PRIVATE_CACHE_NAMESPACE_KEY]: "user-a" });
    expect(beginPrivateDataClearing(storage, "logout-1")).toBe("logout-1");
    expect(storage.getItem(PRIVATE_DATA_BARRIER_KEY)).toBe("logout-1");
    expect(storage.getItem(PENDING_ACCESS_LOGOUT_KEY)).toBe("logout-1");
    expect(storage.getItem(PRIVATE_CACHE_NAMESPACE_KEY)).toBeNull();
    expect(isPrivateDataBlocked(storage)).toBe(true);
    expect(isAccessLogoutPending(storage)).toBe(true);
  });

  it("clears stale data before allowing a fresh authenticated session", async () => {
    const storage = memoryStorage({
      [PRIVATE_DATA_BARRIER_KEY]: "logout-1",
      [PRIVATE_CACHE_NAMESPACE_KEY]: "user-a",
    });
    const clear = vi.fn(async () => undefined);

    await reconcilePrivateDataSession("user-b", clear, storage);

    expect(clear).toHaveBeenCalledOnce();
    expect(storage.getItem(PRIVATE_DATA_BARRIER_KEY)).toBeNull();
    expect(storage.getItem(PRIVATE_CACHE_NAMESPACE_KEY)).toBe("user-b");
  });

  it("clears before binding a session when the namespace marker is missing", async () => {
    const storage = memoryStorage();
    const clear = vi.fn(async () => undefined);
    await reconcilePrivateDataSession("user-a", clear, storage);
    expect(clear).toHaveBeenCalledOnce();
    expect(storage.getItem(PRIVATE_CACHE_NAMESPACE_KEY)).toBe("user-a");
  });

  it("does not remove a newer logout barrier created during session reconciliation", async () => {
    const storage = memoryStorage({ [PRIVATE_DATA_BARRIER_KEY]: "logout-1" });
    await expect(reconcilePrivateDataSession("user-a", async () => {
      storage.setItem(PRIVATE_DATA_BARRIER_KEY, "logout-2");
    }, storage)).rejects.toBeInstanceOf(PrivateDataBlockedError);
    expect(storage.getItem(PRIVATE_DATA_BARRIER_KEY)).toBe("logout-2");
    expect(storage.getItem(PRIVATE_CACHE_NAMESPACE_KEY)).toBeNull();
  });

  it("never reconciles an authenticated session while Access logout is pending", async () => {
    const storage = memoryStorage({
      [PRIVATE_DATA_BARRIER_KEY]: "logout-1",
      [PENDING_ACCESS_LOGOUT_KEY]: "logout-1",
    });
    const clear = vi.fn(async () => undefined);
    await expect(reconcilePrivateDataSession("user-a", clear, storage))
      .rejects.toBeInstanceOf(PrivateDataBlockedError);
    expect(clear).not.toHaveBeenCalled();
  });

  it("requests a network-only same-origin cache clear", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await requestPrivateBrowserCacheClear(fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/logout", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: expect.any(AbortSignal),
    });
  });

  it("bounds a cache-clear request that never completes", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    await expect(requestPrivateBrowserCacheClear(fetcher, 1)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps Access logout pending without making a remote request while offline", async () => {
    const storage = memoryStorage({ [PRIVATE_CACHE_NAMESPACE_KEY]: "user-a" });
    const notify = vi.fn();
    const navigate = vi.fn();
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(logoutAndClearPrivateData({
      storage,
      barrierToken: "logout-1",
      notifyOtherTabs: notify,
      clearPrivateLocalData: async () => undefined,
      fetcher,
      navigate,
      online: false,
    })).resolves.toBe("pending");
    expect(storage.getItem(PRIVATE_DATA_BARRIER_KEY)).toBe("logout-1");
    expect(storage.getItem(PENDING_ACCESS_LOGOUT_KEY)).toBe("logout-1");
    expect(notify).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("finishes online Access logout after local clearing even if local verification fails", async () => {
    const storage = memoryStorage({ [PRIVATE_CACHE_NAMESPACE_KEY]: "user-a" });
    const navigationStorage = memoryStorage();
    const navigate = vi.fn();
    await expect(logoutAndClearPrivateData({
      storage,
      navigationStorage,
      barrierToken: "logout-1",
      notifyOtherTabs: vi.fn(),
      clearPrivateLocalData: async () => { throw new Error("IndexedDB unavailable"); },
      fetcher: async () => new Response(null, { status: 204 }),
      navigate,
      online: true,
    })).resolves.toBe("navigating");
    expect(storage.getItem(PRIVATE_DATA_BARRIER_KEY)).toBe("logout-1");
    expect(storage.getItem(PENDING_ACCESS_LOGOUT_KEY)).toBe("logout-1");
    expect(navigationStorage.getItem(ACCESS_LOGOUT_NAVIGATION_KEY)).toBe("logout-1");
    expect(navigate).toHaveBeenCalledWith(ACCESS_LOGOUT_PATH);
  });

  it("automatically completes a pending offline logout after connectivity returns", async () => {
    const storage = memoryStorage({
      [PRIVATE_DATA_BARRIER_KEY]: "logout-1",
      [PENDING_ACCESS_LOGOUT_KEY]: "logout-1",
    });
    const navigationStorage = memoryStorage();
    const navigate = vi.fn();
    await expect(completePendingAccessLogout({
      storage,
      navigationStorage,
      fetcher: async () => new Response(null, { status: 204 }),
      navigate,
    })).resolves.toBe(true);
    expect(storage.getItem(PENDING_ACCESS_LOGOUT_KEY)).toBe("logout-1");
    expect(navigationStorage.getItem(ACCESS_LOGOUT_NAVIGATION_KEY)).toBe("logout-1");
    expect(storage.getItem(PRIVATE_DATA_BARRIER_KEY)).toBe("logout-1");
    expect(navigate).toHaveBeenCalledWith(ACCESS_LOGOUT_PATH);
  });

  it("reaches Access logout when the best-effort remote cache clear fails", async () => {
    const storage = memoryStorage({
      [PRIVATE_DATA_BARRIER_KEY]: "logout-1",
      [PENDING_ACCESS_LOGOUT_KEY]: "logout-1",
    });
    const navigationStorage = memoryStorage();
    const navigate = vi.fn();
    await expect(completePendingAccessLogout({
      storage,
      navigationStorage,
      fetcher: async () => new Response(null, { status: 503 }),
      navigate,
    })).resolves.toBe(true);
    expect(storage.getItem(PENDING_ACCESS_LOGOUT_KEY)).toBe("logout-1");
    expect(navigationStorage.getItem(ACCESS_LOGOUT_NAVIGATION_KEY)).toBe("logout-1");
    expect(navigate).toHaveBeenCalledWith(ACCESS_LOGOUT_PATH);
  });

  it("acknowledges only the matching Cloudflare logout return", () => {
    const storage = memoryStorage({
      [PRIVATE_DATA_BARRIER_KEY]: "logout-1",
      [PENDING_ACCESS_LOGOUT_KEY]: "logout-1",
    });
    const navigationStorage = memoryStorage({ [ACCESS_LOGOUT_NAVIGATION_KEY]: "logout-1" });
    expect(acknowledgeAccessLogoutReturn(
      "?__cf_access_message=logged_out",
      storage,
      navigationStorage,
    )).toBe(true);
    expect(storage.getItem(PENDING_ACCESS_LOGOUT_KEY)).toBeNull();
    expect(storage.getItem(PRIVATE_DATA_BARRIER_KEY)).toBe("logout-1");
    expect(navigationStorage.getItem(ACCESS_LOGOUT_NAVIGATION_KEY)).toBeNull();
  });

  it("marks only a currently pending Access logout for top-level navigation", () => {
    const storage = memoryStorage({ [PENDING_ACCESS_LOGOUT_KEY]: "logout-1" });
    const navigationStorage = memoryStorage();
    expect(markAccessLogoutNavigation(storage, navigationStorage)).toBe(true);
    expect(navigationStorage.getItem(ACCESS_LOGOUT_NAVIGATION_KEY)).toBe("logout-1");
    storage.removeItem(PENDING_ACCESS_LOGOUT_KEY);
    expect(markAccessLogoutNavigation(storage, navigationStorage)).toBe(false);
  });

  it("does not trust a forged or stale logged-out query parameter", () => {
    const storage = memoryStorage({
      [PRIVATE_DATA_BARRIER_KEY]: "logout-2",
      [PENDING_ACCESS_LOGOUT_KEY]: "logout-2",
    });
    const navigationStorage = memoryStorage({ [ACCESS_LOGOUT_NAVIGATION_KEY]: "logout-1" });
    expect(acknowledgeAccessLogoutReturn(
      "?__cf_access_message=logged_out",
      storage,
      navigationStorage,
    )).toBe(false);
    expect(acknowledgeAccessLogoutReturn("?unrelated=value", storage, navigationStorage)).toBe(false);
    expect(storage.getItem(PENDING_ACCESS_LOGOUT_KEY)).toBe("logout-2");
    expect(navigationStorage.getItem(ACCESS_LOGOUT_NAVIGATION_KEY)).toBe("logout-1");
  });

  it("accepts only the bounded cross-tab invalidation message", () => {
    expect(isPrivateDataClearedMessage({ type: "private-data-cleared" })).toBe(true);
    expect(isPrivateDataClearedMessage({ type: "different" })).toBe(false);
    expect(isPrivateDataClearedMessage(null)).toBe(false);
  });

  it("does not offer a competing navigation while automatic Access logout is pending", () => {
    expect(privateDataBoundaryPresentation({
      accessLogoutPending: true,
      isOnline: true,
      sessionResolved: false,
    })).toEqual({
      heading: "Finishing sign-out",
      message: "This device’s private library has been cleared. Cloudflare sign-out will open automatically.",
      action: null,
    });
  });

  it("describes session reconciliation instead of flashing a signed-out action", () => {
    expect(privateDataBoundaryPresentation({
      accessLogoutPending: false,
      isOnline: true,
      sessionResolved: false,
    })).toMatchObject({ heading: "Restoring library", action: null });
  });

  it("offers one hard-navigation recovery only after session resolution", () => {
    expect(privateDataBoundaryPresentation({
      accessLogoutPending: false,
      isOnline: true,
      sessionResolved: true,
      sessionIssue: { kind: "authentication", message: "Renew the session." },
    })).toEqual({
      heading: "Signed out",
      message: "Renew the session.",
      action: { label: "Sign in", href: "/songs" },
    });
    expect(privateDataBoundaryPresentation({
      accessLogoutPending: false,
      isOnline: true,
      sessionResolved: true,
      sessionIssue: { kind: "unavailable", message: "Session check failed." },
    })).toEqual({
      heading: "Library unavailable",
      message: "Session check failed.",
      action: { label: "Retry", href: "/songs" },
    });
  });
});
