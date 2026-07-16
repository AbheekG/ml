/// <reference types="@cloudflare/workers-types" />

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { app } from "../worker/index";

const migration = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  .map((number) => readFileSync(
    resolve(`migrations/${String(number).padStart(4, "0")}_${[
      "initial",
      "editing_foundation",
      "song_writes",
      "audio_derivatives",
      "audio_processing_jobs",
      "recording_upload_sessions",
      "audio_processing_control",
      "audio_processing_concurrency",
      "media_replacements",
      "non_unique_audio_processing_jobs",
      "audio_dispatch_and_replacement_guards",
    ][number - 1]}.sql`),
    "utf8",
  ))
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

/**
 * Seeds a Recording that already has a completed audio_processing_jobs entry.
 * This simulates the state after an initial upload + processing has succeeded.
 * The recording is in 'ready' state with a derivative playback file.
 */
function seedReadyRecordingWithSucceededJob(
  native: DatabaseSync,
  options: {
    sha256?: string;
    recordingId?: string;
    mediaId?: string;
    jobId?: string;
    derivativeMediaId?: string;
  } = {},
): void {
  const recordingId = options.recordingId ?? "recording-1";
  const mediaId = options.mediaId ?? "original-media-1";
  const jobId = options.jobId ?? "job-1";
  const sha256 = options.sha256 ?? "b".repeat(64);
  const derivativeMediaId = options.derivativeMediaId ?? "derivative-media-1";

  native.prepare(`
    INSERT INTO songs (
      id, title_latin, normalized_title_latin, status,
      created_at, created_by, updated_at, updated_by
    ) VALUES (?, 'Test Song', 'test song', 'draft', ?, ?, ?, ?)
  `).run("song-1", timestamp, actor, timestamp, actor);

  native.prepare(`
    INSERT INTO media_objects (
      id, object_key, original_filename, byte_size, sha256, kind,
      state, created_at, created_by
    ) VALUES (?, ?, 'original.wav', 3, ?, 'original_audio', 'active', ?, ?)
  `).run(mediaId, `recordings/original/${mediaId}`, sha256, timestamp, actor);

  native.prepare(`
    INSERT INTO media_objects (
      id, object_key, original_filename, byte_size, sha256, kind,
      state, created_at, created_by
    ) VALUES (?, ?, 'derivative.mp3', 5, ?, 'playback_audio', 'active', ?, ?)
  `).run(derivativeMediaId, `recordings/playback/${derivativeMediaId}`, "d".repeat(64), timestamp, actor);

  // audio_derivatives uses playback_media_id as PK (not a separate id column)
  native.prepare(`
    INSERT INTO audio_derivatives (
      playback_media_id, source_media_id, policy_id,
      source_sha256, source_byte_size,
      derivative_sha256, derivative_byte_size
    ) VALUES (?, ?, 'mp3-v1-libmp3lame-q2', ?, 3, ?, 5)
  `).run(derivativeMediaId, mediaId, sha256, "d".repeat(64));

  native.prepare(`
    INSERT INTO recordings (
      id, song_id, original_media_id, playback_media_id,
      description, normalized_description,
      processing_state, revision,
      created_at, created_by, updated_at, updated_by
    ) VALUES (?, 'song-1', ?, ?, 'First Recording', 'first recording', 'ready', 1, ?, ?, ?, ?)
  `).run(recordingId, mediaId, derivativeMediaId, timestamp, actor, timestamp, actor);

  // Insert the original (succeeded) audio_processing_jobs row.
  // SQLite triggers cannot be disabled by PRAGMA; we must drop them, insert, then restore.
  // The triggers that validate insert state (require 'pending' status and processing_state)
  // need to be bypassed to seed a pre-existing 'succeeded' job for testing.
  native.exec(`
    DROP TRIGGER IF EXISTS validate_audio_processing_job_insert;
    DROP TRIGGER IF EXISTS validate_audio_processing_job_initial_attempt;
    DROP TRIGGER IF EXISTS validate_audio_processing_error_code_insert;
    PRAGMA foreign_keys = OFF;
  `);
  native.prepare(`
    INSERT INTO audio_processing_jobs (
      id, recording_id, source_media_id, source_sha256, source_byte_size,
      policy_id, status, attempt_count,
      lease_token_hash, lease_expires_at,
      playback_kind, derivative_media_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 3, 'mp3-v1-libmp3lame-q2', 'succeeded', 1,
      NULL, NULL, 'derivative', ?, ?, ?)
  `).run(jobId, recordingId, mediaId, sha256, derivativeMediaId, timestamp, timestamp);
  native.exec(`PRAGMA foreign_keys = ON;`);
  // Re-create the dropped triggers from migration 0010
  native.exec(`
    CREATE TRIGGER IF NOT EXISTS validate_audio_processing_job_insert
    BEFORE INSERT ON audio_processing_jobs
    WHEN NOT EXISTS (
        SELECT 1
        FROM recordings
        JOIN media_objects ON media_objects.id = recordings.original_media_id
        WHERE recordings.id = NEW.recording_id
          AND recordings.original_media_id = NEW.source_media_id
          AND recordings.processing_state = 'processing'
          AND recordings.processing_error IS NULL
          AND recordings.trashed_at IS NULL
          AND media_objects.kind = 'original_audio'
          AND media_objects.state = 'active'
          AND media_objects.sha256 = NEW.source_sha256
          AND media_objects.byte_size = NEW.source_byte_size
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid_audio_processing_job_source');
    END;

    CREATE TRIGGER IF NOT EXISTS validate_audio_processing_job_initial_attempt
    BEFORE INSERT ON audio_processing_jobs
    WHEN NEW.status <> 'pending' OR NEW.attempt_count <> 0
    BEGIN
      SELECT RAISE(ABORT, 'invalid_audio_processing_job_attempt');
    END;

    CREATE TRIGGER IF NOT EXISTS validate_audio_processing_error_code_insert
    BEFORE INSERT ON audio_processing_jobs
    WHEN NEW.error_code IS NOT NULL AND (
      length(NEW.error_code) > 100
      OR substr(NEW.error_code, 1, 1) NOT GLOB '[a-z]'
      OR NEW.error_code GLOB '*[^a-z0-9_]*'
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid_audio_processing_error_code');
    END;
  `);
}

