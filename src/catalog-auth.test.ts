import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, refreshOfflineLibrary } from "./catalog";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("protected catalog authentication", () => {
  it("preserves a typed authentication failure before touching the offline cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "invalid_access_token" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    )));

    const failure = await refreshOfflineLibrary().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 401,
      code: "invalid_access_token",
      message: "Your protected session needs to be renewed.",
    });
  });

  it("describes an allowlist rejection without reporting an empty catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "access_not_authorized" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    )));

    await expect(refreshOfflineLibrary()).rejects.toMatchObject({
      status: 403,
      code: "access_not_authorized",
      message: "This account is not authorized to use the library.",
    });
  });
});
