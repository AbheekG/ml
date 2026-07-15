PRAGMA foreign_keys = OFF;

CREATE TABLE scan_media_history (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE RESTRICT,
  media_id TEXT NOT NULL REFERENCES media_objects(id) ON DELETE RESTRICT,
  replaced_at TEXT NOT NULL,
  replaced_by TEXT NOT NULL,
  revision_at_replacement INTEGER NOT NULL CHECK (revision_at_replacement > 0)
);

CREATE INDEX scan_media_history_scan_idx ON scan_media_history(scan_id);

CREATE TABLE recording_media_history (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE RESTRICT,
  original_media_id TEXT NOT NULL REFERENCES media_objects(id) ON DELETE RESTRICT,
  playback_media_id TEXT REFERENCES media_objects(id) ON DELETE RESTRICT,
  replaced_at TEXT NOT NULL,
  replaced_by TEXT NOT NULL,
  revision_at_replacement INTEGER NOT NULL CHECK (revision_at_replacement > 0)
);

CREATE INDEX recording_media_history_recording_idx ON recording_media_history(recording_id);

CREATE TABLE recording_upload_sessions_v2 (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  client_mutation_id TEXT NOT NULL CHECK (length(client_mutation_id) BETWEEN 1 AND 100),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint = lower(request_fingerprint)
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  description TEXT CHECK (description IS NULL OR (length(description) BETWEEN 1 AND 10000 AND description = trim(description))),
  recorded_on TEXT,
  original_filename TEXT NOT NULL CHECK (
    length(original_filename) BETWEEN 1 AND 255 AND original_filename = trim(original_filename)
  ),
  mime_type_hint TEXT CHECK (
    mime_type_hint IS NULL OR (length(mime_type_hint) BETWEEN 3 AND 100 AND mime_type_hint = lower(trim(mime_type_hint)))
  ),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 536870912),
  part_size INTEGER NOT NULL CHECK (part_size = 8388608),
  part_count INTEGER NOT NULL CHECK (part_count BETWEEN 1 AND 64),
  object_key TEXT NOT NULL UNIQUE CHECK (object_key = 'recordings/original/' || id),
  r2_upload_id TEXT CHECK (
    r2_upload_id IS NULL OR (
      length(r2_upload_id) BETWEEN 1 AND 1000
      AND instr(r2_upload_id, char(10)) = 0
      AND instr(r2_upload_id, char(13)) = 0
    )
  ),
  status TEXT NOT NULL CHECK (
    status IN ('creating', 'open', 'completing', 'stored', 'duplicate', 'finalized', 'aborted', 'failed')
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  sha256 TEXT,
  duplicate_media_id TEXT REFERENCES media_objects(id) ON DELETE RESTRICT,
  recording_id TEXT REFERENCES recordings(id) ON DELETE RESTRICT,
  error_code TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  UNIQUE (created_by, client_mutation_id),
  CHECK (expires_at > created_at),
  CHECK (part_count = ((byte_size + part_size - 1) / part_size)),
  CHECK (
    (status = 'creating'
      AND r2_upload_id IS NULL AND sha256 IS NULL
      AND duplicate_media_id IS NULL AND recording_id IS NULL AND error_code IS NULL)
    OR (status IN ('open', 'completing')
      AND length(r2_upload_id) > 0 AND sha256 IS NULL
      AND duplicate_media_id IS NULL AND recording_id IS NULL AND error_code IS NULL)
    OR (status = 'stored'
      AND length(r2_upload_id) > 0
      AND length(sha256) = 64 AND sha256 = lower(sha256) AND sha256 NOT GLOB '*[^0-9a-f]*'
      AND duplicate_media_id IS NULL AND recording_id IS NULL AND error_code IS NULL)
    OR (status = 'duplicate'
      AND length(r2_upload_id) > 0
      AND length(sha256) = 64 AND sha256 = lower(sha256) AND sha256 NOT GLOB '*[^0-9a-f]*'
      AND duplicate_media_id IS NOT NULL AND recording_id IS NULL AND error_code IS NULL)
    OR (status = 'finalized'
      AND length(r2_upload_id) > 0
      AND length(sha256) = 64 AND sha256 = lower(sha256) AND sha256 NOT GLOB '*[^0-9a-f]*'
      AND duplicate_media_id IS NULL AND recording_id IS NOT NULL AND error_code IS NULL)
    OR (status = 'aborted'
      AND sha256 IS NULL AND duplicate_media_id IS NULL AND recording_id IS NULL AND error_code IS NULL)
    OR (status = 'failed'
      AND duplicate_media_id IS NULL AND recording_id IS NULL
      AND length(trim(error_code)) BETWEEN 1 AND 100)
  )
);

