-- Bind every new resumable upload to the exact client-selected file without
-- exposing the manifest or individual part hashes in browser status payloads.
ALTER TABLE recording_upload_sessions ADD COLUMN file_manifest_sha256 TEXT
  CHECK (
    file_manifest_sha256 IS NULL
    OR (
      length(file_manifest_sha256) = 64
      AND file_manifest_sha256 = lower(file_manifest_sha256)
      AND file_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE recording_upload_parts ADD COLUMN sha256 TEXT
  CHECK (
    sha256 IS NULL
    OR (
      length(sha256) = 64
      AND sha256 = lower(sha256)
      AND sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

CREATE TRIGGER require_recording_upload_file_manifest
BEFORE INSERT ON recording_upload_sessions
WHEN NEW.file_manifest_sha256 IS NULL
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_file_manifest_required');
END;

CREATE TRIGGER prevent_recording_upload_file_manifest_change
BEFORE UPDATE OF file_manifest_sha256 ON recording_upload_sessions
WHEN NEW.file_manifest_sha256 IS NOT OLD.file_manifest_sha256
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_file_manifest_is_immutable');
END;

CREATE TRIGGER require_recording_upload_part_hash
BEFORE INSERT ON recording_upload_parts
WHEN NEW.sha256 IS NULL
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_part_hash_required');
END;

CREATE TRIGGER prevent_recording_upload_part_hash_change
BEFORE UPDATE OF sha256 ON recording_upload_parts
WHEN NEW.sha256 IS NOT OLD.sha256
BEGIN
  SELECT RAISE(ABORT, 'recording_upload_part_hash_is_immutable');
END;
