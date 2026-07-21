export type AccessJwk = JsonWebKey & {
  kid: string;
  alg?: string;
};

type CacheEntry = {
  keys: AccessJwk[];
  expiresAt: number;
  staleUntil: number;
  lastUsedAt: number;
  lastRefreshAt: number;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 4;
const MIN_FORCED_REFRESH_INTERVAL_MS = 30 * 1000;
const MAX_JWKS_BYTES = 128 * 1024;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();

function cacheTtl(response: Response): number {
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  const match = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/iu.exec(cacheControl);
  if (!match) return DEFAULT_TTL_MS;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds)
    ? Math.min(seconds * 1000, MAX_TTL_MS)
    : DEFAULT_TTL_MS;
}

function validKey(value: unknown): value is AccessJwk {
  if (!value || typeof value !== "object") return false;
  const key = value as Record<string, unknown>;
  return key.kty === "RSA"
    && typeof key.kid === "string"
    && key.kid.length >= 1
    && key.kid.length <= 255
    && typeof key.n === "string"
    && key.n.length >= 1
    && typeof key.e === "string"
    && key.e.length >= 1
    && (key.alg === undefined || key.alg === "RS256")
    && (key.use === undefined || key.use === "sig");
}

function boundCache(): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const oldest = [...cache.entries()]
    .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
  if (oldest) cache.delete(oldest[0]);
}

async function refreshJwks(
  url: string,
  fetcher: typeof fetch,
  now: number,
): Promise<CacheEntry> {
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("access_jwks_fetch_failed");
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_JWKS_BYTES)) {
    throw new Error("access_jwks_invalid");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JWKS_BYTES) {
    throw new Error("access_jwks_invalid");
  }
  let body: { keys?: unknown };
  try {
    body = JSON.parse(text) as { keys?: unknown };
  } catch {
    throw new Error("access_jwks_invalid");
  }
  if (!Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 20) {
    throw new Error("access_jwks_invalid");
  }
  const keys = body.keys.filter(validKey);
  if (keys.length !== body.keys.length) throw new Error("access_jwks_invalid");
  const uniqueKids = new Set(keys.map((key) => key.kid));
  if (uniqueKids.size !== keys.length) throw new Error("access_jwks_invalid");
  const entry = {
    keys,
    expiresAt: now + cacheTtl(response),
    staleUntil: now + STALE_TTL_MS,
    lastUsedAt: now,
    lastRefreshAt: now,
  };
  cache.set(url, entry);
  boundCache();
  return entry;
}

async function sharedRefresh(
  url: string,
  fetcher: typeof fetch,
  now: number,
): Promise<CacheEntry> {
  const existing = inFlight.get(url);
  if (existing) return existing;
  const request = refreshJwks(url, fetcher, now).finally(() => {
    inFlight.delete(url);
  });
  inFlight.set(url, request);
  return request;
}

export async function loadAccessJwks(
  url: string,
  expectedKid: string,
  options: { fetcher?: typeof fetch; now?: number } = {},
): Promise<AccessJwk[]> {
  const now = options.now ?? Date.now();
  const fetcher = options.fetcher ?? fetch;
  const existing = cache.get(url);
  if (
    existing
    && existing.expiresAt > now
    && existing.keys.some((key) => key.kid === expectedKid)
  ) {
    existing.lastUsedAt = now;
    return existing.keys;
  }
  if (
    existing
    && existing.expiresAt > now
    && now - existing.lastRefreshAt < MIN_FORCED_REFRESH_INTERVAL_MS
  ) {
    throw new Error("access_jwks_key_not_found");
  }
  try {
    const refreshed = await sharedRefresh(url, fetcher, now);
    if (!refreshed.keys.some((key) => key.kid === expectedKid)) {
      throw new Error("access_jwks_key_not_found");
    }
    return refreshed.keys;
  } catch (error) {
    if (
      existing
      && existing.staleUntil > now
      && existing.keys.some((key) => key.kid === expectedKid)
    ) {
      existing.lastUsedAt = now;
      return existing.keys;
    }
    throw error;
  }
}

export function clearAccessJwksCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