INSERT INTO recording_upload_sessions_v2 SELECT * FROM recording_upload_sessions;

DROP TRIGGER prevent_recording_upload_duplicate_media_change;
DROP TRIGGER prevent_finalized_recording_upload_media_change;
DROP TRIGGER prevent_finalized_recording_upload_reparent;
DROP TRIGGER prevent_song_trash_with_active_recording_upload;
DROP TRIGGER prevent_song_delete_with_recording_upload;
DROP TRIGGER validate_recording_upload_part_insert;
DROP TRIGGER validate_recording_upload_part_update;
DROP TRIGGER validate_recording_upload_credit_insert;

DROP TABLE recording_upload_sessions;
ALTER TABLE recording_upload_sessions_v2 RENAME TO recording_upload_sessions;

CREATE INDEX recording_upload_sessions_song_status_idx
ON recording_upload_sessions(song_id, status, updated_at);

CREATE TRIGGER validate_recording_upload_session_insert
BEFORE INSERT ON recording_upload_sessions
WHEN NEW.status <> 'creating'
  OR NEW.revision <> 1
  OR (NEW.recorded_on IS NOT NULL AND (
    date(NEW.recorded_on) IS NULL
    OR date(NEW.recorded_on) <> NEW.recorded_on
    OR date(NEW.recorded_on) > date('now')
  ))
  OR NOT EXISTS (
    SELECT 1 FROM songs WHERE id = NEW.song_id AND trashed_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_upload_session');
END;

CREATE TRIGGER prevent_recording_upload_identity_change
BEFORE UPDATE OF
  song_id, client_mutation_id, request_fingerprint, description, recorded_on,
  original_filename, mime_type_hint, byte_size, part_size, part_count, object_key,
  expires_at, created_at, created_by
ON recording_upload_sessions
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_identity_is_immutable');
END;

CREATE TRIGGER prevent_recording_upload_id_change
BEFORE UPDATE OF r2_upload_id ON recording_upload_sessions
WHEN OLD.r2_upload_id IS NOT NULL AND NEW.r2_upload_id IS NOT OLD.r2_upload_id
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_id_is_immutable');
END;

CREATE TRIGGER prevent_recording_upload_hash_change
BEFORE UPDATE OF sha256 ON recording_upload_sessions
WHEN OLD.sha256 IS NOT NULL AND NEW.sha256 IS NOT OLD.sha256
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_hash_is_immutable');
END;

CREATE TRIGGER validate_recording_upload_revision_update
BEFORE UPDATE ON recording_upload_sessions
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_upload_revision');
END;

CREATE TRIGGER validate_recording_upload_status_transition
BEFORE UPDATE OF status ON recording_upload_sessions
WHEN NEW.status <> OLD.status
  AND NOT (
    (OLD.status = 'creating' AND NEW.status IN ('open', 'aborted', 'failed'))
    OR (OLD.status = 'open' AND NEW.status IN ('completing', 'aborted', 'failed'))
    OR (OLD.status = 'completing' AND NEW.status IN ('open', 'stored', 'failed'))
    OR (OLD.status = 'stored' AND NEW.status IN ('duplicate', 'finalized', 'failed'))
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_upload_transition');
END;

CREATE TRIGGER validate_recording_upload_duplicate
BEFORE UPDATE OF status, duplicate_media_id ON recording_upload_sessions
WHEN NEW.status = 'duplicate' AND NOT EXISTS (
  SELECT 1
  FROM media_objects
  WHERE id = NEW.duplicate_media_id
    AND kind = 'original_audio'
    AND sha256 = NEW.sha256
    AND byte_size = NEW.byte_size
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_upload_duplicate');
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

CREATE TRIGGER validate_recording_upload_error_code
BEFORE UPDATE OF error_code ON recording_upload_sessions
WHEN NEW.error_code IS NOT NULL AND (
  substr(NEW.error_code, 1, 1) NOT GLOB '[a-z]'
  OR NEW.error_code GLOB '*[^a-z0-9_]*'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_upload_error_code');
END;

CREATE TRIGGER prevent_terminal_recording_upload_change
BEFORE UPDATE ON recording_upload_sessions
WHEN OLD.status IN ('duplicate', 'finalized', 'aborted', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_is_terminal');
END;

CREATE TRIGGER prevent_recording_upload_session_delete
BEFORE DELETE ON recording_upload_sessions
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_session_is_retained');
END;

CREATE TRIGGER prevent_recording_upload_duplicate_media_change
BEFORE UPDATE OF kind, sha256, byte_size ON media_objects
WHEN EXISTS (
  SELECT 1
  FROM recording_upload_sessions
  WHERE status = 'duplicate'
    AND duplicate_media_id = OLD.id
    AND (
      NEW.kind <> 'original_audio'
      OR NEW.sha256 IS NOT recording_upload_sessions.sha256
      OR NEW.byte_size <> recording_upload_sessions.byte_size
    )
)
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_duplicate_media_is_immutable');
END;

CREATE TRIGGER prevent_finalized_recording_upload_media_change
BEFORE UPDATE OF object_key, kind, sha256, byte_size ON media_objects
WHEN EXISTS (
  SELECT 1
  FROM recording_upload_sessions
  JOIN recordings ON recordings.id = recording_upload_sessions.recording_id
  WHERE recording_upload_sessions.status = 'finalized'
    AND recordings.original_media_id = OLD.id
    AND (
      NEW.object_key <> recording_upload_sessions.object_key
      OR NEW.kind <> 'original_audio'
      OR NEW.sha256 IS NOT recording_upload_sessions.sha256
      OR NEW.byte_size <> recording_upload_sessions.byte_size
    )
)
BEGIN
  SELECT RAISE(ABORT, 'finalized_recording_upload_media_is_immutable');
END;

CREATE TRIGGER prevent_finalized_recording_upload_reparent
BEFORE UPDATE OF song_id ON recordings
WHEN EXISTS (
  SELECT 1
  FROM recording_upload_sessions
  WHERE status = 'finalized'
    AND recording_id = OLD.id
    AND NEW.song_id <> recording_upload_sessions.song_id
)
BEGIN
  SELECT RAISE(ABORT, 'finalized_recording_upload_song_is_immutable');
END;

CREATE TRIGGER prevent_song_trash_with_active_recording_upload
BEFORE UPDATE OF trashed_at ON songs
WHEN OLD.trashed_at IS NULL
  AND NEW.trashed_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM recording_upload_sessions
    WHERE song_id = OLD.id
      AND status IN ('creating', 'open', 'completing', 'stored', 'duplicate')
  )
BEGIN
  SELECT RAISE(ABORT, 'song_has_active_recording_upload');
END;

CREATE TRIGGER prevent_song_delete_with_recording_upload
BEFORE DELETE ON songs
WHEN EXISTS (SELECT 1 FROM recording_upload_sessions WHERE song_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'song_has_recording_upload_history');
END;

CREATE TRIGGER validate_recording_upload_part_insert
BEFORE INSERT ON recording_upload_parts
WHEN NOT EXISTS (
    SELECT 1 FROM recording_upload_sessions
    WHERE id = NEW.session_id
      AND status = 'open'
      AND NEW.part_number <= part_count
      AND NEW.byte_size = CASE
        WHEN NEW.part_number < part_count THEN part_size
        ELSE byte_size - ((part_count - 1) * part_size)
      END
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_upload_part');
END;

CREATE TRIGGER validate_recording_upload_part_update
BEFORE UPDATE ON recording_upload_parts
WHEN NEW.session_id <> OLD.session_id
  OR NEW.part_number <> OLD.part_number
  OR NOT EXISTS (
    SELECT 1 FROM recording_upload_sessions
    WHERE id = NEW.session_id
      AND status = 'open'
      AND NEW.part_number <= part_count
      AND NEW.byte_size = CASE
        WHEN NEW.part_number < part_count THEN part_size
        ELSE byte_size - ((part_count - 1) * part_size)
      END
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_upload_part');
END;

CREATE TRIGGER validate_recording_upload_credit_insert
BEFORE INSERT ON recording_upload_credits
WHEN NOT EXISTS (
  SELECT 1 FROM recording_upload_sessions
  WHERE id = NEW.session_id AND status = 'creating'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_upload_credit');
END;

PRAGMA foreign_keys = ON;
