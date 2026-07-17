import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_LOGOUT_PATH,
  PENDING_ACCESS_LOGOUT_KEY,
  PRIVATE_CACHE_NAMESPACE_KEY,
  PRIVATE_DATA_BARRIER_KEY,
  PrivateDataBlockedError,
  beginPrivateDataClearing,
  completePendingAccessLogout,
  isAccessLogoutPending,
  isPrivateDataBlocked,
  isPrivateDataClearedMessage,
  logoutAndClearPrivateData,
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
    });
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
    const navigate = vi.fn();
    await expect(logoutAndClearPrivateData({
      storage,
      barrierToken: "logout-1",
      notifyOtherTabs: vi.fn(),
      clearPrivateLocalData: async () => { throw new Error("IndexedDB unavailable"); },
      fetcher: async () => new Response(null, { status: 204 }),
      navigate,
      online: true,
    })).resolves.toBe("navigating");
    expect(storage.getItem(PRIVATE_DATA_BARRIER_KEY)).toBe("logout-1");
    expect(storage.getItem(PENDING_ACCESS_LOGOUT_KEY)).toBeNull();
    expect(navigate).toHaveBeenCalledWith(ACCESS_LOGOUT_PATH);
  });

  it("automatically completes a pending offline logout after connectivity returns", async () => {
    const storage = memoryStorage({
      [PRIVATE_DATA_BARRIER_KEY]: "logout-1",
      [PENDING_ACCESS_LOGOUT_KEY]: "logout-1",
    });
    const navigate = vi.fn();
    await expect(completePendingAccessLogout({
      storage,
      fetcher: async () => new Response(null, { status: 204 }),
      navigate,
    })).resolves.toBe(true);
    expect(storage.getItem(PENDING_ACCESS_LOGOUT_KEY)).toBeNull();
    expect(storage.getItem(PRIVATE_DATA_BARRIER_KEY)).toBe("logout-1");
    expect(navigate).toHaveBeenCalledWith(ACCESS_LOGOUT_PATH);
  });

  it("retains pending logout and private-data blocking when the remote request fails", async () => {
    const storage = memoryStorage({
      [PRIVATE_DATA_BARRIER_KEY]: "logout-1",
      [PENDING_ACCESS_LOGOUT_KEY]: "logout-1",
    });
    const navigate = vi.fn();
    await expect(completePendingAccessLogout({
      storage,
      fetcher: async () => new Response(null, { status: 503 }),
      navigate,
    })).resolves.toBe(false);
    expect(storage.getItem(PENDING_ACCESS_LOGOUT_KEY)).toBe("logout-1");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("accepts only the bounded cross-tab invalidation message", () => {
    expect(isPrivateDataClearedMessage({ type: "private-data-cleared" })).toBe(true);
    expect(isPrivateDataClearedMessage({ type: "different" })).toBe(false);
    expect(isPrivateDataClearedMessage(null)).toBe(false);
  });
});
