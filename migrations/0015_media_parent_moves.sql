PRAGMA foreign_keys = ON;

CREATE TABLE media_parent_moves (
  id TEXT PRIMARY KEY,
  scan_id TEXT REFERENCES scans(id) ON DELETE RESTRICT,
  recording_id TEXT REFERENCES recordings(id) ON DELETE RESTRICT,
  from_song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  to_song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  moved_at TEXT NOT NULL,
  moved_by TEXT NOT NULL,
  CHECK ((scan_id IS NOT NULL) <> (recording_id IS NOT NULL)),
  CHECK (from_song_id <> to_song_id),
  CHECK (length(trim(moved_by)) > 0)
);

CREATE INDEX media_parent_moves_scan_idx ON media_parent_moves(scan_id, moved_at);
CREATE INDEX media_parent_moves_recording_idx ON media_parent_moves(recording_id, moved_at);

CREATE TRIGGER prevent_media_parent_move_update
BEFORE UPDATE ON media_parent_moves
BEGIN
  SELECT RAISE(ABORT, 'media_parent_move_is_immutable');
END;

CREATE TRIGGER prevent_media_parent_move_delete
BEFORE DELETE ON media_parent_moves
BEGIN
  SELECT RAISE(ABORT, 'media_parent_move_is_immutable');
END;

CREATE TRIGGER validate_scan_parent_move
BEFORE UPDATE OF song_id ON scans
WHEN NEW.song_id <> OLD.song_id
  AND (
    OLD.trashed_at IS NULL
    OR NEW.trashed_at IS NOT NULL
    OR NEW.trashed_by IS NOT NULL
    OR NEW.revision <> OLD.revision + 1
    OR NEW.updated_at = OLD.updated_at
    OR length(trim(NEW.updated_by)) = 0
    OR NOT EXISTS (SELECT 1 FROM songs WHERE id = NEW.song_id AND trashed_at IS NULL)
    OR NOT EXISTS (
      SELECT 1 FROM media_objects
      WHERE id = OLD.media_id AND kind = 'scan' AND state = 'trashed'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_scan_parent_move');
END;

CREATE TRIGGER record_scan_parent_move
AFTER UPDATE OF song_id ON scans
WHEN NEW.song_id <> OLD.song_id
BEGIN
  INSERT INTO media_parent_moves (
    id, scan_id, recording_id, from_song_id, to_song_id, moved_at, moved_by
  ) VALUES (
    lower(hex(randomblob(16))), NEW.id, NULL, OLD.song_id, NEW.song_id,
    NEW.updated_at, NEW.updated_by
  );
END;

DROP TRIGGER IF EXISTS prevent_finalized_recording_upload_reparent;

CREATE TRIGGER validate_recording_parent_move
BEFORE UPDATE OF song_id ON recordings
WHEN NEW.song_id <> OLD.song_id
  AND (
    OLD.trashed_at IS NULL
    OR NEW.trashed_at IS NOT NULL
    OR NEW.trashed_by IS NOT NULL
    OR NEW.revision <> OLD.revision + 1
    OR NEW.updated_at = OLD.updated_at
    OR length(trim(NEW.updated_by)) = 0
    OR NOT EXISTS (SELECT 1 FROM songs WHERE id = NEW.song_id AND trashed_at IS NULL)
    OR NOT EXISTS (
      SELECT 1 FROM media_objects
      WHERE id = OLD.original_media_id
        AND kind = 'original_audio' AND state = 'trashed'
    )
    OR (
      OLD.playback_media_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM media_objects
        WHERE id = OLD.playback_media_id
          AND kind IN ('original_audio', 'playback_audio')
          AND state IN ('active', 'trashed')
      )
    )
    OR EXISTS (
      SELECT 1 FROM audio_processing_jobs
      WHERE recording_id = OLD.id AND status IN ('pending', 'running')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_parent_move');
END;

CREATE TRIGGER record_recording_parent_move
AFTER UPDATE OF song_id ON recordings
WHEN NEW.song_id <> OLD.song_id
BEGIN
  INSERT INTO media_parent_moves (
    id, scan_id, recording_id, from_song_id, to_song_id, moved_at, moved_by
  ) VALUES (
    lower(hex(randomblob(16))), NULL, NEW.id, OLD.song_id, NEW.song_id,
    NEW.updated_at, NEW.updated_by
  );
END;
