PRAGMA foreign_keys = OFF;

-- 1. Drop triggers on other tables referencing audio_processing_jobs
DROP TRIGGER IF EXISTS prevent_recording_trash_with_active_audio_job;
DROP TRIGGER IF EXISTS validate_recording_upload_finalized;

-- 2. Create the rebuilt table without UNIQUE on recording_id
CREATE TABLE audio_processing_jobs_v2 (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL
    REFERENCES recordings(id) ON DELETE RESTRICT,
  source_media_id TEXT NOT NULL
    REFERENCES media_objects(id) ON DELETE RESTRICT,
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64
    AND source_sha256 = lower(source_sha256)
    AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_byte_size INTEGER NOT NULL CHECK (source_byte_size > 0),
  policy_id TEXT NOT NULL CHECK (length(trim(policy_id)) > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token_hash TEXT,
  lease_expires_at TEXT,
  playback_kind TEXT CHECK (playback_kind IN ('original', 'derivative')),
  derivative_media_id TEXT REFERENCES media_objects(id) ON DELETE RESTRICT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'pending'
      AND lease_token_hash IS NULL AND lease_expires_at IS NULL
      AND playback_kind IS NULL AND derivative_media_id IS NULL AND error_code IS NULL)
    OR (status = 'running'
      AND length(lease_token_hash) = 64 AND lease_token_hash = lower(lease_token_hash) AND lease_token_hash NOT GLOB '*[^0-9a-f]*'
      AND lease_expires_at IS NOT NULL
      AND playback_kind IS NULL AND derivative_media_id IS NULL AND error_code IS NULL)
    OR (status = 'succeeded'
      AND lease_token_hash IS NULL AND lease_expires_at IS NULL
      AND playback_kind IS NOT NULL
      AND (
        (playback_kind = 'original' AND derivative_media_id IS NULL)
        OR (playback_kind = 'derivative' AND derivative_media_id IS NOT NULL)
      )
      AND error_code IS NULL)
    OR (status = 'failed'
      AND lease_token_hash IS NULL AND lease_expires_at IS NULL
      AND playback_kind IS NULL AND derivative_media_id IS NULL
      AND error_code IS NOT NULL)
  ),
  CHECK (lease_expires_at > created_at)
);

INSERT INTO audio_processing_jobs_v2 SELECT * FROM audio_processing_jobs;

DROP TABLE audio_processing_jobs;

ALTER TABLE audio_processing_jobs_v2 RENAME TO audio_processing_jobs;

-- 3. Re-create indexes
CREATE INDEX audio_processing_jobs_recording_idx ON audio_processing_jobs(recording_id);
CREATE INDEX audio_processing_jobs_status_idx ON audio_processing_jobs(status, updated_at);
CREATE UNIQUE INDEX audio_processing_jobs_single_running_idx ON audio_processing_jobs(status) WHERE status = 'running';

-- 4. Re-create triggers on audio_processing_jobs

-- Triggers from 0005_audio_processing_jobs.sql
CREATE TRIGGER validate_audio_processing_job_insert
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

CREATE TRIGGER prevent_audio_processing_job_identity_change
BEFORE UPDATE OF id, recording_id, source_media_id, source_sha256, source_byte_size, policy_id, created_at ON audio_processing_jobs
BEGIN
  SELECT RAISE(ABORT, 'audio_processing_job_identity_is_immutable');
END;

