import { describe, expect, it } from "vitest";
import {
  app,
  parseByteRange,
  processOnePendingScan,
  resolveActiveAppUser,
  roleAllows,
  type AppRole,
} from "./index";

function fakeImages(): ImagesBinding {
  let infoCalls = 0;
  const output = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  return {
    async info() {
      infoCalls += 1;
      return infoCalls % 2 === 1
        ? { format: "image/jpeg", fileSize: 4, width: 1200, height: 900 }
        : { format: "image/jpeg", fileSize: 4, width: 1200, height: 900 };
    },
    input() {
      const transformer = {
        transform: () => transformer,
        draw: () => transformer,
        async output() {
          return {
            response: () => new Response(output),
            contentType: () => "image/jpeg",
            image: () => new Blob([output]).stream(),
          };
        },
      };
      return transformer;
    },
  } as unknown as ImagesBinding;
}

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

describe("historical Scan maintenance", () => {
  const sourceBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

  function databaseForScanMaintenance(events: string[]): D1Database {
    return {
      prepare(query: string) {
        const statement = {
          bind(..._values: unknown[]) { return statement; },
          async first() {
            if (query.includes("LEFT JOIN scan_maintenance_leases")) {
              events.push("selected");
              return {
                mediaId: "scan-media-1",
                objectKey: "scans/legacy.jpg",
                byteSize: sourceBytes.byteLength,
                sha256: null,
              };
            }
            if (query.includes("JOIN scan_fingerprint_members")) {
              events.push("fingerprint_verified");
              return { valid: 1 };
            }
            if (query.includes("JOIN scan_readability_derivatives")) {
              events.push("derivative_verified");
              return { valid: 1 };
            }
            return null;
          },
          async run() {
            if (query.includes("INSERT INTO scan_maintenance_leases")) events.push("claimed");
            if (query.includes("UPDATE media_objects")) events.push("fingerprint_committed");
            if (query.includes("INSERT INTO scan_maintenance_failures")) events.push("failure_recorded");
            if (query.includes("DELETE FROM scan_maintenance_leases")) events.push("released");
            return { meta: { changes: 1 } };
          },
        };
        return statement as unknown as D1PreparedStatement;
      },
      async batch() {
        events.push("derivative_committed");
        return [];
      },
    } as unknown as D1Database;
  }

  it("leases, fingerprints, and commits a verified readability derivative", async () => {
    const events: string[] = [];
    const media = {
      async get() {
        events.push("source_read");
        return { arrayBuffer: async () => sourceBytes.slice().buffer };
      },
      async put() {
        events.push("derivative_stored");
        return {};
      },
      async delete() {},
    } as unknown as R2Bucket;

    await expect(processOnePendingScan({
      DB: databaseForScanMaintenance(events),
      MEDIA: media,
      IMAGES: fakeImages(),
    })).resolves.toBe("processed");
    expect(events).toEqual([
      "selected",
      "claimed",
      "source_read",
      "fingerprint_committed",
      "fingerprint_verified",
      "derivative_stored",
      "derivative_committed",
      "derivative_verified",
      "released",
    ]);
  });

  it("retains a committed source fingerprint when derivative decoding fails", async () => {
    const events: string[] = [];
    const images = {
      async info() { throw new Error("provider unavailable"); },
      input() { throw new Error("not reached"); },
    } as unknown as ImagesBinding;
    const media = {
      async get() {
        events.push("source_read");
        return { arrayBuffer: async () => sourceBytes.slice().buffer };
      },
      async put() { events.push("unexpected_store"); return {}; },
    } as unknown as R2Bucket;

    await expect(processOnePendingScan({
      DB: databaseForScanMaintenance(events),
      MEDIA: media,
      IMAGES: images,
    })).resolves.toBe("failed");
    expect(events).toEqual([
      "selected",
      "claimed",
      "source_read",
      "fingerprint_committed",
      "fingerprint_verified",
      "failure_recorded",
      "released",
    ]);
  });
});

