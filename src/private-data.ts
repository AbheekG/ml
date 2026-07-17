export const PRIVATE_CACHE_NAMESPACE_KEY = "music-library-cache-namespace";
export const PRIVATE_DATA_BARRIER_KEY = "music-library-private-data-clearing";
export const PRIVATE_DATA_CHANNEL_NAME = "music-library-private-data";
export const PENDING_ACCESS_LOGOUT_KEY = "music-library-access-logout-pending";
export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class PrivateDataBlockedError extends Error {
  constructor() {
    super("Private local data is being cleared");
  }
}

export function isPrivateDataBlocked(storage: StorageLike = localStorage): boolean {
  return storage.getItem(PRIVATE_DATA_BARRIER_KEY) !== null;
}

export function isAccessLogoutPending(storage: StorageLike = localStorage): boolean {
  return storage.getItem(PENDING_ACCESS_LOGOUT_KEY) !== null;
}

export function assertPrivateDataWritable(storage: StorageLike = localStorage): void {
  if (isPrivateDataBlocked(storage)) throw new PrivateDataBlockedError();
}

export function beginPrivateDataClearing(
  storage: StorageLike = localStorage,
  token: string = crypto.randomUUID(),
): string {
  storage.setItem(PRIVATE_DATA_BARRIER_KEY, token);
  storage.setItem(PENDING_ACCESS_LOGOUT_KEY, token);
  storage.removeItem(PRIVATE_CACHE_NAMESPACE_KEY);
  return token;
}

export async function reconcilePrivateDataSession(
  cacheNamespace: string,
  clearPrivateLocalData: () => Promise<void>,
  storage: StorageLike = localStorage,
): Promise<void> {
  if (isAccessLogoutPending(storage)) throw new PrivateDataBlockedError();
  const initialBarrier = storage.getItem(PRIVATE_DATA_BARRIER_KEY);
  const previousNamespace = storage.getItem(PRIVATE_CACHE_NAMESPACE_KEY);
  if (initialBarrier !== null || previousNamespace !== cacheNamespace) {
    await clearPrivateLocalData();
  }
  if (storage.getItem(PRIVATE_DATA_BARRIER_KEY) !== initialBarrier) {
    throw new PrivateDataBlockedError();
  }
  storage.setItem(PRIVATE_CACHE_NAMESPACE_KEY, cacheNamespace);
  if (initialBarrier !== null) storage.removeItem(PRIVATE_DATA_BARRIER_KEY);
}

export function isPrivateDataClearedMessage(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && (value as { type?: unknown }).type === "private-data-cleared";
}

export async function requestPrivateBrowserCacheClear(
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/logout", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Private browser cache clear was rejected");
}

export async function completePendingAccessLogout(options: {
  navigate: (path: string) => void;
  storage?: StorageLike;
  fetcher?: typeof fetch;
}): Promise<boolean> {
  const storage = options.storage ?? localStorage;
  if (!isAccessLogoutPending(storage)) return false;
  try {
    await requestPrivateBrowserCacheClear(options.fetcher);
  } catch {
    return false;
  }
  storage.removeItem(PENDING_ACCESS_LOGOUT_KEY);
  options.navigate(ACCESS_LOGOUT_PATH);
  return true;
}

export async function logoutAndClearPrivateData(options: {
  clearPrivateLocalData: () => Promise<void>;
  notifyOtherTabs: () => void;
  navigate: (path: string) => void;
  storage?: StorageLike;
  fetcher?: typeof fetch;
  barrierToken?: string;
  online: boolean;
}): Promise<"navigating" | "pending"> {
  beginPrivateDataClearing(options.storage, options.barrierToken);
  options.notifyOtherTabs();
  await Promise.allSettled([options.clearPrivateLocalData()]);
  if (!options.online) return "pending";
  return await completePendingAccessLogout(options) ? "navigating" : "pending";
}
