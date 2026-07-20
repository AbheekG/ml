import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeedSql } from "./load-local-db";

const initialMigration = readFileSync(resolve("migrations/0001_initial.sql"), "utf8");
const editingMigration = readFileSync(resolve("migrations/0002_editing_foundation.sql"), "utf8");
const songWritesMigration = readFileSync(resolve("migrations/0003_song_writes.sql"), "utf8");
const audioDerivativesMigration = readFileSync(resolve("migrations/0004_audio_derivatives.sql"), "utf8");
const audioProcessingJobsMigration = readFileSync(resolve("migrations/0005_audio_processing_jobs.sql"), "utf8");
const recordingUploadSessionsMigration = readFileSync(resolve("migrations/0006_recording_upload_sessions.sql"), "utf8");
const audioProcessingControlMigration = readFileSync(resolve("migrations/0007_audio_processing_control.sql"), "utf8");
const audioProcessingConcurrencyMigration = readFileSync(resolve("migrations/0008_audio_processing_concurrency.sql"), "utf8");
const mediaReplacementsMigration = readFileSync(resolve("migrations/0009_media_replacements.sql"), "utf8");
const nonUniqueJobsMigration = readFileSync(resolve("migrations/0010_non_unique_audio_processing_jobs.sql"), "utf8");
const audioDispatchMigration = readFileSync(resolve("migrations/0011_audio_dispatch_and_replacement_guards.sql"), "utf8");
const scanIntegrityMigration = readFileSync(resolve("migrations/0012_scan_integrity_and_readability.sql"), "utf8");
const scanMaintenanceLeasesMigration = readFileSync(resolve("migrations/0013_scan_maintenance_leases.sql"), "utf8");
const scanDisplayRotationMigration = readFileSync(resolve("migrations/0014_scan_display_rotation.sql"), "utf8");
const mediaParentMovesMigration = readFileSync(resolve("migrations/0015_media_parent_moves.sql"), "utf8");
const migration = `${initialMigration}\n${editingMigration}\n${songWritesMigration}\n${audioDerivativesMigration}\n${audioProcessingJobsMigration}\n${recordingUploadSessionsMigration}\n${audioProcessingControlMigration}\n${audioProcessingConcurrencyMigration}\n${mediaReplacementsMigration}\n${nonUniqueJobsMigration}\n${audioDispatchMigration}\n${scanIntegrityMigration}\n${scanMaintenanceLeasesMigration}\n${scanDisplayRotationMigration}\n${mediaParentMovesMigration}`;
const timestamp = "2026-07-12T00:00:00.000Z";

