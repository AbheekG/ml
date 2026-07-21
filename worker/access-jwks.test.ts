import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAccessJwksCacheForTests, loadAccessJwks } from "./access-jwks";

function jwk(kid: string) {
  return { kty: "RSA", kid, alg: "RS256", use: "sig", n: "modulus", e: "AQAB" };
}

afterEach(() => clearAccessJwksCacheForTests());

describe("Access JWKS cache", () => {
  it("uses workerd-compatible manual redirect handling and rejects redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: "https://unexpected.invalid/certs" },
    }));

    await expect(loadAccessJwks("https://access.invalid/certs", "key-1", { fetcher }))
      .rejects.toThrow("access_jwks_fetch_failed");
    expect(fetcher).toHaveBeenCalledWith("https://access.invalid/certs", expect.objectContaining({
      redirect: "manual",
    }));
  });

  it("reuses fresh keys and refreshes immediately for a newly observed key id", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ keys: [jwk("key-1")] }, {
        headers: { "Cache-Control": "public, max-age=300" },
      }))
      .mockResolvedValueOnce(Response.json({ keys: [jwk("key-1"), jwk("key-2")] }));

    await expect(loadAccessJwks("https://access.invalid/certs", "key-1", {
      fetcher, now: 1_000,
    })).resolves.toHaveLength(1);
    await expect(loadAccessJwks("https://access.invalid/certs", "key-1", {
      fetcher, now: 2_000,
    })).resolves.toHaveLength(1);
    await expect(loadAccessJwks("https://access.invalid/certs", "key-2", {
      fetcher, now: 32_000,
    })).resolves.toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rate-limits unknown-key refreshes while a cached set is fresh", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      keys: [jwk("key-1")],
    }, { headers: { "Cache-Control": "max-age=300" } }));
    await loadAccessJwks("https://access.invalid/certs", "key-1", { fetcher, now: 1_000 });
    await expect(loadAccessJwks("https://access.invalid/certs", "attacker-key", {
      fetcher, now: 2_000,
    })).rejects.toThrow("access_jwks_key_not_found");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses a bounded stale key only when refresh is unavailable", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ keys: [jwk("key-1")] }, {
        headers: { "Cache-Control": "max-age=1" },
      }))
      .mockRejectedValueOnce(new TypeError("network unavailable"));
    await loadAccessJwks("https://access.invalid/certs", "key-1", { fetcher, now: 1_000 });
    await expect(loadAccessJwks("https://access.invalid/certs", "key-1", {
      fetcher, now: 3_000,
    })).resolves.toEqual([jwk("key-1")]);
    await expect(loadAccessJwks("https://access.invalid/certs", "missing", {
      fetcher: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")),
      now: 4_000,
    })).rejects.toThrow();
  });

  it("rejects malformed, duplicate, or non-signing key sets", async () => {
    for (const keys of [[], [jwk("same"), jwk("same")], [{ ...jwk("key"), use: "enc" }]]) {
      clearAccessJwksCacheForTests();
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ keys }));
      await expect(loadAccessJwks("https://access.invalid/certs", "key", { fetcher }))
        .rejects.toThrow("access_jwks_invalid");
    }
  });
});
