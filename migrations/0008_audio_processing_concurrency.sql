PRAGMA foreign_keys = ON;

-- Cloud Run can overlap executions despite one task/parallelism one. D1 is the
-- authoritative global gate: every running row has the same indexed value.
CREATE UNIQUE INDEX audio_processing_jobs_single_running_idx
ON audio_processing_jobs(status)
WHERE status = 'running';

-- A running-to-pending transition is automatic lease-loss recovery. It is
-- valid only after the lease expires and only for the first two lost attempts;
-- the Worker must checkpoint the third expiry as a durable failure instead.
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
