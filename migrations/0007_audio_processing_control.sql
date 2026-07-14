PRAGMA foreign_keys = ON;

-- A running job is also an expiring transfer capability. Keep malformed or
-- already-expired leases out of durable state even if a future caller bypasses
-- the Worker helpers.
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

-- Expired-lease recovery and explicit editor retry both move a job back to
-- pending. They may do so only while the exact source Recording is processing.
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
