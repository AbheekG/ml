export const PRIVATE_CACHE_NAMESPACE_KEY = "music-library-cache-namespace";
export const PRIVATE_DATA_BARRIER_KEY = "music-library-private-data-clearing";
export const PRIVATE_DATA_CHANNEL_NAME = "music-library-private-data";
export const PENDING_ACCESS_LOGOUT_KEY = "music-library-access-logout-pending";
export const ACCESS_LOGOUT_NAVIGATION_KEY = "music-library-access-logout-navigation";
export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

const PRIVATE_CACHE_CLEAR_TIMEOUT_MS = 5_000;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type PrivateDataBoundaryPresentation = {
  heading: string;
  message: string;
  action: { label: string; href: string } | null;
};

export function privateDataBoundaryPresentation(options: {
  accessLogoutPending: boolean;
  isOnline: boolean;
  sessionResolved: boolean;
  sessionIssue?: { kind: "authentication" | "unavailable"; message: string } | null;
}): PrivateDataBoundaryPresentation {
  if (options.accessLogoutPending) {
    return {
      heading: "Finishing sign-out",
      message: options.isOnline
        ? "This device’s private library has been cleared. Cloudflare sign-out will open automatically."
        : "This device’s private library has been cleared. Cloudflare sign-out will continue automatically when this device reconnects.",
      action: null,
    };
  }
  if (options.isOnline && !options.sessionResolved) {
    return {
      heading: "Restoring library",
      message: "Checking your protected session before syncing this device again.",
      action: null,
    };
  }
  if (options.isOnline && options.sessionIssue?.kind === "unavailable") {
    return {
      heading: "Library unavailable",
      message: options.sessionIssue.message,
      action: { label: "Retry", href: "/songs" },
    };
  }
  return {
    heading: "Signed out",
    message: options.isOnline
      ? options.sessionIssue?.message ?? "This device’s private library has been cleared. Sign in to sync it again."
      : "This device’s private library has been cleared. Reconnect before signing in again.",
    action: options.isOnline ? { label: "Sign in", href: "/songs" } : null,
  };
}

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
  timeoutMs: number = PRIVATE_CACHE_CLEAR_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher("/api/logout", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Private browser cache clear was rejected");
  } finally {
    clearTimeout(timeout);
  }
}

export function acknowledgeAccessLogoutReturn(
  search: string,
  storage: StorageLike = localStorage,
  navigationStorage: StorageLike = sessionStorage,
): boolean {
  if (new URLSearchParams(search).get("__cf_access_message") !== "logged_out") return false;
  const pendingToken = storage.getItem(PENDING_ACCESS_LOGOUT_KEY);
  if (
    pendingToken === null
    || navigationStorage.getItem(ACCESS_LOGOUT_NAVIGATION_KEY) !== pendingToken
  ) {
    return false;
  }
  storage.removeItem(PENDING_ACCESS_LOGOUT_KEY);
  navigationStorage.removeItem(ACCESS_LOGOUT_NAVIGATION_KEY);
  return true;
}

export function markAccessLogoutNavigation(
  storage: StorageLike = localStorage,
  navigationStorage: StorageLike = sessionStorage,
): boolean {
  const pendingToken = storage.getItem(PENDING_ACCESS_LOGOUT_KEY);
  if (pendingToken === null) return false;
  navigationStorage.setItem(ACCESS_LOGOUT_NAVIGATION_KEY, pendingToken);
  return true;
}

export async function completePendingAccessLogout(options: {
  navigate: (path: string) => void;
  storage?: StorageLike;
  navigationStorage?: StorageLike;
  fetcher?: typeof fetch;
}): Promise<boolean> {
  const storage = options.storage ?? localStorage;
  if (!isAccessLogoutPending(storage)) return false;
  try {
    await requestPrivateBrowserCacheClear(options.fetcher);
  } catch {
    // The cache-clear response is defense in depth. Access logout is the
    // authoritative session boundary and must remain reachable if this fetch
    // is rejected, redirected, or unavailable despite an online browser state.
  }
  const navigationStorage = options.navigationStorage ?? sessionStorage;
  if (!markAccessLogoutNavigation(storage, navigationStorage)) return false;
  options.navigate(ACCESS_LOGOUT_PATH);
  return true;
}

export async function logoutAndClearPrivateData(options: {
  clearPrivateLocalData: () => Promise<void>;
  notifyOtherTabs: () => void;
  navigate: (path: string) => void;
  storage?: StorageLike;
  navigationStorage?: StorageLike;
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
