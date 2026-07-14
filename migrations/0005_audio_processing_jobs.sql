PRAGMA foreign_keys = ON;

-- New Recording uploads are durable before hosted FFmpeg work begins. The
-- Worker owns this job row and grants only a short-lived lease to a processor.
-- Result media/provenance are finalized separately and atomically before the
-- Recording can become ready.
CREATE TABLE audio_processing_jobs (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL UNIQUE
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
      AND lease_token_hash IS NULL
      AND lease_expires_at IS NULL
      AND playback_kind IS NULL
      AND derivative_media_id IS NULL
      AND error_code IS NULL)
    OR (status = 'running'
      AND attempt_count > 0
      AND length(lease_token_hash) = 64
      AND lease_token_hash = lower(lease_token_hash)
      AND lease_token_hash NOT GLOB '*[^0-9a-f]*'
      AND lease_expires_at IS NOT NULL
      AND playback_kind IS NULL
      AND derivative_media_id IS NULL
      AND error_code IS NULL)
    OR (status = 'succeeded'
      AND attempt_count > 0
      AND lease_token_hash IS NULL
      AND lease_expires_at IS NULL
      AND playback_kind IS NOT NULL
      AND ((playback_kind = 'original' AND derivative_media_id IS NULL)
        OR (playback_kind = 'derivative' AND derivative_media_id IS NOT NULL))
      AND error_code IS NULL)
    OR (status = 'failed'
      AND attempt_count > 0
      AND lease_token_hash IS NULL
      AND lease_expires_at IS NULL
      AND playback_kind IS NULL
      AND derivative_media_id IS NULL
      AND length(trim(error_code)) > 0)
  )
);

CREATE INDEX audio_processing_jobs_status_idx
ON audio_processing_jobs(status, updated_at);

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
BEFORE UPDATE OF recording_id, source_media_id, source_sha256, source_byte_size, policy_id
ON audio_processing_jobs
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