CREATE TRIGGER validate_audio_processing_job_status_transition
BEFORE UPDATE OF status ON audio_processing_jobs
WHEN NEW.status <> OLD.status
  AND NOT (
    (OLD.status = 'pending' AND NEW.status = 'running')
    OR (OLD.status = 'running' AND NEW.status IN ('pending', 'succeeded', 'failed'))
    OR (OLD.status = 'failed' AND NEW.status = 'pending')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_processing_job_transition');
END;

CREATE TRIGGER prevent_audio_processing_job_delete
BEFORE DELETE ON audio_processing_jobs
BEGIN
  SELECT RAISE(ABORT, 'audio_processing_job_is_retained');
END;

-- Triggers from 0006_recording_upload_sessions.sql
CREATE TRIGGER validate_audio_processing_job_initial_attempt
BEFORE INSERT ON audio_processing_jobs
WHEN NEW.status <> 'pending' OR NEW.attempt_count <> 0
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_processing_job_attempt');
END;

CREATE TRIGGER validate_audio_processing_job_attempt_update
BEFORE UPDATE OF status, attempt_count ON audio_processing_jobs
WHEN NOT (
    (OLD.status = NEW.status AND OLD.attempt_count = NEW.attempt_count)
    OR (OLD.status = 'pending' AND NEW.status = 'running' AND NEW.attempt_count = OLD.attempt_count + 1)
    OR (OLD.status = 'running' AND NEW.status IN ('pending', 'succeeded', 'failed') AND NEW.attempt_count = OLD.attempt_count)
    OR (OLD.status = 'failed' AND NEW.status = 'pending' AND NEW.attempt_count = OLD.attempt_count)
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_processing_job_attempt');
END;

CREATE TRIGGER validate_audio_processing_error_code_insert
BEFORE INSERT ON audio_processing_jobs
WHEN NEW.error_code IS NOT NULL AND (
  length(NEW.error_code) > 100
  OR substr(NEW.error_code, 1, 1) NOT GLOB '[a-z]'
  OR NEW.error_code GLOB '*[^a-z0-9_]*'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_processing_error_code');
END;

CREATE TRIGGER validate_audio_processing_error_code_update
BEFORE UPDATE OF error_code ON audio_processing_jobs
WHEN NEW.error_code IS NOT NULL AND (
  length(NEW.error_code) > 100
  OR substr(NEW.error_code, 1, 1) NOT GLOB '[a-z]'
  OR NEW.error_code GLOB '*[^a-z0-9_]*'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_processing_error_code');
END;

CREATE TRIGGER validate_audio_processing_job_running
BEFORE UPDATE OF status ON audio_processing_jobs
WHEN NEW.status = 'running' AND NOT EXISTS (
  SELECT 1 FROM recordings
  JOIN media_objects ON media_objects.id = recordings.original_media_id
  WHERE recordings.id = NEW.recording_id
    AND recordings.trashed_at IS NULL
    AND recordings.processing_state = 'processing'
    AND recordings.processing_error IS NULL
    AND media_objects.id = NEW.source_media_id
    AND media_objects.kind = 'original_audio'
    AND media_objects.state = 'active'
    AND media_objects.sha256 = NEW.source_sha256
    AND media_objects.byte_size = NEW.source_byte_size
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_processing_job_source');
END;

CREATE TRIGGER validate_audio_processing_job_succeeded
BEFORE UPDATE OF status ON audio_processing_jobs
WHEN NEW.status = 'succeeded' AND NOT EXISTS (
  SELECT 1 FROM recordings
  WHERE recordings.id = NEW.recording_id
    AND recordings.trashed_at IS NULL
    AND recordings.processing_state = 'ready'
    AND recordings.processing_error IS NULL
    AND recordings.original_media_id = NEW.source_media_id
    AND (
      (NEW.playback_kind = 'original'
        AND NEW.derivative_media_id IS NULL
        AND recordings.playback_media_id = NEW.source_media_id)
      OR (NEW.playback_kind = 'derivative'
        AND recordings.playback_media_id = NEW.derivative_media_id
        AND EXISTS (
          SELECT 1 FROM audio_derivatives
          WHERE playback_media_id = NEW.derivative_media_id
            AND source_media_id = NEW.source_media_id
            AND policy_id = NEW.policy_id
            AND source_sha256 = NEW.source_sha256
            AND source_byte_size = NEW.source_byte_size
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_processing_job_result');
END;

CREATE TRIGGER validate_audio_processing_job_failed
BEFORE UPDATE OF status ON audio_processing_jobs
WHEN NEW.status = 'failed' AND NOT EXISTS (
  SELECT 1 FROM recordings
  WHERE recordings.id = NEW.recording_id
    AND recordings.processing_state = 'failed'
    AND recordings.processing_error = NEW.error_code
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_processing_job_failure');
END;

CREATE TRIGGER prevent_succeeded_audio_processing_job_change
BEFORE UPDATE ON audio_processing_jobs
WHEN OLD.status = 'succeeded'
BEGIN
  SELECT RAISE(ABORT, 'succeeded_audio_processing_job_is_immutable');
END;

-- Triggers from 0007_audio_processing_control.sql
CREATE TRIGGER validate_audio_processing_job_lease
BEFORE UPDATE OF status, lease_token_hash, lease_expires_at, updated_at
ON audio_processing_jobs
WHEN NEW.status = 'running' AND (
  julianday(NEW.updated_at) IS NULL
  OR julianday(NEW.lease_expires_at) IS NULL
  OR julianday(NEW.lease_expires_at) <= julianday(NEW.updated_at)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_processing_job_lease');
END;

CREATE TRIGGER validate_audio_processing_job_pending
BEFORE UPDATE OF status ON audio_processing_jobs
WHEN NEW.status = 'pending'
  AND OLD.status <> 'pending'
  AND NOT EXISTS (
    SELECT 1
    FROM recordings
    JOIN media_objects ON media_objects.id = recordings.original_media_id
    WHERE recordings.id = NEW.recording_id
      AND recordings.trashed_at IS NULL
      AND recordings.processing_state = 'processing'
      AND recordings.processing_error IS NULL
      AND media_objects.id = NEW.source_media_id
      AND media_objects.kind = 'original_audio'
      AND media_objects.state = 'active'
      AND media_objects.sha256 = NEW.source_sha256
      AND media_objects.byte_size = NEW.source_byte_size
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_processing_job_pending_source');
END;

-- Triggers from 0008_audio_processing_concurrency.sql
CREATE TRIGGER validate_audio_processing_job_expired_recovery
BEFORE UPDATE OF status ON audio_processing_jobs
WHEN OLD.status = 'running'
  AND NEW.status = 'pending'
  AND (
    julianday(OLD.lease_expires_at) IS NULL
    OR julianday(NEW.updated_at) IS NULL
    OR julianday(OLD.lease_expires_at) > julianday(NEW.updated_at)
    OR OLD.attempt_count >= 3
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_processing_job_expired_recovery');
END;

-- 5. Re-create triggers on other tables referencing audio_processing_jobs
CREATE TRIGGER prevent_recording_trash_with_active_audio_job
BEFORE UPDATE OF trashed_at ON recordings
WHEN OLD.trashed_at IS NULL
  AND NEW.trashed_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM audio_processing_jobs
    WHERE recording_id = OLD.id AND status IN ('pending', 'running')
  )
BEGIN
  SELECT RAISE(ABORT, 'recording_has_active_audio_processing');
END;

CREATE TRIGGER validate_recording_upload_finalized
BEFORE UPDATE OF status, recording_id ON recording_upload_sessions
WHEN NEW.status = 'finalized' AND NOT EXISTS (
  SELECT 1
  FROM recordings
  JOIN media_objects ON media_objects.id = recordings.original_media_id
  JOIN audio_processing_jobs ON audio_processing_jobs.recording_id = recordings.id
  WHERE recordings.id = NEW.recording_id
    AND recordings.song_id = NEW.song_id
    AND recordings.trashed_at IS NULL
    AND recordings.processing_state = 'processing'
    AND recordings.processing_error IS NULL
    AND media_objects.object_key = NEW.object_key
    AND media_objects.kind = 'original_audio'
    AND media_objects.sha256 = NEW.sha256
    AND media_objects.byte_size = NEW.byte_size
    AND audio_processing_jobs.source_media_id = media_objects.id
    AND audio_processing_jobs.source_sha256 = NEW.sha256
    AND audio_processing_jobs.source_byte_size = NEW.byte_size
    AND audio_processing_jobs.policy_id = 'mp3-v1-libmp3lame-q2'
    AND audio_processing_jobs.status = 'pending'
    AND audio_processing_jobs.attempt_count = 0
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_upload_finalized');
END;

PRAGMA foreign_keys = ON;
