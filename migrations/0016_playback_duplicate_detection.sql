PRAGMA foreign_keys = ON;

-- An app-generated playback file is another byte-exact representation of its
-- Recording. Treat reuploads of that representation as duplicates too, while
-- retaining the same immutable fingerprint checkpoint used for originals.
DROP TRIGGER IF EXISTS validate_recording_upload_duplicate;

CREATE TRIGGER validate_recording_upload_duplicate
BEFORE UPDATE OF status, duplicate_media_id ON recording_upload_sessions
WHEN NEW.status = 'duplicate' AND NOT EXISTS (
  SELECT 1
  FROM media_objects
  WHERE id = NEW.duplicate_media_id
    AND kind IN ('original_audio', 'playback_audio')
    AND sha256 = NEW.sha256
    AND byte_size = NEW.byte_size
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_upload_duplicate');
END;

DROP TRIGGER IF EXISTS prevent_recording_upload_duplicate_media_change;

CREATE TRIGGER prevent_recording_upload_duplicate_media_change
BEFORE UPDATE OF kind, sha256, byte_size ON media_objects
WHEN EXISTS (
  SELECT 1
  FROM recording_upload_sessions
  WHERE status = 'duplicate'
    AND duplicate_media_id = OLD.id
    AND (
      NEW.kind <> OLD.kind
      OR NEW.kind NOT IN ('original_audio', 'playback_audio')
      OR NEW.sha256 IS NOT recording_upload_sessions.sha256
      OR NEW.byte_size <> recording_upload_sessions.byte_size
    )
)
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_duplicate_media_is_immutable');
END;