/**
 * Seeds a "stored" upload session for song-1, using a NEW sha256 (different from
 * the existing recording's media), so it won't be treated as duplicate.
 */
function seedStoredUploadSession(
  native: DatabaseSync,
  options: {
    sessionId?: string;
    sha256?: string;
    targetRevision?: number;
  } = {},
): void {
  const sessionId = options.sessionId ?? "upload-replace-1";
  const sha256 = options.sha256 ?? "a".repeat(64); // different from "b".repeat(64)

  native.prepare(`
    INSERT INTO recording_upload_sessions (
      id, song_id, client_mutation_id, request_fingerprint,
      description, recorded_on, original_filename, byte_size, part_size, part_count,
      object_key, status, revision, expires_at,
      created_at, created_by, updated_at, updated_by
    ) VALUES (
      ?, 'song-1', 'replace-mutation-1', ?,
      'First Recording', NULL, 'new.wav',
      3, 8388608, 1,
      ?,
      'creating', 1, '2027-07-12T00:00:00.000Z',
      ?, ?, ?, ?
    )
  `).run(
    sessionId,
    "f".repeat(64),
    `recordings/original/${sessionId}`,
    timestamp, actor, timestamp, actor,
  );
  native.prepare(`
    INSERT INTO recording_upload_intents (
      session_id, intent_kind, target_recording_id,
      target_recording_revision, created_at, created_by
    ) VALUES (?, 'replace', 'recording-1', ?, ?, ?)
  `).run(sessionId, options.targetRevision ?? 1, timestamp, actor);

  // Advance to 'stored' status
  native.exec(`
    UPDATE recording_upload_sessions
    SET r2_upload_id = 'multipart-replace-1', status = 'open', revision = 2
    WHERE id = '${sessionId}';
    UPDATE recording_upload_sessions
    SET status = 'completing', revision = 3
    WHERE id = '${sessionId}';
  `);
  native.prepare(`
    UPDATE recording_upload_sessions
    SET status = 'stored', sha256 = ?, revision = 4
    WHERE id = ?
  `).run(sha256, sessionId);
}

