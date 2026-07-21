/// <reference types="@cloudflare/workers-types" />

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { app } from "../worker/index";

const migration = [
  "0001_initial.sql",
  "0002_editing_foundation.sql",
  "0003_song_writes.sql",
  "0004_audio_derivatives.sql",
  "0005_audio_processing_jobs.sql",
  "0006_recording_upload_sessions.sql",
  "0007_audio_processing_control.sql",
  "0008_audio_processing_concurrency.sql",
  "0009_media_replacements.sql",
  "0010_non_unique_audio_processing_jobs.sql",
  "0011_audio_dispatch_and_replacement_guards.sql",
  "0012_scan_integrity_and_readability.sql",
  "0013_scan_maintenance_leases.sql",
  "0014_scan_display_rotation.sql",
  "0015_media_parent_moves.sql",
  "0016_playback_duplicate_detection.sql",
  "0017_scan_readability_duplicate_detection.sql",
  "0018_india_recording_calendar.sql",
  "0019_recording_upload_file_identity.sql",
]
  .map((filename) => readFileSync(resolve("migrations", filename), "utf8"))
  .join("\n");

type NativeRunResult = { changes: number | bigint };

function result<T>(results: T[], changes = 0): D1Result<T> {
  return {
    success: true,
    results,
    meta: { changes },
  } as unknown as D1Result<T>;
}

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    readonly query: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1Statement(this.database, this.query, values) as unknown as D1PreparedStatement;
  }

  private nativeStatement() {
    return this.database.prepare(this.query);
  }

  private nativeValues(): never[] {
    return this.values.map((value) => value === undefined ? null : value) as never[];
  }

  runSync<T = Record<string, unknown>>(): D1Result<T> {
    const native = this.nativeStatement().run(...this.nativeValues()) as NativeRunResult;
    return result<T>([], Number(native.changes));
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.runSync<T>();
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.nativeStatement().get(...this.nativeValues()) as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return result(this.nativeStatement().all(...this.nativeValues()) as T[]);
  }
}

