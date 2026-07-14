PRAGMA foreign_keys = ON;

-- Playback derivatives remain separate private media objects. This table keeps
-- the immutable source/policy/hash provenance that was verified before a
-- derivative became a Recording's preferred playback source.
CREATE TABLE audio_derivatives (
  playback_media_id TEXT PRIMARY KEY
    REFERENCES media_objects(id) ON DELETE RESTRICT,
  source_media_id TEXT NOT NULL
    REFERENCES media_objects(id) ON DELETE RESTRICT,
  policy_id TEXT NOT NULL CHECK (length(trim(policy_id)) > 0),
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64
    AND source_sha256 = lower(source_sha256)
    AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_byte_size INTEGER NOT NULL CHECK (source_byte_size >= 0),
  derivative_sha256 TEXT NOT NULL CHECK (
    length(derivative_sha256) = 64
    AND derivative_sha256 = lower(derivative_sha256)
    AND derivative_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  derivative_byte_size INTEGER NOT NULL CHECK (derivative_byte_size > 0),
  UNIQUE (source_media_id, policy_id),
  CHECK (playback_media_id <> source_media_id)
);

CREATE INDEX audio_derivatives_source_idx
ON audio_derivatives(source_media_id, policy_id);

CREATE TRIGGER validate_audio_derivative_insert
BEFORE INSERT ON audio_derivatives
WHEN NOT EXISTS (
    SELECT 1 FROM media_objects
    WHERE id = NEW.source_media_id
      AND kind = 'original_audio'
      AND sha256 IS NEW.source_sha256
      AND byte_size = NEW.source_byte_size
  )
  OR NOT EXISTS (
    SELECT 1 FROM media_objects
    WHERE id = NEW.playback_media_id
      AND kind = 'playback_audio'
      AND sha256 IS NEW.derivative_sha256
      AND byte_size = NEW.derivative_byte_size
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_audio_derivative_provenance');
END;

CREATE TRIGGER prevent_audio_derivative_provenance_update
BEFORE UPDATE ON audio_derivatives
BEGIN
  SELECT RAISE(ABORT, 'audio_derivative_provenance_is_immutable');
END;

CREATE TRIGGER prevent_provenance_media_change
BEFORE UPDATE OF kind, sha256, byte_size ON media_objects
WHEN EXISTS (
    SELECT 1 FROM audio_derivatives
    WHERE source_media_id = OLD.id
      AND (
        NEW.kind <> 'original_audio'
        OR NEW.sha256 IS NOT source_sha256
        OR NEW.byte_size <> source_byte_size
      )
  )
  OR EXISTS (
    SELECT 1 FROM audio_derivatives
    WHERE playback_media_id = OLD.id
      AND (
        NEW.kind <> 'playback_audio'
        OR NEW.sha256 IS NOT derivative_sha256
        OR NEW.byte_size <> derivative_byte_size
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'media_is_bound_to_derivative_provenance');
END;

CREATE TRIGGER prevent_recording_media_kind_change
BEFORE UPDATE OF kind ON media_objects
WHEN EXISTS (
    SELECT 1 FROM recordings
    WHERE original_media_id = OLD.id AND NEW.kind <> 'original_audio'
  )
  OR EXISTS (
    SELECT 1 FROM recordings
    WHERE playback_media_id = OLD.id
      AND playback_media_id <> original_media_id
      AND NEW.kind <> 'playback_audio'
  )
BEGIN
  SELECT RAISE(ABORT, 'media_kind_is_bound_to_recording');
END;

CREATE TRIGGER prevent_in_use_audio_derivative_delete
BEFORE DELETE ON audio_derivatives
WHEN EXISTS (
  SELECT 1 FROM recordings
  WHERE playback_media_id = OLD.playback_media_id
    AND original_media_id = OLD.source_media_id
)
BEGIN
  SELECT RAISE(ABORT, 'audio_derivative_is_in_use');
END;

CREATE TRIGGER validate_recording_audio_insert
BEFORE INSERT ON recordings
WHEN NOT EXISTS (
    SELECT 1 FROM media_objects
    WHERE id = NEW.original_media_id AND kind = 'original_audio'
  )
  OR (
    NEW.playback_media_id IS NOT NULL
    AND NEW.playback_media_id <> NEW.original_media_id
    AND NOT EXISTS (
      SELECT 1 FROM audio_derivatives
      WHERE playback_media_id = NEW.playback_media_id
        AND source_media_id = NEW.original_media_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_audio_relationship');
END;

CREATE TRIGGER validate_recording_audio_update
BEFORE UPDATE OF original_media_id, playback_media_id ON recordings
WHEN NOT EXISTS (
    SELECT 1 FROM media_objects
    WHERE id = NEW.original_media_id AND kind = 'original_audio'
  )
  OR (
    NEW.playback_media_id IS NOT NULL
    AND NEW.playback_media_id <> NEW.original_media_id
    AND NOT EXISTS (
      SELECT 1 FROM audio_derivatives
      WHERE playback_media_id = NEW.playback_media_id
        AND source_media_id = NEW.original_media_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_audio_relationship');
END;
