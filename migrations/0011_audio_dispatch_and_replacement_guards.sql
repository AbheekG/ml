CREATE TABLE audio_processing_dispatch_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES audio_processing_jobs(id) ON DELETE RESTRICT,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN (
    'upload_finalize', 'upload_replay', 'replacement_finalize',
    'replacement_replay', 'editor_retry', 'processor_chain', 'admin_smoke'
  )),
  status TEXT NOT NULL CHECK (status IN ('started', 'accepted', 'failed')),
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK (length(trim(requested_by)) BETWEEN 1 AND 320),
  completed_at TEXT,
  error_code TEXT CHECK (
    error_code IS NULL OR (
      length(error_code) BETWEEN 1 AND 100
      AND substr(error_code, 1, 1) GLOB '[a-z]'
      AND error_code NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  CHECK (
    (status = 'started' AND completed_at IS NULL AND error_code IS NULL)
    OR (status = 'accepted' AND completed_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX audio_processing_dispatch_job_idx
ON audio_processing_dispatch_attempts(job_id, requested_at);

CREATE INDEX audio_processing_dispatch_status_idx
ON audio_processing_dispatch_attempts(status, requested_at);

CREATE TRIGGER validate_audio_processing_dispatch_insert
BEFORE INSERT ON audio_processing_dispatch_attempts
WHEN NEW.status <> 'started'
  OR NOT EXISTS (
    SELECT 1 FROM audio_processing_jobs
    WHERE id = NEW.job_id AND status = 'pending'
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_processing_dispatch');
END;

CREATE TRIGGER validate_audio_processing_dispatch_transition
BEFORE UPDATE ON audio_processing_dispatch_attempts
WHEN OLD.status <> 'started'
  OR NEW.id <> OLD.id
  OR NEW.job_id <> OLD.job_id
  OR NEW.trigger_source <> OLD.trigger_source
  OR NEW.requested_at <> OLD.requested_at
  OR NEW.requested_by <> OLD.requested_by
  OR NEW.status NOT IN ('accepted', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_processing_dispatch_transition');
END;

CREATE TRIGGER prevent_audio_processing_dispatch_delete
BEFORE DELETE ON audio_processing_dispatch_attempts
BEGIN
  SELECT RAISE(ABORT, 'audio_processing_dispatch_is_retained');
END;

CREATE TRIGGER prevent_recording_source_change_with_active_audio_job
BEFORE UPDATE OF original_media_id ON recordings
WHEN NEW.original_media_id <> OLD.original_media_id
  AND (
    OLD.processing_state = 'processing'
    OR EXISTS (
      SELECT 1 FROM audio_processing_jobs
      WHERE recording_id = OLD.id AND status IN ('pending', 'running')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'recording_has_active_audio_processing');
END;

CREATE TRIGGER validate_scan_media_history_insert
BEFORE INSERT ON scan_media_history
WHEN NOT EXISTS (
  SELECT 1
  FROM scans
  JOIN media_objects ON media_objects.id = scans.media_id
  WHERE scans.id = NEW.scan_id
    AND scans.media_id = NEW.media_id
    AND scans.revision = NEW.revision_at_replacement
    AND media_objects.kind = 'scan'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_scan_media_history');
END;

CREATE TRIGGER prevent_scan_media_history_update
BEFORE UPDATE ON scan_media_history
BEGIN
  SELECT RAISE(ABORT, 'scan_media_history_is_immutable');
END;

CREATE TRIGGER prevent_scan_media_history_delete
BEFORE DELETE ON scan_media_history
BEGIN
  SELECT RAISE(ABORT, 'scan_media_history_is_retained');
END;

CREATE TRIGGER validate_recording_media_history_insert
BEFORE INSERT ON recording_media_history
WHEN NOT EXISTS (
  SELECT 1
  FROM recordings
  JOIN media_objects AS original_media
    ON original_media.id = recordings.original_media_id
  LEFT JOIN media_objects AS playback_media
    ON playback_media.id = recordings.playback_media_id
  WHERE recordings.id = NEW.recording_id
    AND recordings.original_media_id = NEW.original_media_id
    AND recordings.playback_media_id IS NEW.playback_media_id
    AND recordings.revision = NEW.revision_at_replacement
    AND original_media.kind = 'original_audio'
    AND (
      NEW.playback_media_id IS NULL
      OR playback_media.kind IN ('original_audio', 'playback_audio')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_media_history');
END;

CREATE TRIGGER prevent_recording_media_history_update
BEFORE UPDATE ON recording_media_history
BEGIN
  SELECT RAISE(ABORT, 'recording_media_history_is_immutable');
END;

CREATE TRIGGER prevent_recording_media_history_delete
BEFORE DELETE ON recording_media_history
BEGIN
  SELECT RAISE(ABORT, 'recording_media_history_is_retained');
END;

CREATE TABLE recording_upload_intents (
  session_id TEXT PRIMARY KEY
    REFERENCES recording_upload_sessions(id) ON DELETE RESTRICT,
  intent_kind TEXT NOT NULL CHECK (intent_kind IN ('create', 'replace')),
  target_recording_id TEXT REFERENCES recordings(id) ON DELETE RESTRICT,
  target_recording_revision INTEGER CHECK (target_recording_revision > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  CHECK (
    (intent_kind = 'create'
      AND target_recording_id IS NULL AND target_recording_revision IS NULL)
    OR (intent_kind = 'replace'
      AND target_recording_id IS NOT NULL AND target_recording_revision IS NOT NULL)
  )
);

CREATE TRIGGER validate_recording_upload_intent_insert
BEFORE INSERT ON recording_upload_intents
WHEN NOT EXISTS (
  SELECT 1
  FROM recording_upload_sessions
  LEFT JOIN recordings ON recordings.id = NEW.target_recording_id
  WHERE recording_upload_sessions.id = NEW.session_id
    AND recording_upload_sessions.status = 'creating'
    AND recording_upload_sessions.created_by = NEW.created_by
    AND (
      (NEW.intent_kind = 'create' AND NEW.target_recording_id IS NULL)
      OR (
        NEW.intent_kind = 'replace'
        AND recordings.id = NEW.target_recording_id
        AND recordings.song_id = recording_upload_sessions.song_id
        AND recordings.trashed_at IS NULL
        AND recordings.revision = NEW.target_recording_revision
        AND recordings.processing_state IN ('ready', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM audio_processing_jobs
          WHERE recording_id = recordings.id AND status IN ('pending', 'running')
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_upload_intent');
END;

CREATE TRIGGER prevent_recording_upload_intent_update
BEFORE UPDATE ON recording_upload_intents
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_intent_is_immutable');
END;

CREATE TRIGGER prevent_recording_upload_intent_delete
BEFORE DELETE ON recording_upload_intents
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_intent_is_retained');
END;

CREATE TRIGGER validate_recording_upload_finalization_intent
BEFORE UPDATE OF status, recording_id ON recording_upload_sessions
WHEN NEW.status = 'finalized'
  AND NOT EXISTS (
    SELECT 1 FROM recording_upload_intents
    WHERE session_id = NEW.id
      AND (
        intent_kind = 'create'
        OR (intent_kind = 'replace' AND target_recording_id = NEW.recording_id)
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_upload_finalization_intent');
END;

DROP TRIGGER validate_recording_upload_status_transition;
CREATE TRIGGER validate_recording_upload_status_transition
BEFORE UPDATE OF status ON recording_upload_sessions
WHEN NEW.status <> OLD.status
  AND NOT (
    (OLD.status = 'creating' AND NEW.status IN ('open', 'aborted', 'failed'))
    OR (OLD.status = 'open' AND NEW.status IN ('completing', 'aborted', 'failed'))
    OR (OLD.status = 'completing' AND NEW.status IN ('open', 'stored', 'failed'))
    OR (OLD.status = 'stored' AND NEW.status IN ('duplicate', 'finalized', 'failed'))
    OR (OLD.status = 'duplicate' AND NEW.status = 'failed')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_upload_transition');
END;

DROP TRIGGER prevent_terminal_recording_upload_change;
CREATE TRIGGER prevent_terminal_recording_upload_change
BEFORE UPDATE ON recording_upload_sessions
WHEN OLD.status IN ('finalized', 'aborted', 'failed')
  OR (
    OLD.status = 'duplicate'
    AND NOT (
      NEW.status = 'failed'
      AND NEW.duplicate_media_id IS NULL
      AND NEW.recording_id IS NULL
      AND NEW.error_code = 'user_discarded'
      AND NEW.sha256 IS OLD.sha256
      AND NEW.revision = OLD.revision + 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_is_terminal');
END;