function localBindings(database?: D1Database, localRole?: AppRole) {
  return {
    DB: database ?? {} as D1Database,
    MEDIA: {} as R2Bucket,
    IMAGES: fakeImages(),
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
    await expect(response.json()).resolves.toMatchObject({
      user: {
        displayName: "Local developer",
        role: "viewer",
        cacheNamespace: expect.stringMatching(/^[a-f0-9]{32}$/u),
      },
    });
  });

  it("prepares logout by clearing only browser caches without changing server state", async () => {
    const response = await app.request(
      "http://local.test/api/logout",
      { method: "POST" },
      localBindings(undefined, "viewer"),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Clear-Site-Data")).toBe('"cache"');
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).toBe("");
  });

  it("prevents viewers from reaching Song write validation or the database", async () => {
    const response = await app.request(
      "http://local.test/api/songs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      localBindings(undefined, "viewer"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "insufficient_role", requiredRole: "editor" });
  });

  it("rejects an invalid Song before issuing database writes", async () => {
    const response = await app.request(
      "http://local.test/api/songs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ titleLatin: "", status: "draft", languageIds: [] }),
      },
      localBindings(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_song" });
  });

  it("creates a normalized Song and all relationships in one batch", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    let batch: FakeStatement[] = [];
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            return statement;
          },
          all: async () => ({
            results: query.includes("FROM languages")
              ? [{ id: "en" }]
              : query.includes("FROM people") ? [{ id: "person-1" }] : [],
          }),
        } as unknown as FakeStatement;
        return statement;
      },
      batch: async (statements: FakeStatement[]) => {
        batch = statements;
        return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titleLatin: "  a   new SONG ",
          titleNative: null,
          status: "draft",
          languageIds: ["en"],
          tagIds: [],
          aliases: [" old NAME "],
          credits: [{ personId: "person-1", role: "lyrics" }],
          notes: null,
        }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(201);
    expect(batch[0].query).toContain("INSERT INTO songs");
    expect(batch[0].values.slice(1, 3)).toEqual(["A New Song", "a new song"]);
    expect(batch.some((statement) => statement.query.includes("INSERT INTO song_languages"))).toBe(true);
    expect(batch.some((statement) => statement.query.includes("INSERT INTO song_aliases"))).toBe(true);
    expect(batch.some((statement) => statement.query.includes("INSERT INTO song_credits"))).toBe(true);
  });

  it("reports an optimistic edit conflict when the revision update loses", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            return statement;
          },
          all: async () => ({ results: query.includes("FROM languages") ? [{ id: "en" }] : [] }),
          first: async () => query.includes("SELECT revision") ? { revision: 7 } : null,
        } as unknown as FakeStatement;
        return statement;
      },
      batch: async (statements: FakeStatement[]) => statements.map(() => ({
        success: true,
        results: [],
        meta: { changes: 0 },
      })),
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs/song-1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titleLatin: "A song",
          titleNative: null,
          status: "checked",
          languageIds: ["en"],
          tagIds: [],
          aliases: [],
          notes: null,
          revision: 1,
        }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "edit_conflict", currentRevision: 7 });
  });

  it("replaces Song Lyrics and Music credits inside the guarded edit batch", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    let batch: FakeStatement[] = [];
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            return statement;
          },
          all: async () => ({
            results: query.includes("FROM languages")
              ? [{ id: "en" }]
              : query.includes("FROM people") ? [{ id: "person-1" }] : [],
          }),
        } as unknown as FakeStatement;
        return statement;
      },
      batch: async (statements: FakeStatement[]) => {
        batch = statements;
        return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs/song-1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titleLatin: "A song",
          titleNative: null,
          status: "checked",
          languageIds: ["en"],
          tagIds: [],
          aliases: [],
          credits: [
            { personId: "person-1", role: "lyrics" },
            { personId: "person-1", role: "music" },
          ],
          notes: null,
          revision: 1,
        }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(200);
    expect(batch.some((statement) => statement.query.includes("DELETE FROM song_credits"))).toBe(true);
    const creditInserts = batch.filter((statement) => statement.query.includes("INSERT INTO song_credits"));
    expect(creditInserts).toHaveLength(2);
    expect(creditInserts.map((statement) => statement.values.slice(2, 4))).toEqual([
      ["person-1", "lyrics"],
      ["person-1", "music"],
    ]);
    await expect(response.json()).resolves.toEqual({
      song: { id: "song-1", revision: 2, titleLatin: "A Song" },
    });
  });

  it("reports active child dependencies before moving a Song to Trash", async () => {
    const database = {
      prepare: (query: string) => ({
        bind: () => ({
          first: async () => query.includes("SELECT revision, trashed_at")
            ? { revision: 2, trashedAt: null }
            : { lyricTexts: 1, scans: 2, recordings: 3 },
        }),
      }),
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs/song-1/trash",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 2 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "song_has_active_content",
      dependencies: { lyricTexts: 1, scans: 2, recordings: 3 },
    });
  });

  it("moves an active-child-free Song to Trash without deleting it", async () => {
    type FakeStatement = D1PreparedStatement & { query: string };
    let updateQuery = "";
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          bind() {
            return {
              first: async () => query.includes("SELECT revision, trashed_at")
                ? { revision: 2, trashedAt: null }
                : { lyricTexts: 0, scans: 0, recordings: 0 },
              run: async () => {
                updateQuery = query;
                return { success: true, results: [], meta: { changes: 1 } };
              },
            };
          },
        } as unknown as FakeStatement;
        return statement;
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs/song-1/trash",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 2 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(200);
    expect(updateQuery).toContain("UPDATE songs");
    expect(updateQuery).not.toContain("DELETE FROM songs");
    await expect(response.json()).resolves.toEqual({ song: { id: "song-1", revision: 3 } });
  });

  it("restores a trashed Song without changing its child records", async () => {
    let updateQuery = "";
    const database = {
      prepare: (query: string) => ({
        bind: () => ({
          run: async () => {
            updateQuery = query;
            return { success: true, results: [], meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/trash/songs/song-1/restore",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 3 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(200);
    expect(updateQuery).toContain("UPDATE songs");
    expect(updateQuery).not.toContain("lyric_texts");
    expect(updateQuery).not.toContain("scans");
    expect(updateQuery).not.toContain("recordings");
    await expect(response.json()).resolves.toEqual({ song: { id: "song-1", revision: 4 } });
  });

  it("rejects restoring a Song when its normalized title is active again", async () => {
    const database = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("UNIQUE constraint failed: songs.normalized_title_latin");
          },
        }),
      }),
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/trash/songs/song-1/restore",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 3 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "duplicate_song_title" });
  });

  it("creates typed lyrics without rewriting their content", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    let batch: FakeStatement[] = [];
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            return statement;
          },
        } as unknown as FakeStatement;
        return statement;
      },
      batch: async (statements: FakeStatement[]) => {
        batch = statements;
        return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
      },
    } as unknown as D1Database;
    const content = "  প্রথম লাইন\r\n\r\nSecond line  ";

    const response = await app.request(
      "http://local.test/api/songs/song-1/lyrics",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(201);
    expect(batch[0].query).toContain("INSERT INTO lyric_texts");
    expect(batch[0].query).toContain("MAX(existing.sort_order) + 1");
    expect(batch[0].values[1]).toBe(content);
    expect(batch[1].query).toContain("UPDATE songs");
  });

  it("rejects blank typed lyrics before issuing database writes", async () => {
    const response = await app.request(
      "http://local.test/api/songs/song-1/lyrics",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: " \n\t " }),
      },
      localBindings(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_lyric",
      fields: { content: ["Typed lyrics must not be blank"] },
    });
  });

  it("reports an optimistic typed-lyric edit conflict", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            return statement;
          },
          first: async () => query.includes("SELECT lyric_texts.revision") ? { revision: 4 } : null,
        } as unknown as FakeStatement;
        return statement;
      },
      batch: async (statements: FakeStatement[]) => statements.map(() => ({
        success: true,
        results: [],
        meta: { changes: 0 },
      })),
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs/song-1/lyrics/lyrics-1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Changed", revision: 2 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "lyric_edit_conflict",
      currentRevision: 4,
    });
  });

  it("maps duplicate typed lyrics to a useful conflict", async () => {
    const database = {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => {
        throw new Error("UNIQUE constraint failed: lyric_texts.song_id, lyric_texts.content");
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs/song-1/lyrics",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Same" }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "duplicate_lyric_text" });
  });

  it("moves typed lyrics to Trash without deleting the row", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    let batch: FakeStatement[] = [];
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            return statement;
          },
        } as unknown as FakeStatement;
        return statement;
      },
      batch: async (statements: FakeStatement[]) => {
        batch = statements;
        return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs/song-1/lyrics/lyrics-1/trash",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 2 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(200);
    expect(batch[0].query).toContain("SET trashed_at = ?");
    expect(batch[0].query).not.toContain("DELETE FROM lyric_texts");
    await expect(response.json()).resolves.toMatchObject({ lyric: { revision: 3 } });
  });

  it("lists trashed Songs and child content only for editors", async () => {
    const database = {
      prepare: (query: string) => ({
        all: async () => ({ results: query.includes("WHERE songs.trashed_at IS NOT NULL") ? [{
          id: "song-1",
          titleLatin: "A song",
          titleNative: null,
          revision: 5,
          trashedAt: "2026-07-13T00:00:00.000Z",
          lyricCount: 1,
          scanCount: 1,
          recordingCount: 1,
        }] : query.includes("FROM lyric_texts") ? [{
          id: "lyrics-1",
          songId: "song-1",
          songTitle: "A song",
          content: "Text",
          origin: "user",
          revision: 3,
          trashedAt: "2026-07-13T00:00:00.000Z",
          songIsTrashed: 1,
        }] : query.includes("FROM scans") ? [{
          id: "scan-1",
          songId: "song-1",
          songTitle: "A song",
          filename: "page.jpg",
          notebookName: "Book",
          pageLabel: "3",
          revision: 2,
          trashedAt: "2026-07-13T00:00:00.000Z",
          songIsTrashed: 1,
        }] : [{
          id: "recording-1",
          songId: "song-1",
          songTitle: "A song",
          description: "Old verse",
          recordedOn: null,
          filename: "take.mp3",
          revision: 4,
          trashedAt: "2026-07-13T00:00:00.000Z",
          songIsTrashed: 1,
        }] }),
      }),
    } as unknown as D1Database;

    const editorResponse = await app.request(
      "http://local.test/api/trash",
      undefined,
      localBindings(database, "editor"),
    );
    expect(editorResponse.status).toBe(200);
    await expect(editorResponse.json()).resolves.toMatchObject({
      songs: [{ id: "song-1", lyricCount: 1 }],
      lyrics: [{ id: "lyrics-1", songIsTrashed: true }],
      scans: [{ id: "scan-1", songIsTrashed: true }],
      recordings: [{ id: "recording-1", songIsTrashed: true }],
    });

    const viewerResponse = await app.request(
      "http://local.test/api/trash",
      undefined,
      localBindings(undefined, "viewer"),
    );
    expect(viewerResponse.status).toBe(403);
  });

  it("restores trashed typed lyrics and records the parent Song update", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    let batch: FakeStatement[] = [];
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            return statement;
          },
          first: async () => query.includes("SELECT lyric_texts.song_id AS songId")
            ? { songId: "song-1" }
            : null,
        } as unknown as FakeStatement;
        return statement;
      },
      batch: async (statements: FakeStatement[]) => {
        batch = statements;
        return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/trash/lyrics/lyrics-1/restore",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 3 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(200);
    expect(batch[0].query).toContain("SET trashed_at = NULL");
    expect(batch[1].query).toContain("UPDATE songs");
    await expect(response.json()).resolves.toEqual({
      lyric: { id: "lyrics-1", songId: "song-1", revision: 4 },
    });
  });

  it("blocks restoring duplicate active typed lyrics", async () => {
    const database = {
      prepare: (query: string) => ({
        bind: () => ({
          first: async () => query.includes("SELECT lyric_texts.song_id AS songId")
            ? { songId: "song-1" }
            : null,
        }),
      }),
      batch: async () => {
        throw new Error("UNIQUE constraint failed: lyric_texts.song_id, lyric_texts.content");
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/trash/lyrics/lyrics-1/restore",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 3 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "duplicate_lyric_text" });
  });

  it("updates Scan metadata and records the parent Song update", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    let batch: FakeStatement[] = [];
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            return statement;
          },
          all: async () => ({ results: query.includes("FROM notebooks") ? [{ id: "book-1" }] : [] }),
        } as unknown as FakeStatement;
        return statement;
      },
      batch: async (statements: FakeStatement[]) => {
        batch = statements;
        return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs/song-1/scans/scan-1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notebookId: "book-1", pageLabel: " 12A ", revision: 2 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(200);
    expect(batch[0].query).toContain("UPDATE scans");
    expect(batch[0].values.slice(0, 2)).toEqual(["book-1", "12A"]);
    expect(batch[1].query).toContain("UPDATE songs");
    await expect(response.json()).resolves.toEqual({ scan: { id: "scan-1", revision: 3 } });
  });

  it("moves a Scan and its private media object to Trash without deleting either", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    let batch: FakeStatement[] = [];
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            return statement;
          },
        } as unknown as FakeStatement;
        return statement;
      },
      batch: async (statements: FakeStatement[]) => {
        batch = statements;
        return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs/song-1/scans/scan-1/trash",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 2 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(200);
    expect(batch[0].query).toContain("UPDATE scans");
    expect(batch[1].query).toContain("UPDATE media_objects");
    expect(batch.every((statement) => !statement.query.includes("DELETE FROM"))).toBe(true);
  });

  it("restores a Scan and its private media object together", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    let batch: FakeStatement[] = [];
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            return statement;
          },
          first: async () => query.includes("SELECT scans.song_id AS songId")
            ? { songId: "song-1" }
            : null,
        } as unknown as FakeStatement;
        return statement;
      },
      batch: async (statements: FakeStatement[]) => {
        batch = statements;
        return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/trash/scans/scan-1/restore",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 3 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(200);
    expect(batch[0].query).toContain("UPDATE scans");
    expect(batch[1].query).toContain("UPDATE media_objects");
    await expect(response.json()).resolves.toEqual({
      scan: { id: "scan-1", songId: "song-1", revision: 4 },
    });
  });

  it("updates Recording metadata and Vocals credits atomically", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    let batch: FakeStatement[] = [];
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            return statement;
          },
          all: async () => ({ results: query.includes("FROM people") ? [{ id: "person-1" }] : [] }),
        } as unknown as FakeStatement;
        return statement;
      },
      batch: async (statements: FakeStatement[]) => {
        batch = statements;
        return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs/song-1/recordings/recording-1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "  Old verse, different tune  ",
          recordedOn: "2020-02-29",
          creditPersonIds: ["person-1"],
          revision: 2,
        }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(200);
    expect(batch[0].query).toContain("UPDATE recordings");
    expect(batch[0].values.slice(0, 3)).toEqual([
      "Old verse, different tune",
      "old verse, different tune",
      "2020-02-29",
    ]);
    expect(batch[1].query).toContain("DELETE FROM recording_credits");
    expect(batch[2].query).toContain("INSERT INTO recording_credits");
    expect(batch.at(-1)?.query).toContain("UPDATE songs");
    await expect(response.json()).resolves.toEqual({ recording: { id: "recording-1", revision: 3 } });
  });

  it("moves a Recording and its private media objects to Trash without deleting records", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    let batch: FakeStatement[] = [];
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            return statement;
          },
        } as unknown as FakeStatement;
        return statement;
      },
      batch: async (statements: FakeStatement[]) => {
        batch = statements;
        return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/songs/song-1/recordings/recording-1/trash",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 2 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(200);
    expect(batch[0].query).toContain("UPDATE recordings");
    expect(batch[1].query).toContain("UPDATE media_objects");
    expect(batch.every((statement) => !statement.query.includes("DELETE FROM"))).toBe(true);
  });

  it("restores a Recording and its private media objects together", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    let batch: FakeStatement[] = [];
    const database = {
      prepare: (query: string) => {
        const statement = {
          query,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            return statement;
          },
          first: async () => query.includes("SELECT recordings.song_id AS songId")
            ? { songId: "song-1" }
            : null,
        } as unknown as FakeStatement;
        return statement;
      },
      batch: async (statements: FakeStatement[]) => {
        batch = statements;
        return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/trash/recordings/recording-1/restore",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 3 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(200);
    expect(batch[0].query).toContain("UPDATE recordings");
    expect(batch[1].query).toContain("UPDATE media_objects");
    await expect(response.json()).resolves.toEqual({
      recording: { id: "recording-1", songId: "song-1", revision: 4 },
    });
  });

  it("reports a duplicate description conflict while restoring a Recording", async () => {
    const database = {
      prepare: (query: string) => ({
        bind: () => ({
          first: async () => query.includes("SELECT recordings.song_id AS songId")
            ? { songId: "song-1" }
            : null,
        }),
      }),
      batch: async () => {
        throw new Error("UNIQUE constraint failed: recordings.song_id, recordings.normalized_description");
      },
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/trash/recordings/recording-1/restore",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 3 }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "duplicate_recording_description" });
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
                revision: 4,
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
                role: "vocals",
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
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.text()).resolves.toBe("audio");
  });

  it("streams the private Scan readability representation with a bounded file contract", async () => {
    const database = {
      prepare: () => ({ bind: () => ({ first: async () => ({
        objectKey: "scans/readability/media-1.jpg",
        filename: "private-page.png",
        mimeType: "image/jpeg",
        isDerivative: 1,
      }) }) }),
    } as unknown as D1Database;
    let requestedKey = "";
    const image = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const media = {
      get: async (key: string) => {
        requestedKey = key;
        return {
          body: image,
          size: image.byteLength,
          httpEtag: '"etag"',
          writeHttpMetadata: () => undefined,
        };
      },
    } as unknown as R2Bucket;

    const response = await app.request(
      "http://local.test/api/scans/scan-1/image",
      undefined,
      { ...localBindings(database), MEDIA: media },
    );

    expect(response.status).toBe(200);
    expect(requestedKey).toBe("scans/readability/media-1.jpg");
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe(String(image.byteLength));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-scan-representation")).toBe("readability");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(image);
  });

  it("streams only the current private Recording playback source for sharing", async () => {
    let playbackQuery = "";
    let boundRecordingId = "";
    const database = {
      prepare: (query: string) => {
        playbackQuery = query;
        return {
          bind: (recordingId: string) => {
            boundRecordingId = recordingId;
            return { first: async () => ({
              objectKey: "recordings/playback/recording-1.mp3",
              mimeType: "audio/mpeg",
              byteSize: 6,
            }) };
          },
        };
      },
    } as unknown as D1Database;
    let requestedKey = "";
    const audio = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
    const media = {
      get: async (key: string) => {
        requestedKey = key;
        return {
          body: audio,
          size: audio.byteLength,
          httpEtag: '"etag"',
          writeHttpMetadata: () => undefined,
        };
      },
    } as unknown as R2Bucket;

    const response = await app.request(
      "http://local.test/api/recordings/recording-1/playback",
      undefined,
      { ...localBindings(database, "viewer"), MEDIA: media },
    );

    expect(response.status).toBe(200);
    expect(boundRecordingId).toBe("recording-1");
    expect(playbackQuery).toContain("recordings.playback_media_id IS NULL");
    expect(playbackQuery).toContain("playback_media.id = recordings.playback_media_id");
    expect(playbackQuery).toContain("recordings.processing_state = 'ready'");
    expect(requestedKey).toBe("recordings/playback/recording-1.mp3");
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=recording.mp3");
    expect(response.headers.get("content-length")).toBe(String(audio.byteLength));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-recording-representation")).toBe("playback");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio);
  });

  it("rejects an oversized Recording playback source before reading private storage", async () => {
    const database = {
      prepare: () => ({ bind: () => ({ first: async () => ({
        objectKey: "recordings/playback/large.mp3",
        mimeType: "audio/mpeg",
        byteSize: 52_428_801,
      }) }) }),
    } as unknown as D1Database;
    let storageRead = false;
    const media = {
      get: async () => {
        storageRead = true;
        return null;
      },
    } as unknown as R2Bucket;

    const response = await app.request(
      "http://local.test/api/recordings/recording-1/playback",
      undefined,
      { ...localBindings(database, "viewer"), MEDIA: media },
    );

    expect(response.status).toBe(413);
    expect(storageRead).toBe(false);
    await expect(response.json()).resolves.toEqual({
      error: "recording_playback_too_large_to_share",
    });
  });

  it("rejects a Recording playback object whose private size disagrees with D1", async () => {
    const database = {
      prepare: () => ({ bind: () => ({ first: async () => ({
        objectKey: "recordings/playback/mismatch.mp3",
        mimeType: "audio/mpeg",
        byteSize: 6,
      }) }) }),
    } as unknown as D1Database;
    const media = {
      get: async () => ({
        body: new Uint8Array([1, 2, 3]),
        size: 3,
        httpEtag: '"etag"',
        writeHttpMetadata: () => undefined,
      }),
    } as unknown as R2Bucket;

    const response = await app.request(
      "http://local.test/api/recordings/recording-1/playback",
      undefined,
      { ...localBindings(database, "viewer"), MEDIA: media },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "recording_playback_invalid" });
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
    expect(response.headers.get("cache-control")).toBe("private, no-store");
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

describe("controlled lookup API", () => {
  it("returns all controlled lists to editors", async () => {
    const database = {
      prepare: (query: string) => ({
        all: async () => ({
          results: query.includes("FROM languages")
            ? [{ id: "language-1", name: "Bengali" }]
            : query.includes("FROM tags")
              ? [{ id: "tag-1", name: "Original" }]
              : query.includes("FROM notebooks")
                ? [{ id: "notebook-1", name: "Blue Book" }]
                : [{ id: "person-1", name: "A. R. Rahman" }],
        }),
      }),
    } as unknown as D1Database;

    const response = await app.request("http://local.test/api/lookups", undefined, localBindings(database));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      languages: [{ id: "language-1", name: "Bengali" }],
      tags: [{ id: "tag-1", name: "Original" }],
      notebooks: [{ id: "notebook-1", name: "Blue Book" }],
      people: [{ id: "person-1", name: "A. R. Rahman" }],
    });
  });

  it("normalizes whitespace before creating a list item", async () => {
    let values: unknown[] = [];
    const database = {
      prepare: () => ({
        bind: (...bound: unknown[]) => {
          values = bound;
          return { run: async () => ({ meta: { changes: 1 } }) };
        },
      }),
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/lookups/people",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  A.  R. Rahman  " }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(201);
    expect(values[1]).toBe("A. R. Rahman");
    expect(values[2]).toBe("a. r. rahman");
  });

  it("maps database uniqueness protection to a useful duplicate response", async () => {
    const database = {
      prepare: () => ({
        bind: () => ({ run: async () => { throw new Error("UNIQUE constraint failed: tags.normalized_name"); } }),
      }),
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/lookups/tags",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Original" }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "duplicate_lookup_name" });
  });

  it("detects a stale rename without overwriting the current name", async () => {
    const database = {
      prepare: (query: string) => ({
        bind: () => query.includes("UPDATE tags")
          ? { run: async () => ({ meta: { changes: 0 } }) }
          : { first: async () => ({ name: "Current name" }) },
      }),
    } as unknown as D1Database;

    const response = await app.request(
      "http://local.test/api/lookups/tags/tag-1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New name", currentName: "Old name" }),
      },
      localBindings(database),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "lookup_edit_conflict", currentName: "Current name" });
  });
});