async function replace(
  database: D1Database,
  songId: string,
  sessionId: string,
  recordingId: string,
  body: Record<string, unknown>,
) {
  return app.request(
    `http://local.test/api/songs/${songId}/recording-uploads/${sessionId}/replace`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    bindings(database),
  );
}

describe("Recording upload /replace endpoint", () => {
  it("succeeds when replacing a ready recording that has an existing succeeded audio_processing_jobs row", async () => {
    const { binding, native } = createD1();
    try {
      // The key regression: recording has a prior succeeded job
      seedReadyRecordingWithSucceededJob(native);
      seedStoredUploadSession(native);

      const response = await replace(binding, "song-1", "upload-replace-1", "recording-1", {
        targetRecordingId: "recording-1",
        targetRecordingRevision: 1,
        sessionRevision: 4,
      });

      expect(response.status).toBe(201);
      const payload = await response.json() as {
        upload: { status: string; revision: number; recordingId: string };
        recording: { id: string; revision: number; processingState: string };
      };
      expect(payload.upload.status).toBe("finalized");
      expect(payload.upload.recordingId).toBe("recording-1");
      expect(payload.recording.id).toBe("recording-1");
      expect(payload.recording.processingState).toBe("processing");

      // Verify recording was updated with new media
      const rec = native.prepare(`
        SELECT recordings.revision, recordings.processing_state AS processingState,
               recordings.original_media_id AS originalMediaId,
               recordings.playback_media_id AS playbackMediaId
        FROM recordings WHERE id = 'recording-1'
      `).get() as Record<string, unknown>;
      expect(rec.processingState).toBe("processing");
      expect(rec.revision).toBe(2);
      expect(rec.playbackMediaId).toBeNull(); // cleared on replace

      // Verify there are now 2 audio_processing_jobs entries:
      // the old succeeded one and the new pending one
      const jobCount = native.prepare(
        "SELECT COUNT(*) AS count FROM audio_processing_jobs WHERE recording_id = 'recording-1'"
      ).get() as { count: number };
      expect(jobCount.count).toBe(2);

      const pendingJob = native.prepare(`
        SELECT status, source_media_id AS sourceMediaId
        FROM audio_processing_jobs
        WHERE recording_id = 'recording-1' AND status = 'pending'
      `).get() as { status: string; sourceMediaId: string } | undefined;
      expect(pendingJob).toBeDefined();
      expect(pendingJob?.status).toBe("pending");
      // The pending job should reference the new media object (not the old one)
      expect(pendingJob?.sourceMediaId).not.toBe("original-media-1");

      // Verify media history was recorded
      const history = native.prepare(
        "SELECT COUNT(*) AS count FROM recording_media_history WHERE recording_id = 'recording-1'"
      ).get() as { count: number };
      expect(history.count).toBe(1);

      // Verify no foreign key violations
      expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      native.close();
    }
  });

  it("marks session as duplicate when uploaded file is identical to an existing media object", async () => {
    const { binding, native } = createD1();
    try {
      // Seed a recording with sha256 = "b".repeat(64)
      seedReadyRecordingWithSucceededJob(native, { sha256: "b".repeat(64) });
      // Seed an upload session with the SAME sha256 as the recording
      seedStoredUploadSession(native, { sha256: "b".repeat(64) });

      const response = await replace(binding, "song-1", "upload-replace-1", "recording-1", {
        targetRecordingId: "recording-1",
        targetRecordingRevision: 1,
        sessionRevision: 4,
      });

      expect(response.status).toBe(200);
      const payload = await response.json() as {
        upload: { status: string; duplicateRecording: unknown };
      };
      expect(payload.upload.status).toBe("duplicate");

      // Recording should NOT have been updated
      const rec = native.prepare(`
        SELECT processing_state AS processingState, revision FROM recordings WHERE id = 'recording-1'
      `).get() as { processingState: string; revision: number };
      expect(rec.processingState).toBe("ready"); // unchanged
      expect(rec.revision).toBe(1); // unchanged
    } finally {
      native.close();
    }
  });

  it("returns 409 recording_conflict when targetRecordingRevision is stale", async () => {
    const { binding, native } = createD1();
    try {
      seedReadyRecordingWithSucceededJob(native);
      seedStoredUploadSession(native);

      const response = await replace(binding, "song-1", "upload-replace-1", "recording-1", {
        targetRecordingId: "recording-1",
        targetRecordingRevision: 999, // wrong revision
        sessionRevision: 4,
      });

      expect(response.status).toBe(409);
      const payload = await response.json() as { error: string };
      expect(payload.error).toBe("recording_conflict");
    } finally {
      native.close();
    }
  });

  it("rejects changing the replacement target after the upload starts", async () => {
    const { binding, native } = createD1();
    try {
      seedReadyRecordingWithSucceededJob(native);
      seedStoredUploadSession(native);

      const response = await replace(binding, "song-1", "upload-replace-1", "nonexistent-recording", {
        targetRecordingId: "nonexistent-recording",
        targetRecordingRevision: 1,
        sessionRevision: 4,
      });

      expect(response.status).toBe(409);
      const payload = await response.json() as { error: string };
      expect(payload.error).toBe("recording_upload_intent_mismatch");
    } finally {
      native.close();
    }
  });

  it("rejects replacement when processing starts after the upload intent is recorded", async () => {
    const { binding, native } = createD1();
    try {
      seedReadyRecordingWithSucceededJob(native);
      seedStoredUploadSession(native);
      native.exec(`
        UPDATE recordings
        SET playback_media_id = NULL, processing_state = 'processing', revision = 2
        WHERE id = 'recording-1';
        INSERT INTO audio_processing_jobs (
          id, recording_id, source_media_id, source_sha256, source_byte_size,
          policy_id, status, attempt_count, created_at, updated_at
        ) VALUES (
          'job-pending', 'recording-1', 'original-media-1', '${"b".repeat(64)}', 3,
          'mp3-v1-libmp3lame-q2', 'pending', 0, '${timestamp}', '${timestamp}'
        );
      `);

      const response = await replace(binding, "song-1", "upload-replace-1", "recording-1", {
        targetRecordingId: "recording-1",
        targetRecordingRevision: 1,
        sessionRevision: 4,
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "recording_conflict" });
      expect(native.prepare(
        "SELECT status FROM recording_upload_sessions WHERE id = 'upload-replace-1'",
      ).get()).toEqual({ status: "stored" });
    } finally {
      native.close();
    }
  });

  it("allows a safely failed Recording to be replaced", async () => {
    const { binding, native } = createD1();
    try {
      seedReadyRecordingWithSucceededJob(native);
      native.exec(`
        UPDATE recordings
        SET playback_media_id = NULL, processing_state = 'failed',
            processing_error = 'previous_processing_failed', revision = 2
        WHERE id = 'recording-1';
      `);
      seedStoredUploadSession(native, { targetRevision: 2 });

      const response = await replace(binding, "song-1", "upload-replace-1", "recording-1", {
        targetRecordingId: "recording-1",
        targetRecordingRevision: 2,
        sessionRevision: 4,
      });

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        recording: { id: "recording-1", processingState: "processing", revision: 3 },
      });
    } finally {
      native.close();
    }
  });
});
