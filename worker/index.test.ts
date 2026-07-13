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
