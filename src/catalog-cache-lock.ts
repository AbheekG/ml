export const CATALOG_CACHE_LOCK_NAME = "music-library-catalog-cache";

type LockManagerLike = {
  request: <T>(name: string, callback: () => Promise<T>) => Promise<T>;
};

let fallbackTail: Promise<void> = Promise.resolve();

function browserLockManager(): LockManagerLike | null {
  if (typeof navigator === "undefined" || !("locks" in navigator)) return null;
  return navigator.locks as LockManagerLike;
}

export async function withCatalogCacheLock<T>(
  operation: () => Promise<T>,
  lockManager: LockManagerLike | null = browserLockManager(),
): Promise<T> {
  if (lockManager) {
    return lockManager.request(CATALOG_CACHE_LOCK_NAME, operation);
  }

  const previous = fallbackTail;
  let release: () => void = () => undefined;
  fallbackTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