function createD1(): { binding: D1Database; native: DatabaseSync } {
  const native = new DatabaseSync(":memory:");
  native.exec(migration);
  const binding = {
    prepare(query: string) {
      return new SqliteD1Statement(native, query) as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      native.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => (
          statement as unknown as SqliteD1Statement
        ).runSync());
        native.exec("COMMIT");
        return results;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { binding, native };
}

function bindings(database: D1Database) {
  return {
    DB: database,
    MEDIA: {} as R2Bucket,
    AUTH_MODE: "local" as const,
    ACCESS_AUD: "unused-locally",
    ACCESS_ISSUER: "unused-locally",
    ACCESS_JWKS_URL: "unused-locally",
    LOCAL_ROLE: "admin" as const,
  };
}

const timestamp = "2026-07-12T00:00:00.000Z";
const actor = "local@example.invalid";

function seedStoredUpload(
  database: DatabaseSync,
  options: {
    description?: string | null;
    recordedOn?: string | null;
    sha256?: string;
    withCredit?: boolean;
  } = {},
): void {
  const description = options.description === undefined ? null : options.description;
  const recordedOn = options.recordedOn ?? null;
  const sha256 = options.sha256 ?? "a".repeat(64);
  database.prepare(`
    INSERT INTO songs (
      id, title_latin, normalized_title_latin, status,
      created_at, created_by, updated_at, updated_by
    ) VALUES (?, 'Test', 'test', 'draft', ?, ?, ?, ?)
  `).run("song-1", timestamp, actor, timestamp, actor);
  if (options.withCredit) {
    database.prepare(`
      INSERT INTO people (id, full_name, normalized_name, created_at, updated_at)
      VALUES ('person-1', 'Contributor', 'contributor', ?, ?)
    `).run(timestamp, timestamp);
  }
  database.prepare(`
    INSERT INTO recording_upload_sessions (
      id, song_id, client_mutation_id, request_fingerprint,
      file_manifest_sha256,
      description, recorded_on, original_filename, byte_size, part_size, part_count,
      object_key, status, revision, expires_at,
      created_at, created_by, updated_at, updated_by
    ) VALUES (
      'upload-1', 'song-1', 'mutation-1', ?, ?, ?, ?, 'recording.bin',
      3, 8388608, 1, 'recordings/original/upload-1',
      'creating', 1, '2027-07-12T00:00:00.000Z', ?, ?, ?, ?
    )
  `).run("f".repeat(64), "e".repeat(64), description, recordedOn, timestamp, actor, timestamp, actor);
  database.prepare(`
    INSERT INTO recording_upload_intents (
      session_id, intent_kind, target_recording_id,
      target_recording_revision, created_at, created_by
    ) VALUES ('upload-1', 'create', NULL, NULL, ?, ?)
  `).run(timestamp, actor);
  if (options.withCredit) {
    database.exec(`
      INSERT INTO recording_upload_credits (session_id, person_id, role, sort_order)
      VALUES ('upload-1', 'person-1', 'vocals', 0);
    `);
  }
  database.exec(`
    UPDATE recording_upload_sessions
    SET r2_upload_id = 'multipart-1', status = 'open', revision = 2
    WHERE id = 'upload-1';
    UPDATE recording_upload_sessions
    SET status = 'completing', revision = 3
    WHERE id = 'upload-1';
  `);
  database.prepare(`
    UPDATE recording_upload_sessions
    SET status = 'stored', sha256 = ?, revision = 4
    WHERE id = 'upload-1'
  `).run(sha256);
}

function seedExistingRecording(
  database: DatabaseSync,
  options: { id?: string; mediaId?: string; objectKey?: string; description?: string; sha256?: string } = {},
): void {
  const id = options.id ?? "existing-recording";
  const mediaId = options.mediaId ?? "existing-media";
  const description = options.description ?? "Existing";
  database.prepare(`
    INSERT INTO media_objects (
      id, object_key, original_filename, byte_size, sha256, kind,
      state, created_at, created_by
    ) VALUES (?, ?, 'existing.bin', 3, ?, 'original_audio', 'active', ?, ?)
  `).run(
    mediaId,
    options.objectKey ?? `recordings/original/${mediaId}`,
    options.sha256 ?? "b".repeat(64),
    timestamp,
    actor,
  );
  database.prepare(`
    INSERT INTO recordings (
      id, song_id, original_media_id, description, normalized_description,
      processing_state, revision, created_at, created_by, updated_at, updated_by
    ) VALUES (?, 'song-1', ?, ?, ?, 'ready', 1, ?, ?, ?, ?)
  `).run(
    id, mediaId, description, description.trim().toLowerCase(),
    timestamp, actor, timestamp, actor,
  );
}

async function finalize(database: D1Database, body: Record<string, unknown> = { revision: 4 }) {
  return app.request(
    "http://local.test/api/recording-uploads/upload-1/finalize",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    bindings(database),
  );
}

describe("Recording upload finalization transaction", () => {
  it("atomically creates one fallback Recording, credit, original, and pending job", async () => {
    const { binding, native } = createD1();
    try {
      seedStoredUpload(native, { recordedOn: "2026-07-01", withCredit: true });
      seedExistingRecording(native, { description: "Recording 1" });

      const response = await finalize(binding);
      expect(response.status).toBe(201);
      const payload = await response.json() as {
        upload: { status: string; revision: number; recordingId: string };
        recording: { id: string; revision: number; processingState: string };
      };
      expect(payload.upload).toMatchObject({ status: "finalized", revision: 5 });
      expect(payload.recording).toEqual({
        id: payload.upload.recordingId,
        revision: 1,
        processingState: "processing",
      });

      const created = native.prepare(`
        SELECT
          recordings.description,
          recordings.recorded_on AS recordedOn,
          recordings.processing_state AS processingState,
          recordings.playback_media_id AS playbackMediaId,
          media_objects.id AS originalMediaId,
          media_objects.object_key AS objectKey,
          media_objects.original_filename AS originalFilename,
          media_objects.mime_type AS mimeType,
          media_objects.byte_size AS mediaByteSize,
          media_objects.sha256,
          audio_processing_jobs.status AS jobStatus,
          audio_processing_jobs.attempt_count AS attemptCount,
          audio_processing_jobs.policy_id AS policyId,
          audio_processing_jobs.source_sha256 AS jobSourceSha256,
          audio_processing_jobs.source_byte_size AS jobSourceByteSize,
          (SELECT COUNT(*) FROM recording_credits
            WHERE recording_id = recordings.id AND person_id = 'person-1' AND role = 'vocals') AS creditCount,
          (SELECT updated_at <> ? FROM songs WHERE id = recordings.song_id) AS songTouched
        FROM recordings
        JOIN media_objects ON media_objects.id = recordings.original_media_id
        JOIN audio_processing_jobs ON audio_processing_jobs.recording_id = recordings.id
        WHERE recordings.id = ?
      `).get(timestamp, payload.recording.id) as Record<string, unknown>;
      expect(created).toMatchObject({
        description: "Recording 2",
        recordedOn: "2026-07-01",
        processingState: "processing",
        playbackMediaId: null,
        originalMediaId: expect.any(String),
        objectKey: "recordings/original/upload-1",
        originalFilename: "recording.bin",
        mimeType: null,
        mediaByteSize: 3,
        sha256: "a".repeat(64),
        jobStatus: "pending",
        attemptCount: 0,
        policyId: "mp3-v1-libmp3lame-q2",
        jobSourceSha256: "a".repeat(64),
        jobSourceByteSize: 3,
        creditCount: 1,
        songTouched: 1,
      });
      const blockedOriginal = await app.request(
        `http://local.test/api/media/${String(created.originalMediaId)}`,
        undefined,
        bindings(binding),
      );
      expect(blockedOriginal.status).toBe(404);
      await expect(blockedOriginal.json()).resolves.toEqual({ error: "media_not_found" });
      expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const retry = await finalize(binding);
      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toMatchObject({
        upload: { status: "finalized", recordingId: payload.recording.id },
      });
      expect(native.prepare(`
        SELECT
          (SELECT COUNT(*) FROM media_objects WHERE object_key = 'recordings/original/upload-1') AS mediaCount,
          (SELECT COUNT(*) FROM recordings WHERE id = ?) AS recordingCount,
          (SELECT COUNT(*) FROM audio_processing_jobs WHERE recording_id = ?) AS jobCount
      `).get(payload.recording.id, payload.recording.id)).toEqual({
        mediaCount: 1,
        recordingCount: 1,
        jobCount: 1,
      });
    } finally {
      native.close();
    }
  });

  it("turns a post-completion duplicate race into a terminal review result", async () => {
    const { binding, native } = createD1();
    try {
      seedStoredUpload(native);
      seedExistingRecording(native, { sha256: "a".repeat(64) });

      const response = await finalize(binding);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        upload: {
          status: "duplicate",
          revision: 5,
          recordingId: null,
          duplicateRecording: { id: "existing-recording", songId: "song-1" },
        },
      });
      expect(native.prepare("SELECT COUNT(*) AS count FROM audio_processing_jobs").get())
        .toEqual({ count: 0 });
      expect(native.prepare("SELECT COUNT(*) AS count FROM recordings").get())
        .toEqual({ count: 1 });
    } finally {
      native.close();
    }
  });

  it("treats an exact generated playback reupload as the existing Recording", async () => {
    const { binding, native } = createD1();
    try {
      seedStoredUpload(native);
      seedExistingRecording(native, { sha256: "b".repeat(64) });
      native.prepare(`
        INSERT INTO media_objects (
          id, object_key, original_filename, byte_size, sha256, kind,
          state, created_at, created_by
        ) VALUES (
          'existing-playback', 'recordings/playback/existing-playback', 'shared.mp3',
          3, ?, 'playback_audio', 'active', ?, ?
        )
      `).run("a".repeat(64), timestamp, actor);
      native.prepare(`
        INSERT INTO audio_derivatives (
          playback_media_id, source_media_id, policy_id,
          source_sha256, source_byte_size, derivative_sha256, derivative_byte_size
        ) VALUES (
          'existing-playback', 'existing-media', 'mp3-v1-libmp3lame-q2',
          ?, 3, ?, 3
        )
      `).run("b".repeat(64), "a".repeat(64));
      native.exec(`
        UPDATE recordings SET playback_media_id = 'existing-playback'
        WHERE id = 'existing-recording';
      `);

      const response = await finalize(binding);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        upload: {
          status: "duplicate",
          revision: 5,
          recordingId: null,
          duplicateRecording: { id: "existing-recording", songId: "song-1" },
        },
      });
      expect(native.prepare(`
        SELECT duplicate_media_id AS duplicateMediaId
        FROM recording_upload_sessions WHERE id = 'upload-1'
      `).get()).toEqual({ duplicateMediaId: "existing-playback" });
      expect(native.prepare("SELECT COUNT(*) AS count FROM audio_processing_jobs").get())
        .toEqual({ count: 0 });
      expect(native.prepare("SELECT COUNT(*) AS count FROM recordings").get())
        .toEqual({ count: 1 });
      expect(native.prepare("SELECT COUNT(*) AS count FROM media_objects").get())
        .toEqual({ count: 2 });
      expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      native.close();
    }
  });

  it("keeps bytes stored across a description conflict and accepts an explicit retry", async () => {
    const { binding, native } = createD1();
    try {
      seedStoredUpload(native, { description: "Same take" });
      seedExistingRecording(native, { description: "Same take" });

      const conflict = await finalize(binding);
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toMatchObject({
        error: "duplicate_recording_description",
        existingRecording: { id: "existing-recording", songId: "song-1" },
      });
      expect(native.prepare(`
        SELECT status, revision FROM recording_upload_sessions WHERE id = 'upload-1'
      `).get()).toEqual({ status: "stored", revision: 4 });

      const resolved = await finalize(binding, { revision: 4, description: "Different take" });
      expect(resolved.status).toBe(201);
      expect(native.prepare(`
        SELECT description FROM recordings WHERE description = 'Different take'
      `).get()).toEqual({ description: "Different take" });
    } finally {
      native.close();
    }
  });

  it("rolls back every catalog insert when the private object key conflicts", async () => {
    const { binding, native } = createD1();
    try {
      seedStoredUpload(native, { description: "New take" });
      native.prepare(`
        INSERT INTO media_objects (
          id, object_key, original_filename, byte_size, sha256, kind,
          state, created_at, created_by
        ) VALUES (
          'wrong-media', 'recordings/original/upload-1', 'wrong.bin', 3, ?,
          'playback_audio', 'active', ?, ?
        )
      `).run("c".repeat(64), timestamp, actor);

      const response = await finalize(binding);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "recording_upload_finalization_failed",
      });
      expect(native.prepare(`
        SELECT status, revision, recording_id AS recordingId
        FROM recording_upload_sessions WHERE id = 'upload-1'
      `).get()).toEqual({ status: "stored", revision: 4, recordingId: null });
      expect(native.prepare("SELECT COUNT(*) AS count FROM recordings").get())
        .toEqual({ count: 0 });
      expect(native.prepare("SELECT COUNT(*) AS count FROM audio_processing_jobs").get())
        .toEqual({ count: 0 });
    } finally {
      native.close();
    }
  });

  it("rolls back earlier inserts when a catalog prerequisite affects no rows", async () => {
    const { binding, native } = createD1();
    try {
      seedStoredUpload(native, { description: "New take" });
      native.exec(`
        CREATE TRIGGER ignore_test_recording_insert
        BEFORE INSERT ON recordings
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);

      const response = await finalize(binding);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "recording_upload_finalization_failed",
      });
      expect(native.prepare(`
        SELECT status, revision, recording_id AS recordingId
        FROM recording_upload_sessions WHERE id = 'upload-1'
      `).get()).toEqual({ status: "stored", revision: 4, recordingId: null });
      expect(native.prepare(`
        SELECT
          (SELECT COUNT(*) FROM media_objects) AS mediaCount,
          (SELECT COUNT(*) FROM recordings) AS recordingCount,
          (SELECT COUNT(*) FROM audio_processing_jobs) AS jobCount
      `).get()).toEqual({ mediaCount: 0, recordingCount: 0, jobCount: 0 });
    } finally {
      native.close();
    }
  });

  it("atomically moves a trashed playback duplicate and dismisses only its duplicate upload", async () => {
    const { binding, native } = createD1();
    try {
      seedStoredUpload(native, { sha256: "b".repeat(64) });
      native.prepare(`
        INSERT INTO songs (
          id, title_latin, normalized_title_latin, status,
          created_at, created_by, updated_at, updated_by
        ) VALUES ('song-source', 'Wrong Song', 'wrong song', 'draft', ?, ?, ?, ?)
      `).run(timestamp, actor, timestamp, actor);
      native.prepare(`
        INSERT INTO media_objects (
          id, object_key, original_filename, byte_size, sha256, kind,
          state, created_at, created_by
        ) VALUES
        (
          'existing-media', 'recordings/original/existing-media', 'existing.bin',
          3, ?, 'original_audio', 'active', ?, ?
        ),
        (
          'existing-playback', 'recordings/playback/existing-playback', 'shared.mp3',
          3, ?, 'playback_audio', 'active', ?, ?
        )
      `).run("c".repeat(64), timestamp, actor, "b".repeat(64), timestamp, actor);
      native.prepare(`
        INSERT INTO audio_derivatives (
          playback_media_id, source_media_id, policy_id,
          source_sha256, source_byte_size, derivative_sha256, derivative_byte_size
        ) VALUES (
          'existing-playback', 'existing-media', 'mp3-v1-libmp3lame-q2',
          ?, 3, ?, 3
        )
      `).run("c".repeat(64), "b".repeat(64));
      native.prepare(`
        INSERT INTO recordings (
          id, song_id, original_media_id, playback_media_id, description, normalized_description,
          processing_state, revision, created_at, created_by, updated_at, updated_by
        ) VALUES (
          'existing-recording', 'song-source', 'existing-media', 'existing-playback', 'Existing', 'existing',
          'ready', 1, ?, ?, ?, ?
        )
      `).run(timestamp, actor, timestamp, actor);
      native.exec(`
        UPDATE recording_upload_sessions
        SET status = 'duplicate', duplicate_media_id = 'existing-playback', revision = 5
        WHERE id = 'upload-1';
        UPDATE recordings
        SET trashed_at = '${timestamp}', trashed_by = '${actor}', revision = 2
        WHERE id = 'existing-recording';
        UPDATE media_objects
        SET state = 'trashed', trashed_at = '${timestamp}', trashed_by = '${actor}'
        WHERE id IN ('existing-media', 'existing-playback');
      `);

      const response = await app.request(
        "http://local.test/api/trash/recordings/existing-recording/move",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            revision: 2,
            targetSongId: "song-1",
            duplicateUpload: { sessionId: "upload-1", revision: 5 },
          }),
        },
        bindings(binding),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        recording: { id: "existing-recording", songId: "song-1", revision: 3 },
      });
      expect(native.prepare(`
        SELECT song_id AS songId, trashed_at AS trashedAt, revision
        FROM recordings WHERE id = 'existing-recording'
      `).get()).toEqual({ songId: "song-1", trashedAt: null, revision: 3 });
      expect(native.prepare(`
        SELECT COUNT(*) AS count FROM media_objects
        WHERE id IN ('existing-media', 'existing-playback')
          AND state = 'active' AND trashed_at IS NULL
      `).get()).toEqual({ count: 2 });
      expect(native.prepare(`
        SELECT status, duplicate_media_id AS duplicateMediaId, error_code AS errorCode, revision
        FROM recording_upload_sessions WHERE id = 'upload-1'
      `).get()).toEqual({
        status: "failed",
        duplicateMediaId: null,
        errorCode: "user_discarded",
        revision: 6,
      });
      expect(native.prepare(`
        SELECT recording_id AS recordingId, from_song_id AS fromSongId, to_song_id AS toSongId
        FROM media_parent_moves
      `).get()).toEqual({
        recordingId: "existing-recording",
        fromSongId: "song-source",
        toSongId: "song-1",
      });
      expect(native.prepare("SELECT COUNT(*) AS count FROM recordings").get()).toEqual({ count: 1 });
      expect(native.prepare("SELECT COUNT(*) AS count FROM media_objects").get()).toEqual({ count: 2 });
      expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      native.close();
    }
  });
});

describe("typed-lyrics create idempotency", () => {
  it("creates once and returns the same row for an exact client retry", async () => {
    const { binding, native } = createD1();
    try {
      native.prepare(`
        INSERT INTO songs (
          id, title_latin, normalized_title_latin, status,
          created_at, created_by, updated_at, updated_by
        ) VALUES ('lyric-song', 'Lyric Song', 'lyric song', 'draft', ?, ?, ?, ?)
      `).run(timestamp, actor, timestamp, actor);
      const clientMutationId = "3f2a1dc0-49aa-4e52-a27a-74d1372aa219";
      const request = () => app.request(
        "http://local.test/api/songs/lyric-song/lyrics",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Exact private text", clientMutationId }),
        },
        bindings(binding),
      );

      const created = await request();
      expect(created.status).toBe(201);
      await expect(created.json()).resolves.toEqual({
        lyric: { id: clientMutationId, revision: 1 },
      });
      const replay = await request();
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toEqual({
        lyric: { id: clientMutationId, revision: 1 },
      });
      expect(native.prepare(`
        SELECT COUNT(*) AS count, MIN(content) AS content, MIN(revision) AS revision
        FROM lyric_texts WHERE song_id = 'lyric-song'
      `).get()).toEqual({ count: 1, content: "Exact private text", revision: 1 });

      const conflict = await app.request(
        "http://local.test/api/songs/lyric-song/lyrics",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Different private text", clientMutationId }),
        },
        bindings(binding),
      );
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({ error: "lyric_mutation_conflict" });
      expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      native.close();
    }
  });
});