function runSql(sql: string): string {
  return execFileSync("sqlite3", [":memory:"], {
    encoding: "utf8",
    input: `${migration}\n${sql}`,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function migrateLegacy(beforeMigration: string, afterMigration: string): string {
  return execFileSync("sqlite3", [":memory:"], {
    encoding: "utf8",
    input: `${initialMigration}\n${beforeMigration}\n${editingMigration}\n${songWritesMigration}\n${audioDerivativesMigration}\n${audioProcessingJobsMigration}\n${recordingUploadSessionsMigration}\n${audioProcessingControlMigration}\n${audioProcessingConcurrencyMigration}\n${afterMigration}`,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function migrateScanIntegrity(beforeMigration: string, afterMigration: string): string {
  return execFileSync("sqlite3", [":memory:"], {
    encoding: "utf8",
    input: `${initialMigration}\n${editingMigration}\n${songWritesMigration}\n${audioDerivativesMigration}\n${audioProcessingJobsMigration}\n${recordingUploadSessionsMigration}\n${audioProcessingControlMigration}\n${audioProcessingConcurrencyMigration}\n${mediaReplacementsMigration}\n${nonUniqueJobsMigration}\n${audioDispatchMigration}\n${beforeMigration}\n${scanIntegrityMigration}\n${afterMigration}`,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function migrateScanRotation(beforeMigration: string, afterMigration: string): string {
  return execFileSync("sqlite3", [":memory:"], {
    encoding: "utf8",
    input: `${initialMigration}\n${editingMigration}\n${songWritesMigration}\n${audioDerivativesMigration}\n${audioProcessingJobsMigration}\n${recordingUploadSessionsMigration}\n${audioProcessingControlMigration}\n${audioProcessingConcurrencyMigration}\n${mediaReplacementsMigration}\n${nonUniqueJobsMigration}\n${audioDispatchMigration}\n${scanIntegrityMigration}\n${scanMaintenanceLeasesMigration}\n${beforeMigration}\n${scanDisplayRotationMigration}\n${afterMigration}`,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("initial database schema", () => {
  it("loads successfully", () => {
    expect(() => runSql("PRAGMA foreign_key_check;")).not.toThrow();
  });

  it("defaults existing Scan orientation to zero and constrains it to quarter turns", () => {
    const output = migrateScanRotation(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'scan-media-1', 'scans/scan-media-1.jpg', 'one.jpg', 'image/jpeg', 4,
        '${"a".repeat(64)}', 'scan', '${timestamp}', 'test'
      );
      INSERT INTO scans (
        id, song_id, media_id, created_at, created_by, updated_at, updated_by
      ) VALUES ('scan-1', 'song-1', 'scan-media-1', '${timestamp}', 'test', '${timestamp}', 'test');
    `, `
      SELECT rotation_quarter_turns FROM scans WHERE id = 'scan-1';
      UPDATE scans SET rotation_quarter_turns = 3 WHERE id = 'scan-1';
      SELECT rotation_quarter_turns FROM scans WHERE id = 'scan-1';
    `);
    expect(output).toBe("0\n3\n");

    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'scan-media-1', 'scans/scan-media-1.jpg', 'one.jpg', 'image/jpeg', 4,
        '${"a".repeat(64)}', 'scan', '${timestamp}', 'test'
      );
      INSERT INTO scans (
        id, song_id, media_id, rotation_quarter_turns,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'scan-1', 'song-1', 'scan-media-1', 4,
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
    `)).toThrow(/CHECK constraint failed/);
  });

  it("moves only trashed Scans and Recordings to active Songs and records immutable audits", () => {
    const later = "2026-07-12T01:00:00.000Z";
    const output = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES
        ('song-1', 'Source', 'source', 'draft', '${timestamp}', 'test', '${timestamp}', 'test'),
        ('song-2', 'Target', 'target', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES
        ('scan-media-1', 'scans/scan-1.jpg', 'scan.jpg', 4, '${"a".repeat(64)}', 'scan', '${timestamp}', 'test'),
        ('recording-media-1', 'recordings/recording-1', 'recording.wav', 4, '${"b".repeat(64)}', 'original_audio', '${timestamp}', 'test');
      INSERT INTO scans (
        id, song_id, media_id, revision, created_at, created_by, updated_at, updated_by
      ) VALUES ('scan-1', 'song-1', 'scan-media-1', 1, '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO recordings (
        id, song_id, original_media_id, description, normalized_description,
        processing_state, revision, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-1', 'song-1', 'recording-media-1', 'Take one', 'take one',
        'ready', 1, '${timestamp}', 'test', '${timestamp}', 'test'
      );
      UPDATE scans SET trashed_at = '${timestamp}', trashed_by = 'test', revision = 2 WHERE id = 'scan-1';
      UPDATE recordings SET trashed_at = '${timestamp}', trashed_by = 'test', revision = 2 WHERE id = 'recording-1';
      UPDATE media_objects SET state = 'trashed', trashed_at = '${timestamp}', trashed_by = 'test';
      UPDATE scans
      SET song_id = 'song-2', trashed_at = NULL, trashed_by = NULL,
          revision = 3, updated_at = '${later}', updated_by = 'editor'
      WHERE id = 'scan-1';
      UPDATE recordings
      SET song_id = 'song-2', trashed_at = NULL, trashed_by = NULL,
          revision = 3, updated_at = '${later}', updated_by = 'editor'
      WHERE id = 'recording-1';
      SELECT scan_id || '|' || from_song_id || '|' || to_song_id || '|' || moved_by
      FROM media_parent_moves WHERE scan_id = 'scan-1';
      SELECT recording_id || '|' || from_song_id || '|' || to_song_id || '|' || moved_by
      FROM media_parent_moves WHERE recording_id = 'recording-1';
      PRAGMA foreign_key_check;
    `);
    expect(output).toBe(
      "scan-1|song-1|song-2|editor\nrecording-1|song-1|song-2|editor\n",
    );

    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES
        ('song-1', 'Source', 'source', 'draft', '${timestamp}', 'test', '${timestamp}', 'test'),
        ('song-2', 'Target', 'target', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES ('scan-media-1', 'scans/scan-1.jpg', 'scan.jpg', 4, '${"a".repeat(64)}', 'scan', '${timestamp}', 'test');
      INSERT INTO scans (
        id, song_id, media_id, created_at, created_by, updated_at, updated_by
      ) VALUES ('scan-1', 'song-1', 'scan-media-1', '${timestamp}', 'test', '${timestamp}', 'test');
      UPDATE scans
      SET song_id = 'song-2', revision = 2, updated_at = '${later}', updated_by = 'editor'
      WHERE id = 'scan-1';
    `)).toThrow(/invalid_scan_parent_move/);

    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES
        ('song-1', 'Source', 'source', 'draft', '${timestamp}', 'test', '${timestamp}', 'test'),
        ('song-2', 'Target', 'target', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_parent_moves (
        id, scan_id, from_song_id, to_song_id, moved_at, moved_by
      ) VALUES ('move-1', 'missing', 'song-1', 'song-2', '${timestamp}', 'test');
    `)).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("enforces durable Recording upload session, credit, and exact part relationships", () => {
    const output = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO people (
        id, full_name, normalized_name, created_at, updated_at
      ) VALUES ('person-1', 'Contributor', 'contributor', '${timestamp}', '${timestamp}');
      INSERT INTO recording_upload_sessions (
        id, song_id, client_mutation_id, request_fingerprint,
        original_filename, byte_size, part_size, part_count, object_key,
        status, revision, expires_at, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'upload-1', 'song-1', 'mutation-1', '${"a".repeat(64)}',
        'recording.bin', 8388609, 8388608, 2, 'recordings/original/upload-1',
        'creating', 1, '2026-07-13T00:00:00.000Z', '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO recording_upload_credits (session_id, person_id, role, sort_order)
      VALUES ('upload-1', 'person-1', 'vocals', 0);
      UPDATE recording_upload_sessions
      SET r2_upload_id = 'multipart-1', status = 'open', revision = 2
      WHERE id = 'upload-1';
      INSERT INTO recording_upload_parts (
        session_id, part_number, etag, byte_size, uploaded_at, uploaded_by
      ) VALUES
        ('upload-1', 1, 'etag-1', 8388608, '${timestamp}', 'test'),
        ('upload-1', 2, 'etag-2', 1, '${timestamp}', 'test');
      UPDATE recording_upload_sessions
      SET revision = 3, updated_at = '2026-07-12T00:00:01.000Z', updated_by = 'test'
      WHERE id = 'upload-1' AND revision = 2;
      INSERT INTO recording_upload_parts (
        session_id, part_number, etag, byte_size, uploaded_at, uploaded_by
      )
      SELECT 'upload-1', 1, 'etag-1-retry', 8388608, '2026-07-12T00:00:01.000Z', 'test'
      WHERE EXISTS (
        SELECT 1 FROM recording_upload_sessions
        WHERE id = 'upload-1' AND status = 'open' AND revision = 3
      )
      ON CONFLICT(session_id, part_number) DO UPDATE SET
        etag = excluded.etag,
        byte_size = excluded.byte_size,
        uploaded_at = excluded.uploaded_at,
        uploaded_by = excluded.uploaded_by;
      SELECT status || '|' || revision || '|' || (
        SELECT COUNT(*) FROM recording_upload_parts WHERE session_id = 'upload-1'
      ) || '|' || (
        SELECT etag FROM recording_upload_parts
        WHERE session_id = 'upload-1' AND part_number = 1
      ) FROM recording_upload_sessions WHERE id = 'upload-1';
    `);
    expect(output).toBe("open|3|2|etag-1-retry\n");

    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO recording_upload_sessions (
        id, song_id, client_mutation_id, request_fingerprint,
        original_filename, byte_size, part_size, part_count, object_key,
        status, revision, expires_at, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'upload-1', 'song-1', 'mutation-1', '${"a".repeat(64)}',
        'recording.bin', 8388609, 8388608, 2, 'recordings/original/upload-1',
        'creating', 1, '2026-07-13T00:00:00.000Z', '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO recording_upload_intents (
        session_id, intent_kind, target_recording_id,
        target_recording_revision, created_at, created_by
      ) VALUES ('upload-1', 'create', NULL, NULL, '${timestamp}', 'test');
      UPDATE recording_upload_sessions
      SET r2_upload_id = 'multipart-1', status = 'open', revision = 2
      WHERE id = 'upload-1';
      INSERT INTO recording_upload_parts (
        session_id, part_number, etag, byte_size, uploaded_at, uploaded_by
      ) VALUES ('upload-1', 2, 'etag-2', 2, '${timestamp}', 'test');
    `)).toThrow(/invalid_recording_upload_part/);
  });

  it("blocks Song Trash during a live Recording upload and permits it after abort", () => {
    const output = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO recording_upload_sessions (
        id, song_id, client_mutation_id, request_fingerprint,
        original_filename, byte_size, part_size, part_count, object_key,
        status, revision, expires_at, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'upload-1', 'song-1', 'mutation-1', '${"a".repeat(64)}',
        'recording.bin', 1, 8388608, 1, 'recordings/original/upload-1',
        'creating', 1, '2026-07-13T00:00:00.000Z', '${timestamp}', 'test', '${timestamp}', 'test'
      );
      UPDATE recording_upload_sessions SET status = 'aborted', revision = 2 WHERE id = 'upload-1';
      UPDATE songs SET trashed_at = '${timestamp}', trashed_by = 'test' WHERE id = 'song-1';
      SELECT CASE WHEN trashed_at IS NOT NULL THEN 'trashed' ELSE 'active' END FROM songs;
    `);
    expect(output).toBe("trashed\n");

    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO recording_upload_sessions (
        id, song_id, client_mutation_id, request_fingerprint,
        original_filename, byte_size, part_size, part_count, object_key,
        status, revision, expires_at, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'upload-1', 'song-1', 'mutation-1', '${"a".repeat(64)}',
        'recording.bin', 1, 8388608, 1, 'recordings/original/upload-1',
        'creating', 1, '2026-07-13T00:00:00.000Z', '${timestamp}', 'test', '${timestamp}', 'test'
      );
      UPDATE songs SET trashed_at = '${timestamp}', trashed_by = 'test' WHERE id = 'song-1';
    `)).toThrow(/song_has_active_recording_upload/);
  });

  it("binds duplicate and finalized uploads to the exact original fingerprint", () => {
    const output = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO recording_upload_sessions (
        id, song_id, client_mutation_id, request_fingerprint,
        original_filename, byte_size, part_size, part_count, object_key,
        status, revision, expires_at, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'upload-1', 'song-1', 'mutation-1', '${"a".repeat(64)}',
        'recording.bin', 1, 8388608, 1, 'recordings/original/upload-1',
        'creating', 1, '2026-07-13T00:00:00.000Z', '${timestamp}', 'test', '${timestamp}', 'test'
      );
      UPDATE recording_upload_sessions
      SET r2_upload_id = 'multipart-1', status = 'open', revision = 2
      WHERE id = 'upload-1';
      UPDATE recording_upload_sessions SET status = 'completing', revision = 3 WHERE id = 'upload-1';
      UPDATE recording_upload_sessions
      SET status = 'stored', sha256 = '${"b".repeat(64)}', revision = 4
      WHERE id = 'upload-1';
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'media-existing', 'recordings/existing/original', 'existing.bin', 1,
        '${"b".repeat(64)}', 'original_audio', '${timestamp}', 'test'
      );
      INSERT INTO recordings (
        id, song_id, original_media_id, description, normalized_description,
        processing_state, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-existing', 'song-1', 'media-existing', 'Existing', 'existing',
        'ready', '${timestamp}', 'test', '${timestamp}', 'test'
      );
      UPDATE recording_upload_sessions
      SET status = 'duplicate', duplicate_media_id = 'media-existing', revision = 5
      WHERE id = 'upload-1';
      SELECT status || '|' || duplicate_media_id FROM recording_upload_sessions WHERE id = 'upload-1';
    `);
    expect(output).toBe("duplicate|media-existing\n");

    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO recording_upload_sessions (
        id, song_id, client_mutation_id, request_fingerprint,
        original_filename, byte_size, part_size, part_count, object_key,
        status, revision, expires_at, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'upload-1', 'song-1', 'mutation-1', '${"a".repeat(64)}',
        'recording.bin', 1, 8388608, 1, 'recordings/original/upload-1',
        'creating', 1, '2026-07-13T00:00:00.000Z', '${timestamp}', 'test', '${timestamp}', 'test'
      );
      UPDATE recording_upload_sessions
      SET r2_upload_id = 'multipart-1', status = 'open', revision = 2
      WHERE id = 'upload-1';
      UPDATE recording_upload_sessions SET status = 'completing', revision = 3 WHERE id = 'upload-1';
      UPDATE recording_upload_sessions
      SET status = 'stored', sha256 = '${"b".repeat(64)}', revision = 4
      WHERE id = 'upload-1';
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'media-wrong', 'recordings/wrong/original', 'wrong.bin', 1,
        '${"c".repeat(64)}', 'original_audio', '${timestamp}', 'test'
      );
      UPDATE recording_upload_sessions
      SET status = 'duplicate', duplicate_media_id = 'media-wrong', revision = 5
      WHERE id = 'upload-1';
    `)).toThrow(/invalid_recording_upload_duplicate/);

    const finalized = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO recording_upload_sessions (
        id, song_id, client_mutation_id, request_fingerprint,
        original_filename, byte_size, part_size, part_count, object_key,
        status, revision, expires_at, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'upload-1', 'song-1', 'mutation-1', '${"a".repeat(64)}',
        'recording.bin', 1, 8388608, 1, 'recordings/original/upload-1',
        'creating', 1, '2026-07-13T00:00:00.000Z', '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO recording_upload_intents (
        session_id, intent_kind, target_recording_id,
        target_recording_revision, created_at, created_by
      ) VALUES ('upload-1', 'create', NULL, NULL, '${timestamp}', 'test');
      UPDATE recording_upload_sessions
      SET r2_upload_id = 'multipart-1', status = 'open', revision = 2
      WHERE id = 'upload-1';
      UPDATE recording_upload_sessions SET status = 'completing', revision = 3 WHERE id = 'upload-1';
      UPDATE recording_upload_sessions
      SET status = 'stored', sha256 = '${"b".repeat(64)}', revision = 4
      WHERE id = 'upload-1';
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'media-1', 'recordings/original/upload-1', 'recording.bin', 1,
        '${"b".repeat(64)}', 'original_audio', '${timestamp}', 'test'
      );
      INSERT INTO recordings (
        id, song_id, original_media_id, description, normalized_description,
        processing_state, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-1', 'song-1', 'media-1', 'Recording', 'recording',
        'processing', '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO audio_processing_jobs (
        id, recording_id, source_media_id, source_sha256, source_byte_size,
        policy_id, status, created_at, updated_at
      ) VALUES (
        'job-1', 'recording-1', 'media-1', '${"b".repeat(64)}', 1,
        'mp3-v1-libmp3lame-q2', 'pending', '${timestamp}', '${timestamp}'
      );
      UPDATE recording_upload_sessions
      SET status = 'finalized', recording_id = 'recording-1', revision = 5
      WHERE id = 'upload-1';
      SELECT status || '|' || recording_id FROM recording_upload_sessions WHERE id = 'upload-1';
    `);
    expect(finalized).toBe("finalized|recording-1\n");
  });

  it("creates a durable pending audio job only for its active fingerprinted original", () => {
    const output = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'media-1', 'recordings/new/original', 'recording.bin', 100,
        '${"a".repeat(64)}', 'original_audio', '${timestamp}', 'test'
      );
      INSERT INTO recordings (
        id, song_id, original_media_id, description, normalized_description,
        processing_state, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-1', 'song-1', 'media-1', 'Recording 1', 'recording 1',
        'processing', '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO audio_processing_jobs (
        id, recording_id, source_media_id, source_sha256, source_byte_size,
        policy_id, status, created_at, updated_at
      ) VALUES (
        'job-1', 'recording-1', 'media-1', '${"a".repeat(64)}', 100,
        'mp3-v1-libmp3lame-q2',
        'pending', '${timestamp}', '${timestamp}'
      );
      SELECT status || '|' || attempt_count FROM audio_processing_jobs;
    `);
    expect(output).toBe("pending|0\n");
  });

  it("rejects an audio job for an unrelated or unfingerprinted original", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, kind, created_at, created_by
      ) VALUES ('media-1', 'recordings/new/original', 'recording.bin', 100, 'original_audio', '${timestamp}', 'test');
      INSERT INTO recordings (
        id, song_id, original_media_id, description, normalized_description,
        processing_state, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-1', 'song-1', 'media-1', 'Recording 1', 'recording 1',
        'processing', '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO audio_processing_jobs (
        id, recording_id, source_media_id, source_sha256, source_byte_size,
        policy_id, status, created_at, updated_at
      ) VALUES (
        'job-1', 'recording-1', 'media-1', '${"a".repeat(64)}', 100,
        'mp3-v1-libmp3lame-q2',
        'pending', '${timestamp}', '${timestamp}'
      );
    `)).toThrow(/invalid_audio_processing_job_source/);
  });

  it("supports the leased-to-successful audio job transition", () => {
    const output = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, sha256, kind, created_at, created_by
      ) VALUES (
        'media-1', 'recordings/new/original', 'recording.bin', 100,
        '${"a".repeat(64)}', 'original_audio', '${timestamp}', 'test'
      );
      INSERT INTO recordings (
        id, song_id, original_media_id, description, normalized_description,
        processing_state, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-1', 'song-1', 'media-1', 'Recording 1', 'recording 1',
        'processing', '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO audio_processing_jobs (
        id, recording_id, source_media_id, source_sha256, source_byte_size,
        policy_id, status, created_at, updated_at
      ) VALUES (
        'job-1', 'recording-1', 'media-1', '${"a".repeat(64)}', 100,
        'mp3-v1-libmp3lame-q2',
        'pending', '${timestamp}', '${timestamp}'
      );
      UPDATE audio_processing_jobs
      SET status = 'running', attempt_count = 1,
          lease_token_hash = '${"b".repeat(64)}', lease_expires_at = '2026-07-12T00:05:00.000Z'
      WHERE id = 'job-1';
      UPDATE recordings
      SET playback_media_id = original_media_id,
          processing_state = 'ready', processing_error = NULL
      WHERE id = 'recording-1';
      UPDATE audio_processing_jobs
      SET status = 'succeeded', lease_token_hash = NULL, lease_expires_at = NULL,
          playback_kind = 'original'
      WHERE id = 'job-1';
      SELECT status || '|' || playback_kind FROM audio_processing_jobs;
    `);
    expect(output).toBe("succeeded|original\n");
  });

  it("rejects expired leases and pending retries whose exact source is not processing", () => {
    const seed = `
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, sha256, kind, created_at, created_by
      ) VALUES (
        'media-1', 'recordings/new/original', 'recording.bin', 100,
        '${"a".repeat(64)}', 'original_audio', '${timestamp}', 'test'
      );
      INSERT INTO recordings (
        id, song_id, original_media_id, description, normalized_description,
        processing_state, created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-1', 'song-1', 'media-1', 'Recording 1', 'recording 1',
        'processing', '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO audio_processing_jobs (
        id, recording_id, source_media_id, source_sha256, source_byte_size,
        policy_id, status, created_at, updated_at
      ) VALUES (
        'job-1', 'recording-1', 'media-1', '${"a".repeat(64)}', 100,
        'mp3-v1-libmp3lame-q2', 'pending', '${timestamp}', '${timestamp}'
      );
    `;
    expect(() => runSql(`${seed}
      UPDATE audio_processing_jobs
      SET status = 'running', attempt_count = 1,
          lease_token_hash = '${"b".repeat(64)}',
          lease_expires_at = '2026-07-11T23:59:00.000Z'
      WHERE id = 'job-1';
    `)).toThrow(/invalid_audio_processing_job_lease/);

    expect(() => runSql(`${seed}
      UPDATE audio_processing_jobs
      SET status = 'running', attempt_count = 1,
          lease_token_hash = '${"b".repeat(64)}',
          lease_expires_at = '2026-07-12T01:00:00.000Z'
      WHERE id = 'job-1';
      UPDATE recordings
      SET processing_state = 'failed', processing_error = 'test_failure'
      WHERE id = 'recording-1';
      UPDATE audio_processing_jobs
      SET status = 'pending', lease_token_hash = NULL, lease_expires_at = NULL,
          updated_at = '2026-07-12T02:00:00.000Z'
      WHERE id = 'job-1';
    `)).toThrow(/invalid_audio_processing_job_pending_source/);
  });

  it("enforces one global running job and bounded expired-lease recovery", () => {
    const twoJobs = `
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES
        ('song-1', 'Test One', 'test one', 'draft', '${timestamp}', 'test', '${timestamp}', 'test'),
        ('song-2', 'Test Two', 'test two', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, sha256, kind, created_at, created_by
      ) VALUES
        ('media-1', 'recordings/new/original-1', 'one.bin', 100,
         '${"a".repeat(64)}', 'original_audio', '${timestamp}', 'test'),
        ('media-2', 'recordings/new/original-2', 'two.bin', 100,
         '${"b".repeat(64)}', 'original_audio', '${timestamp}', 'test');
      INSERT INTO recordings (
        id, song_id, original_media_id, description, normalized_description,
        processing_state, created_at, created_by, updated_at, updated_by
      ) VALUES
        ('recording-1', 'song-1', 'media-1', 'Recording 1', 'recording 1',
         'processing', '${timestamp}', 'test', '${timestamp}', 'test'),
        ('recording-2', 'song-2', 'media-2', 'Recording 2', 'recording 2',
         'processing', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO audio_processing_jobs (
        id, recording_id, source_media_id, source_sha256, source_byte_size,
        policy_id, status, created_at, updated_at
      ) VALUES
        ('job-1', 'recording-1', 'media-1', '${"a".repeat(64)}', 100,
         'mp3-v1-libmp3lame-q2', 'pending', '${timestamp}', '${timestamp}'),
        ('job-2', 'recording-2', 'media-2', '${"b".repeat(64)}', 100,
         'mp3-v1-libmp3lame-q2', 'pending', '${timestamp}', '${timestamp}');
    `;

    expect(() => runSql(`${twoJobs}
      UPDATE audio_processing_jobs
      SET status = 'running', attempt_count = 1,
          lease_token_hash = '${"c".repeat(64)}',
          lease_expires_at = '2026-07-12T01:00:00.000Z',
          updated_at = '2026-07-12T00:01:00.000Z'
      WHERE id = 'job-1';
      UPDATE audio_processing_jobs
      SET status = 'running', attempt_count = 1,
          lease_token_hash = '${"d".repeat(64)}',
          lease_expires_at = '2026-07-12T01:00:00.000Z',
          updated_at = '2026-07-12T00:01:00.000Z'
      WHERE id = 'job-2';
    `)).toThrow(/UNIQUE constraint failed: audio_processing_jobs.status/);

    expect(() => runSql(`${twoJobs}
      UPDATE audio_processing_jobs
      SET status = 'running', attempt_count = 1,
          lease_token_hash = '${"c".repeat(64)}',
          lease_expires_at = '2026-07-12T01:00:00.000Z',
          updated_at = '2026-07-12T00:01:00.000Z'
      WHERE id = 'job-1';
      UPDATE audio_processing_jobs
      SET status = 'pending', lease_token_hash = NULL, lease_expires_at = NULL,
          updated_at = '2026-07-12T00:30:00.000Z'
      WHERE id = 'job-1';
    `)).toThrow(/invalid_audio_processing_job_expired_recovery/);

    expect(() => runSql(`${twoJobs}
      UPDATE audio_processing_jobs
      SET status = 'running', attempt_count = 3,
          lease_token_hash = '${"c".repeat(64)}',
          lease_expires_at = '2026-07-12T01:00:00.000Z',
          updated_at = '2026-07-12T00:01:00.000Z'
      WHERE id = 'job-1';
    `)).toThrow(/invalid_audio_processing_job_attempt/);

    const expiredRecovery = runSql(`${twoJobs}
      UPDATE audio_processing_jobs
      SET status = 'running', attempt_count = 1,
          lease_token_hash = '${"c".repeat(64)}',
          lease_expires_at = '2026-07-12T01:00:00.000Z',
          updated_at = '2026-07-12T00:01:00.000Z'
      WHERE id = 'job-1';
      UPDATE audio_processing_jobs
      SET status = 'pending', lease_token_hash = NULL, lease_expires_at = NULL,
          updated_at = '2026-07-12T01:01:00.000Z'
      WHERE id = 'job-1';
      SELECT status || '|' || attempt_count FROM audio_processing_jobs WHERE id = 'job-1';
    `);
    expect(expiredRecovery).toBe("pending|1\n");
  });

  it("losslessly transforms legacy lyrics, Recording metadata, and credit roles", () => {
    const output = migrateLegacy(`
      INSERT INTO songs (
        id, title_latin, status, created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO people (
        id, full_name, normalized_name, created_at, updated_at
      ) VALUES ('person-1', 'Writer', 'writer', '${timestamp}', '${timestamp}');
      INSERT INTO song_credits (id, song_id, person_id, role)
      VALUES ('credit-1', 'song-1', 'person-1', 'Writer');
      INSERT INTO lyric_texts (
        id, song_id, representation, content, created_at, created_by, updated_at, updated_by
      ) VALUES ('lyrics-1', 'song-1', 'legacy_combined', 'lyrics', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, kind, created_at, created_by
      ) VALUES ('media-1', 'recordings/test.mp3', 'test.mp3', 1, 'original_audio', '${timestamp}', 'test');
      INSERT INTO recordings (
        id, song_id, original_media_id, version, notes,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-1', 'song-1', 'media-1', 'Old verse', 'Different tune',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
    `, `
      SELECT origin FROM lyric_texts;
      SELECT role FROM song_credits;
      SELECT description FROM recordings;
      SELECT legacy_version || '|' || legacy_notes FROM recordings;
    `);

    expect(output).toBe("legacy_import\nlyrics\nOld verse\n\nDifferent tune\nOld verse|Different tune\n");
  });

  it("rejects orphan lyric texts", () => {
    expect(() => runSql(`
      INSERT INTO lyric_texts (
        id, song_id, content,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'lyrics-1', 'missing-song', 'text',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
    `)).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("refuses to delete a song with content", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO lyric_texts (
        id, song_id, content,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'lyrics-1', 'song-1', 'text',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
      DELETE FROM songs WHERE id = 'song-1';
    `)).toThrow(/song_has_content/);
  });

  it("allows an empty song to be removed by later admin cleanup", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      DELETE FROM songs WHERE id = 'song-1';
      SELECT CASE WHEN COUNT(*) = 0 THEN 'ok' ELSE 'failed' END FROM songs;
    `)).not.toThrow();
  });

  it("escapes private text safely in generated seed SQL", () => {
    const sql = createSeedSql({
      schemaVersion: 2,
      languages: [], tags: [], notebooks: [], people: [],
      songs: [{
        id: "song-1", titleLatin: "Singer's song", normalizedTitleLatin: "singer's song",
        titleNative: null, status: "draft",
        notes: "line one\nline two", revision: 1,
        createdAt: timestamp, createdBy: "test", updatedAt: timestamp, updatedBy: "test",
        trashedAt: null, trashedBy: null,
      }],
      songAliases: [], songLanguages: [], songTags: [], songCredits: [], lyricTexts: [],
      mediaObjects: [], scans: [], recordings: [], recordingCredits: [],
    });

    expect(() => execFileSync("sqlite3", [":memory:"], {
      encoding: "utf8",
      input: `${migration}\n${sql}`,
      stdio: ["pipe", "pipe", "pipe"],
    })).not.toThrow();
    expect(sql).toContain("Singer''s song");
  });

  it("enforces Song status and normalized active-title uniqueness", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'unknown', '${timestamp}', 'test', '${timestamp}', 'test');
    `)).toThrow(/invalid_song_values/);

    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'same', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-2', 'Same', 'same', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
    `)).toThrow(/UNIQUE constraint failed/);
  });

  it("prevents removing the last Language from an active Song", () => {
    expect(() => runSql(`
      INSERT INTO languages (id, display_name, normalized_name) VALUES ('en', 'English', 'english');
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO song_languages (song_id, language_id) VALUES ('song-1', 'en');
      DELETE FROM song_languages WHERE song_id = 'song-1' AND language_id = 'en';
    `)).toThrow(/song_requires_language/);
  });

  it("blocks normalized lookup duplicates and deletion of referenced lookup items", () => {
    expect(() => runSql(`
      INSERT INTO tags (id, display_name, normalized_name)
      VALUES ('tag-1', 'Original', 'original');
      INSERT INTO tags (id, display_name, normalized_name)
      VALUES ('tag-2', 'ORIGINAL', 'original');
    `)).toThrow(/UNIQUE constraint failed/);

    expect(() => runSql(`
      INSERT INTO tags (id, display_name, normalized_name)
      VALUES ('tag-1', 'Original', 'original');
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO song_tags (song_id, tag_id) VALUES ('song-1', 'tag-1');
      DELETE FROM tags WHERE id = 'tag-1';
    `)).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("allows one Person to hold both Song roles but rejects a duplicate role", () => {
    const output = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO people (
        id, full_name, normalized_name, created_at, updated_at
      ) VALUES ('person-1', 'Contributor', 'contributor', '${timestamp}', '${timestamp}');
      INSERT INTO song_credits (id, song_id, person_id, role, sort_order) VALUES
        ('credit-1', 'song-1', 'person-1', 'lyrics', 0),
        ('credit-2', 'song-1', 'person-1', 'music', 1);
      SELECT group_concat(role, '|') FROM (
        SELECT role FROM song_credits ORDER BY sort_order
      );
    `);
    expect(output).toBe("lyrics|music\n");

    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO people (
        id, full_name, normalized_name, created_at, updated_at
      ) VALUES ('person-1', 'Contributor', 'contributor', '${timestamp}', '${timestamp}');
      INSERT INTO song_credits (id, song_id, person_id, role)
      VALUES ('credit-1', 'song-1', 'person-1', 'lyrics');
      INSERT INTO song_credits (id, song_id, person_id, role)
      VALUES ('credit-2', 'song-1', 'person-1', 'lyrics');
    `)).toThrow(/UNIQUE constraint failed/);
  });

  it("blocks trashing a Song while active child content exists", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO lyric_texts (
        id, song_id, content, created_at, created_by, updated_at, updated_by
      ) VALUES ('lyrics-1', 'song-1', 'text', '${timestamp}', 'test', '${timestamp}', 'test');
      UPDATE songs SET trashed_at = '${timestamp}', trashed_by = 'test' WHERE id = 'song-1';
    `)).toThrow(/song_has_active_content/);
  });

  it("can trash and restore a Song without changing metadata, relationships, or child Trash state", () => {
    const output = runSql(`
      INSERT INTO languages (id, display_name, normalized_name)
      VALUES ('en', 'English', 'english');
      INSERT INTO tags (id, display_name, normalized_name)
      VALUES ('tag-1', 'Test tag', 'test tag');
      INSERT INTO people (id, full_name, normalized_name, created_at, updated_at)
      VALUES ('person-1', 'Contributor', 'contributor', '${timestamp}', '${timestamp}');
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, title_native, status, notes,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'song-1', 'Test Song', 'test song', 'Native', 'checked', 'Song note',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO song_languages (song_id, language_id) VALUES ('song-1', 'en');
      INSERT INTO song_tags (song_id, tag_id) VALUES ('song-1', 'tag-1');
      INSERT INTO song_aliases (id, song_id, alias, normalized_alias)
      VALUES ('alias-1', 'song-1', 'Old title', 'old title');
      INSERT INTO song_credits (id, song_id, person_id, role)
      VALUES ('credit-1', 'song-1', 'person-1', 'lyrics');
      INSERT INTO lyric_texts (
        id, song_id, content, created_at, created_by, updated_at, updated_by
      ) VALUES ('lyrics-1', 'song-1', 'text', '${timestamp}', 'test', '${timestamp}', 'test');
      UPDATE lyric_texts
      SET trashed_at = '${timestamp}', trashed_by = 'test', revision = revision + 1
      WHERE id = 'lyrics-1';
      UPDATE songs
      SET trashed_at = '${timestamp}', trashed_by = 'test', revision = revision + 1
      WHERE id = 'song-1';
      UPDATE songs
      SET trashed_at = NULL, trashed_by = NULL, revision = revision + 1
      WHERE id = 'song-1';
      SELECT
        songs.title_latin || '|' || songs.title_native || '|' || songs.status || '|' ||
        songs.notes || '|' || songs.revision || '|' ||
        (SELECT COUNT(*) FROM song_languages WHERE song_id = songs.id) || '|' ||
        (SELECT COUNT(*) FROM song_tags WHERE song_id = songs.id) || '|' ||
        (SELECT COUNT(*) FROM song_aliases WHERE song_id = songs.id) || '|' ||
        (SELECT COUNT(*) FROM song_credits WHERE song_id = songs.id) || '|' ||
        (SELECT CASE WHEN trashed_at IS NULL THEN 0 ELSE 1 END FROM lyric_texts WHERE song_id = songs.id)
      FROM songs WHERE id = 'song-1';
    `);

    expect(output).toBe("Test Song|Native|checked|Song note|3|1|1|1|1|1\n");
  });

  it("can trash and restore typed lyrics without changing their content", () => {
    const output = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO lyric_texts (
        id, song_id, content, created_at, created_by, updated_at, updated_by
      ) VALUES ('lyrics-1', 'song-1', 'line one' || char(10) || char(10) || 'line two', '${timestamp}', 'test', '${timestamp}', 'test');
      UPDATE lyric_texts
      SET trashed_at = '${timestamp}', trashed_by = 'test', revision = revision + 1
      WHERE id = 'lyrics-1';
      UPDATE lyric_texts
      SET trashed_at = NULL, trashed_by = NULL, revision = revision + 1
      WHERE id = 'lyrics-1';
      SELECT content || '|' || revision FROM lyric_texts WHERE id = 'lyrics-1';
    `);

    expect(output).toBe("line one\n\nline two|3\n");
  });

  it("can trash and restore a Scan and its media without changing either record", () => {
    const output = runSql(`
      INSERT INTO notebooks (id, display_name, normalized_name, sort_order)
      VALUES ('notebook-1', 'Blue notebook', 'blue notebook', 1);
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'media-1', 'scans/test.jpg', 'page.jpg', 'image/jpeg', 1234, '${"a".repeat(64)}', 'scan',
        '${timestamp}', 'test'
      );
      INSERT INTO scans (
        id, song_id, media_id, notebook_id, page_label,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'scan-1', 'song-1', 'media-1', 'notebook-1', 'Page 12',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
      UPDATE scans
      SET trashed_at = '${timestamp}', trashed_by = 'test', revision = revision + 1
      WHERE id = 'scan-1';
      UPDATE media_objects
      SET state = 'trashed', trashed_at = '${timestamp}', trashed_by = 'test'
      WHERE id = 'media-1';
      UPDATE scans
      SET trashed_at = NULL, trashed_by = NULL, revision = revision + 1
      WHERE id = 'scan-1';
      UPDATE media_objects
      SET state = 'active', trashed_at = NULL, trashed_by = NULL
      WHERE id = 'media-1';
      SELECT
        scans.notebook_id || '|' || scans.page_label || '|' || scans.revision || '|' ||
        media_objects.object_key || '|' || media_objects.original_filename || '|' ||
        media_objects.byte_size || '|' || media_objects.sha256 || '|' || media_objects.state
      FROM scans
      JOIN media_objects ON media_objects.id = scans.media_id
      WHERE scans.id = 'scan-1';
    `);

    expect(output).toBe(`notebook-1|Page 12|3|scans/test.jpg|page.jpg|1234|${"a".repeat(64)}|active\n`);
  });

  it("can trash and restore a Recording, its credits, and both private media records", () => {
    const output = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO people (
        id, full_name, normalized_name, created_at, updated_at
      ) VALUES ('person-1', 'Singer', 'singer', '${timestamp}', '${timestamp}');
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES
        ('original-1', 'recordings/original.wav', 'original.wav', 'audio/wav', 4321, 'original-hash', 'original_audio', '${timestamp}', 'test'),
        ('playback-1', 'recordings/playback.mp3', 'playback.mp3', 'audio/mpeg', 1234, 'playback-hash', 'playback_audio', '${timestamp}', 'test');
      UPDATE media_objects SET sha256 = '${"a".repeat(64)}' WHERE id = 'original-1';
      UPDATE media_objects SET sha256 = '${"b".repeat(64)}' WHERE id = 'playback-1';
      INSERT INTO audio_derivatives (
        playback_media_id, source_media_id, policy_id,
        source_sha256, source_byte_size, derivative_sha256, derivative_byte_size
      ) VALUES (
        'playback-1', 'original-1', 'test-policy',
        '${"a".repeat(64)}', 4321, '${"b".repeat(64)}', 1234
      );
      INSERT INTO recordings (
        id, song_id, original_media_id, playback_media_id,
        description, normalized_description, recorded_on,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-1', 'song-1', 'original-1', 'playback-1',
        'Old verse', 'old verse', '2020-02-29',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO recording_credits (id, recording_id, person_id, role, sort_order)
      VALUES ('credit-1', 'recording-1', 'person-1', 'vocals', 0);
      UPDATE recordings
      SET trashed_at = '${timestamp}', trashed_by = 'test', revision = revision + 1
      WHERE id = 'recording-1';
      UPDATE media_objects
      SET state = 'trashed', trashed_at = '${timestamp}', trashed_by = 'test'
      WHERE id IN ('original-1', 'playback-1');
      UPDATE recordings
      SET trashed_at = NULL, trashed_by = NULL, revision = revision + 1
      WHERE id = 'recording-1';
      UPDATE media_objects
      SET state = 'active', trashed_at = NULL, trashed_by = NULL
      WHERE id IN ('original-1', 'playback-1');
      SELECT
        recordings.description || '|' || recordings.recorded_on || '|' || recordings.revision || '|' ||
        original_media.object_key || '|' || original_media.state || '|' ||
        playback_media.object_key || '|' || playback_media.state || '|' ||
        recording_credits.role || '|' || people.full_name
      FROM recordings
      JOIN media_objects AS original_media ON original_media.id = recordings.original_media_id
      JOIN media_objects AS playback_media ON playback_media.id = recordings.playback_media_id
      JOIN recording_credits ON recording_credits.recording_id = recordings.id
      JOIN people ON people.id = recording_credits.person_id
      WHERE recordings.id = 'recording-1';
    `);

    expect(output).toBe("Old verse|2020-02-29|3|recordings/original.wav|active|recordings/playback.mp3|active|vocals|Singer\n");
  });

  it("binds a playback derivative to its verified source and policy", () => {
    const output = runSql(`
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES
        ('original-1', 'recordings/original.wav', 'original.wav', 'audio/wav', 4321, '${"a".repeat(64)}', 'original_audio', '${timestamp}', 'test'),
        ('playback-1', 'recordings/playback.mp3', 'playback.mp3', 'audio/mpeg', 1234, '${"b".repeat(64)}', 'playback_audio', '${timestamp}', 'test');
      INSERT INTO audio_derivatives (
        playback_media_id, source_media_id, policy_id,
        source_sha256, source_byte_size, derivative_sha256, derivative_byte_size
      ) VALUES (
        'playback-1', 'original-1', 'test-policy',
        '${"a".repeat(64)}', 4321, '${"b".repeat(64)}', 1234
      );
      SELECT source_media_id || '|' || policy_id FROM audio_derivatives;
    `);

    expect(output).toBe("original-1|test-policy\n");
  });

  it("rejects mismatched or mutable derivative provenance", () => {
    expect(() => runSql(`
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES
        ('original-1', 'recordings/original.wav', 'original.wav', 4321, '${"a".repeat(64)}', 'original_audio', '${timestamp}', 'test'),
        ('playback-1', 'recordings/playback.mp3', 'playback.mp3', 1234, '${"b".repeat(64)}', 'playback_audio', '${timestamp}', 'test');
      INSERT INTO audio_derivatives (
        playback_media_id, source_media_id, policy_id,
        source_sha256, source_byte_size, derivative_sha256, derivative_byte_size
      ) VALUES (
        'playback-1', 'original-1', 'test-policy',
        '${"c".repeat(64)}', 4321, '${"b".repeat(64)}', 1234
      );
    `)).toThrow(/invalid_audio_derivative_provenance/);

    expect(() => runSql(`
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES
        ('original-1', 'recordings/original.wav', 'original.wav', 4321, '${"a".repeat(64)}', 'original_audio', '${timestamp}', 'test'),
        ('playback-1', 'recordings/playback.mp3', 'playback.mp3', 1234, '${"b".repeat(64)}', 'playback_audio', '${timestamp}', 'test');
      INSERT INTO audio_derivatives (
        playback_media_id, source_media_id, policy_id,
        source_sha256, source_byte_size, derivative_sha256, derivative_byte_size
      ) VALUES (
        'playback-1', 'original-1', 'test-policy',
        '${"a".repeat(64)}', 4321, '${"b".repeat(64)}', 1234
      );
      UPDATE media_objects SET byte_size = 4322 WHERE id = 'original-1';
    `)).toThrow(/media_is_bound_to_derivative_provenance/);
  });

  it("rejects a Recording playback source without matching provenance", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES
        ('original-1', 'recordings/original.wav', 'original.wav', 4321, '${"a".repeat(64)}', 'original_audio', '${timestamp}', 'test'),
        ('playback-1', 'recordings/playback.mp3', 'playback.mp3', 1234, '${"b".repeat(64)}', 'playback_audio', '${timestamp}', 'test');
      INSERT INTO recordings (
        id, song_id, original_media_id, playback_media_id,
        description, normalized_description,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-1', 'song-1', 'original-1', 'playback-1',
        'Test recording', 'test recording',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
    `)).toThrow(/invalid_recording_audio_relationship/);
  });

  it("retains derivative provenance while a Recording uses it", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES
        ('original-1', 'recordings/original.wav', 'original.wav', 4321, '${"a".repeat(64)}', 'original_audio', '${timestamp}', 'test'),
        ('playback-1', 'recordings/playback.mp3', 'playback.mp3', 1234, '${"b".repeat(64)}', 'playback_audio', '${timestamp}', 'test');
      INSERT INTO audio_derivatives (
        playback_media_id, source_media_id, policy_id,
        source_sha256, source_byte_size, derivative_sha256, derivative_byte_size
      ) VALUES (
        'playback-1', 'original-1', 'test-policy',
        '${"a".repeat(64)}', 4321, '${"b".repeat(64)}', 1234
      );
      INSERT INTO recordings (
        id, song_id, original_media_id, playback_media_id,
        description, normalized_description,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-1', 'song-1', 'original-1', 'playback-1',
        'Test recording', 'test recording',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
      DELETE FROM audio_derivatives WHERE playback_media_id = 'playback-1';
    `)).toThrow(/audio_derivative_is_in_use/);
  });

  it("rejects restoring typed lyrics when identical active content now exists", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO lyric_texts (
        id, song_id, content, created_at, created_by, updated_at, updated_by
      ) VALUES ('lyrics-1', 'song-1', 'same text', '${timestamp}', 'test', '${timestamp}', 'test');
      UPDATE lyric_texts
      SET trashed_at = '${timestamp}', trashed_by = 'test'
      WHERE id = 'lyrics-1';
      INSERT INTO lyric_texts (
        id, song_id, content, created_at, created_by, updated_at, updated_by
      ) VALUES ('lyrics-2', 'song-1', 'same text', '${timestamp}', 'test', '${timestamp}', 'test');
      UPDATE lyric_texts
      SET trashed_at = NULL, trashed_by = NULL
      WHERE id = 'lyrics-1';
    `)).toThrow(/UNIQUE constraint failed/);
  });

  it("allows replacing a Scan media and tracking its history", () => {
    const output = runSql(`
      INSERT INTO notebooks (id, display_name, normalized_name, sort_order)
      VALUES ('notebook-1', 'Blue notebook', 'blue notebook', 1);
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'media-1', 'scans/test.jpg', 'page.jpg', 'image/jpeg', 1234, '${"a".repeat(64)}', 'scan',
        '${timestamp}', 'test'
      );
      INSERT INTO scans (
        id, song_id, media_id, notebook_id, page_label,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'scan-1', 'song-1', 'media-1', 'notebook-1', '1',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'media-2', 'scans/test2.jpg', 'page2.jpg', 'image/jpeg', 2345, '${"b".repeat(64)}', 'scan',
        '${timestamp}', 'test'
      );
      INSERT INTO scan_media_history (
        id, scan_id, media_id, replaced_at, replaced_by, revision_at_replacement
      ) VALUES (
        'history-1', 'scan-1', 'media-1', '${timestamp}', 'test', 1
      );
      UPDATE scans SET media_id = 'media-2', revision = 2 WHERE id = 'scan-1';
      SELECT count(*) FROM scan_media_history;
    `);
    expect(output).toBe("1\n");
  });

  it("allows replacing a Recording media and tracking its history", () => {
    const output = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'media-1', 'recordings/test.mp3', 'test.mp3', 'audio/mpeg', 1234, 'hash-1', 'original_audio',
        '${timestamp}', 'test'
      );
      INSERT INTO recordings (
        id, song_id, original_media_id, playback_media_id, description, normalized_description, processing_state,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-1', 'song-1', 'media-1', 'media-1', 'Test recording', 'test recording', 'ready',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'media-2', 'recordings/test2.mp3', 'test2.mp3', 'audio/mpeg', 2345, 'hash-2', 'original_audio',
        '${timestamp}', 'test'
      );
      INSERT INTO recording_media_history (
        id, recording_id, original_media_id, playback_media_id, replaced_at, replaced_by, revision_at_replacement
      ) VALUES (
        'history-1', 'recording-1', 'media-1', 'media-1', '${timestamp}', 'test', 1
      );
      UPDATE recordings SET original_media_id = 'media-2', playback_media_id = NULL, revision = 2, processing_state = 'processing' WHERE id = 'recording-1';
      SELECT count(*) FROM recording_media_history;
    `);
    expect(output).toBe("1\n");
  });

  it("enforces race-safe global Scan fingerprints for new writes", () => {
    expect(() => runSql(`
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'scan-media-1', 'scans/scan-media-1.jpg', 'one.jpg', 'image/jpeg', 4,
        '${"a".repeat(64)}', 'scan', '${timestamp}', 'test'
      );
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'scan-media-2', 'scans/scan-media-2.jpg', 'two.jpg', 'image/jpeg', 4,
        '${"a".repeat(64)}', 'scan', '${timestamp}', 'test'
      );
    `)).toThrow(/duplicate_or_invalid_scan_fingerprint/);
  });

  it("preserves and marks historical Scan duplicates during null-hash backfill", () => {
    const output = migrateScanIntegrity(`
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES
        ('scan-media-1', 'scans/legacy-1.jpg', 'one.jpg', 'image/jpeg', 4, NULL, 'scan', '${timestamp}', 'import'),
        ('scan-media-2', 'scans/legacy-2.jpg', 'two.jpg', 'image/jpeg', 4, NULL, 'scan', '${timestamp}', 'import');
    `, `
      UPDATE media_objects SET sha256 = '${"a".repeat(64)}' WHERE id = 'scan-media-1';
      UPDATE media_objects SET sha256 = '${"a".repeat(64)}' WHERE id = 'scan-media-2';
      SELECT
        (SELECT count(*) FROM scan_fingerprints) || '|' ||
        (SELECT count(*) FROM scan_fingerprint_members) || '|' ||
        (SELECT sum(is_historical_duplicate) FROM scan_fingerprint_members);
    `);
    expect(output).toBe("1|2|1\n");
  });

  it("leases Scan maintenance atomically and permits only an expired lease takeover", () => {
    const output = runSql(`
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'scan-media-1', 'scans/scan-media-1.jpg', 'one.jpg', 'image/jpeg', 4,
        '${"a".repeat(64)}', 'scan', '${timestamp}', 'test'
      );
      INSERT INTO scan_maintenance_leases (
        media_id, lease_token, leased_at, lease_expires_at
      ) VALUES (
        'scan-media-1', '${"l".repeat(32)}', '${timestamp}', '2026-07-12T00:10:00.000Z'
      );
      INSERT INTO scan_maintenance_leases (
        media_id, lease_token, leased_at, lease_expires_at
      ) VALUES (
        'scan-media-1', '${"m".repeat(32)}', '2026-07-12T00:05:00.000Z', '2026-07-12T00:15:00.000Z'
      )
      ON CONFLICT(media_id) DO UPDATE SET
        lease_token = excluded.lease_token,
        leased_at = excluded.leased_at,
        lease_expires_at = excluded.lease_expires_at
      WHERE scan_maintenance_leases.lease_expires_at <= excluded.leased_at;
      SELECT lease_token FROM scan_maintenance_leases;
      INSERT INTO scan_maintenance_leases (
        media_id, lease_token, leased_at, lease_expires_at
      ) VALUES (
        'scan-media-1', '${"n".repeat(32)}', '2026-07-12T00:10:00.000Z', '2026-07-12T00:20:00.000Z'
      )
      ON CONFLICT(media_id) DO UPDATE SET
        lease_token = excluded.lease_token,
        leased_at = excluded.leased_at,
        lease_expires_at = excluded.lease_expires_at
      WHERE scan_maintenance_leases.lease_expires_at <= excluded.leased_at;
      SELECT lease_token FROM scan_maintenance_leases;
    `);
    expect(output).toBe(`${"l".repeat(32)}\n${"n".repeat(32)}\n`);
  });

  it("promotes a historical Scan fingerprint member consistently", () => {
    const output = runSql(`
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'scan-media-1', 'scans/legacy-1.jpg', 'one.jpg', 'image/jpeg', 4,
        '${"a".repeat(64)}', 'scan', '${timestamp}', 'test'
      );
      DROP TRIGGER validate_new_scan_fingerprint;
      DROP TRIGGER register_new_scan_fingerprint;
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'scan-media-2', 'scans/legacy-2.jpg', 'two.jpg', 'image/jpeg', 4,
        '${"a".repeat(64)}', 'scan', '${timestamp}', 'import'
      );
      INSERT INTO scan_fingerprint_members (
        media_id, sha256, is_historical_duplicate, registered_at
      ) VALUES ('scan-media-2', '${"a".repeat(64)}', 1, '${timestamp}');
      DELETE FROM media_objects WHERE id = 'scan-media-1';
      SELECT
        (SELECT canonical_media_id FROM scan_fingerprints WHERE sha256 = '${"a".repeat(64)}') || '|' ||
        (SELECT is_historical_duplicate FROM scan_fingerprint_members WHERE media_id = 'scan-media-2');
    `);
    expect(output).toBe("scan-media-2|0\n");
  });

  it("binds immutable readability provenance to the exact Scan source", () => {
    expect(() => runSql(`
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'scan-media-1', 'scans/scan-media-1.jpg', 'one.jpg', 'image/jpeg', 4,
        '${"a".repeat(64)}', 'scan', '${timestamp}', 'test'
      );
      INSERT INTO scan_readability_derivatives (
        source_media_id, source_sha256, source_byte_size, object_key,
        mime_type, byte_size, sha256, width, height, policy_id,
        created_at, created_by
      ) VALUES (
        'scan-media-1', '${"a".repeat(64)}', 4, 'scans/readability/scan-media-1.jpg',
        'image/jpeg', 3, '${"b".repeat(64)}', 1200, 900,
        'scan-jpeg-v1-2400-q85', '${timestamp}', 'test'
      );
      UPDATE media_objects SET byte_size = 5 WHERE id = 'scan-media-1';
    `)).toThrow(/media_is_bound_to_scan_readability_provenance/);

    expect(() => runSql(`
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'scan-media-1', 'scans/scan-media-1.jpg', 'one.jpg', 'image/jpeg', 4,
        '${"a".repeat(64)}', 'scan', '${timestamp}', 'test'
      );
      INSERT INTO scan_readability_derivatives (
        source_media_id, source_sha256, source_byte_size, object_key,
        mime_type, byte_size, sha256, width, height, policy_id,
        created_at, created_by
      ) VALUES (
        'scan-media-1', '${"a".repeat(64)}', 4, 'scans/readability/scan-media-1.jpg',
        'image/jpeg', 3, '${"b".repeat(64)}', 1200, 900,
        'scan-jpeg-v1-2400-q85', '${timestamp}', 'test'
      );
      UPDATE scan_readability_derivatives SET width = 1199 WHERE source_media_id = 'scan-media-1';
    `)).toThrow(/scan_readability_provenance_is_immutable/);
  });
});