describe("Scan upload API", () => {
  function scanUploadBody(): FormData {
    const body = new FormData();
    body.set("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], "page.txt", { type: "text/plain" }));
    body.set("notebookId", "");
    body.set("pageLabel", "");
    return body;
  }

  it("stores verified image bytes before atomically creating Scan records", async () => {
    type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };
    const database = {
      prepare: (query: string) => ({
        query,
        values: [],
        bind(...values: unknown[]) {
          const statement = this as unknown as FakeStatement;
          return {
            ...statement,
            values,
            first: async () => query.includes("FROM songs")
              ? { id: "song-1" }
              : null,
          };
        },
      }),
      batch: async (statements: FakeStatement[]) => {
        expect(statements[0].query).toContain("INSERT INTO media_objects");
        expect(statements[0].values[3]).toBe("image/jpeg");
        expect(statements[0].values[4]).toBe(4);
        expect(statements[0].values[5]).toMatch(/^[a-f0-9]{64}$/);
        expect(statements[1].query).toContain("INSERT INTO scan_readability_derivatives");
        expect(statements[2].query).toContain("INSERT INTO scans");
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database;
    const stored = new Map<string, number>();
    const media = {
      put: async (key: string, value: Uint8Array) => {
        stored.set(key, value.byteLength);
        return {};
      },
    } as unknown as R2Bucket;

    const response = await app.request(
      "http://local.test/api/songs/song-1/scans",
      { method: "POST", body: scanUploadBody() },
      { ...localBindings(database), MEDIA: media },
    );

    expect(response.status).toBe(201);
    expect([...stored.keys()]).toEqual(expect.arrayContaining([
      expect.stringMatching(/^scans\/[a-f0-9-]+\.jpg$/u),
      expect.stringMatching(/^scans\/readability\/[a-f0-9-]+\.jpg$/u),
    ]));
    expect([...stored.values()]).toEqual([4, 4]);
    await expect(response.json()).resolves.toMatchObject({ scan: { revision: 1, filename: "page.txt" } });
  });

  it("rejects duplicate bytes before writing to private storage", async () => {
    const database = {
      prepare: (query: string) => ({
        bind: () => ({
          first: async () => query.includes("FROM songs")
            ? { id: "song-1" }
            : {
                scanId: "scan-existing",
                songId: "song-existing",
                songTitle: "Existing Song",
                filename: "existing.jpg",
                notebookName: "Blue Book",
                pageLabel: "12A",
                scanIsTrashed: 0,
                songIsTrashed: 0,
              },
        }),
      }),
    } as unknown as D1Database;
    let wroteMedia = false;
    const media = { put: async () => { wroteMedia = true; } } as unknown as R2Bucket;

    const response = await app.request(
      "http://local.test/api/songs/song-1/scans",
      { method: "POST", body: scanUploadBody() },
      { ...localBindings(database), MEDIA: media },
    );

    expect(response.status).toBe(409);
    expect(wroteMedia).toBe(false);
    await expect(response.json()).resolves.toEqual({
      error: "duplicate_scan_file",
      existing: {
        scanId: "scan-existing",
        songId: "song-existing",
        songTitle: "Existing Song",
        filename: "existing.jpg",
        notebookName: "Blue Book",
        pageLabel: "12A",
        isTrashed: false,
      },
    });
  });

  it("does not expose nullable details for duplicate media retained only in history", async () => {
    const database = {
      prepare: (query: string) => ({
        bind: () => ({
          first: async () => query.includes("FROM songs")
            ? { id: "song-1" }
            : {
                scanId: null,
                songId: null,
                songTitle: null,
                filename: "historical.jpg",
                notebookName: null,
                pageLabel: null,
                scanIsTrashed: null,
                songIsTrashed: null,
              },
        }),
      }),
    } as unknown as D1Database;
    let wroteMedia = false;
    const media = { put: async () => { wroteMedia = true; } } as unknown as R2Bucket;

    const response = await app.request(
      "http://local.test/api/songs/song-1/scans",
      { method: "POST", body: scanUploadBody() },
      { ...localBindings(database), MEDIA: media },
    );

    expect(response.status).toBe(409);
    expect(wroteMedia).toBe(false);
    await expect(response.json()).resolves.toEqual({
      error: "duplicate_scan_file",
      fields: { file: ["This file is already retained in the library"] },
    });
  });

  it("removes an uploaded object when the database transaction fails", async () => {
    const database = {
      prepare: (query: string) => ({
        query,
        bind: (...values: unknown[]) => ({
          query,
          values,
          first: async () => query.includes("FROM songs") ? { id: "song-1" } : null,
        }),
      }),
      batch: async () => { throw new Error("database unavailable"); },
    } as unknown as D1Database;
    const uploadedKeys: string[] = [];
    let deletedKeys: string | string[] = [];
    const media = {
      put: async (key: string) => { uploadedKeys.push(key); return {}; },
      delete: async (keys: string | string[]) => { deletedKeys = keys; },
    } as unknown as R2Bucket;

    const response = await app.request(
      "http://local.test/api/songs/song-1/scans",
      { method: "POST", body: scanUploadBody() },
      { ...localBindings(database), MEDIA: media },
    );

    expect(response.status).toBe(500);
    expect(deletedKeys).toEqual(uploadedKeys);
  });
});
