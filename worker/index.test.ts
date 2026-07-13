import { describe, expect, it } from "vitest";
import { app, parseByteRange, resolveActiveAppUser, roleAllows, type AppRole } from "./index";

describe("parseByteRange", () => {
  it("parses bounded, open-ended, and suffix ranges", () => {
    expect(parseByteRange("bytes=10-19", 100)).toEqual({ offset: 10, length: 10 });
    expect(parseByteRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseByteRange("bytes=-12", 100)).toEqual({ offset: 88, length: 12 });
  });

  it("rejects invalid and multiple ranges", () => {
    expect(parseByteRange("bytes=100-101", 100)).toBeNull();
    expect(parseByteRange("bytes=20-10", 100)).toBeNull();
    expect(parseByteRange("bytes=0-1,5-6", 100)).toBeNull();
  });
});

function localBindings(database?: D1Database, localRole?: AppRole) {
  return {
    DB: database ?? {} as D1Database,
    MEDIA: {} as R2Bucket,
    AUTH_MODE: "local" as const,
    ACCESS_AUD: "unused-locally",
    ACCESS_ISSUER: "unused-locally",
    ACCESS_JWKS_URL: "unused-locally",
    LOCAL_ROLE: localRole,
  };
}

describe("Worker API", () => {
  it("uses the viewer/editor/admin role hierarchy", () => {
    expect(roleAllows("viewer", "viewer")).toBe(true);
    expect(roleAllows("viewer", "editor")).toBe(false);
    expect(roleAllows("editor", "viewer")).toBe(true);
    expect(roleAllows("editor", "admin")).toBe(false);
    expect(roleAllows("admin", "editor")).toBe(true);
  });

  it("resolves only an active allowlisted application user", async () => {
    let boundIdentity = "";
    const database = {
      prepare: () => ({
        bind: (identity: string) => {
          boundIdentity = identity;
          return { first: async () => ({
            identity: "owner@example.test",
            displayName: "Owner",
            role: "admin",
          }) };
        },
      }),
    } as unknown as D1Database;

    await expect(resolveActiveAppUser(database, "Owner@Example.Test")).resolves.toEqual({
      identity: "owner@example.test",
      displayName: "Owner",
      role: "admin",
    });
    expect(boundIdentity).toBe("Owner@Example.Test");
  });

  it("returns the signed-in application role without exposing the identity", async () => {
    const response = await app.request(
      "http://local.test/api/session",
      undefined,
      localBindings(undefined, "viewer"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user: { displayName: "Local developer", role: "viewer" },
    });
  });

  it("reports a healthy service", async () => {
    const response = await app.request("http://local.test/api/health", undefined, localBindings());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "music-library",
      status: "ok",
    });
  });

  it("returns JSON for unknown API routes", async () => {
    const response = await app.request("http://local.test/api/missing", undefined, localBindings());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "not_found",
    });
  });

  it("returns normalized catalog rows", async () => {
    const database = {
      prepare: () => ({
        all: async () => ({
          results: [{
            id: "song-1",
            titleLatin: "A song",
            titleNative: null,
            updatedAt: "2026-07-12T00:00:00.000Z",
            languageIds: '["bn"]',
            lyricCount: 1,
            scanCount: 2,
            recordingCount: 3,
          }],
        }),
      }),
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/catalog",
      undefined,
      localBindings(database),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      songs: [{
        id: "song-1",
        titleLatin: "A song",
        titleNative: null,
        updatedAt: "2026-07-12T00:00:00.000Z",
        languageIds: ["bn"],
        lyricCount: 1,
        scanCount: 2,
        recordingCount: 3,
      }],
    });
  });

  it("returns a complete song detail and normalizes recording media flags", async () => {
    const database = {
      prepare: (query: string) => ({
        bind: () => ({
          first: async () => ({
            id: "song-1",
            titleLatin: "A song",
            titleNative: null,
            status: "Learned",
            notes: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          }),
          all: async () => {
            if (query.includes("FROM recordings\n")) {
              return { results: [{
                id: "recording-1",
                description: "First take",
                recordedOn: null,
                processingState: "ready",
                filename: "recording.m4a",
                hasPlaybackMedia: 1,
              }] };
            }
            if (query.includes("FROM recording_credits")) {
              return { results: [{
                recordingId: "recording-1",
                personId: "person-1",
                fullName: "A person",
                role: "Vocals",
              }] };
            }
            return { results: [] };
          },
        }),
      }),
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs/song-1",
      undefined,
      localBindings(database),
    );
    const payload = await response.json() as {
      song: { recordings: Array<{ hasPlaybackMedia: boolean; credits: unknown[] }> };
    };

    expect(response.status).toBe(200);
    expect(payload.song.recordings).toEqual([expect.objectContaining({
      hasPlaybackMedia: true,
      credits: [expect.objectContaining({ fullName: "A person" })],
    })]);
  });

  it("returns 404 for a missing song", async () => {
    const database = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs/missing",
      undefined,
      localBindings(database),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "song_not_found" });
  });

  it("streams an active referenced media object from private storage", async () => {
    const database = {
      prepare: () => ({ bind: () => ({ first: async () => ({
        id: "media-1",
        objectKey: "recordings/example.mp3",
        filename: "example.mp3",
        mimeType: "audio/mpeg",
      }) }) }),
    } as unknown as D1Database;
    const media = {
      get: async () => ({
        body: new Blob(["audio"]).stream(),
        size: 5,
        range: undefined,
        httpEtag: '"etag"',
        writeHttpMetadata: () => undefined,
      }),
    } as unknown as R2Bucket;

    const response = await app.request(
      "http://local.test/api/media/media-1",
      undefined,
      { ...localBindings(database), MEDIA: media },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    await expect(response.text()).resolves.toBe("audio");
  });

  it("returns valid partial-content headers for audio seeking", async () => {
    const database = {
      prepare: () => ({ bind: () => ({ first: async () => ({
        id: "media-1",
        objectKey: "recordings/example.mp3",
        filename: "example.mp3",
        mimeType: "audio/mpeg",
      }) }) }),
    } as unknown as D1Database;
    const media = {
      get: async () => ({
        body: new Uint8Array(1024).buffer,
        size: 5000,
        range: { offset: 0, length: 1024 },
        httpEtag: '"etag"',
        writeHttpMetadata: () => undefined,
      }),
    } as unknown as R2Bucket;

    const response = await app.request(
      "http://local.test/api/media/media-1",
      { headers: { Range: "bytes=0-1023" } },
      { ...localBindings(database), MEDIA: media },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-1023/5000");
    expect(response.headers.get("content-length")).toBe("1024");
  });

  it("rejects API requests that bypass Access without a signed assertion", async () => {
    const response = await app.request(
      "https://app.example.test/api/health",
      undefined,
      {
        DB: {} as D1Database,
        AUTH_MODE: "access",
        ACCESS_AUD: "test-audience",
        ACCESS_ISSUER: "https://access.example.test",
        ACCESS_JWKS_URL: "https://access.example.test/certs",
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "authentication_required" });
  });

  it("fails closed when Access verification is not configured", async () => {
    const response = await app.request(
      "https://app.example.test/api/health",
      undefined,
      {
        DB: {} as D1Database,
        AUTH_MODE: "access",
        ACCESS_AUD: "",
        ACCESS_ISSUER: "",
        ACCESS_JWKS_URL: "",
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "authentication_not_configured" });
  });
});
