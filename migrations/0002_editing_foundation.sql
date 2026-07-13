PRAGMA foreign_keys = ON;

-- Controlled lookup names use an application-generated normalization key. The
-- key is stored explicitly because SQLite/D1's lower() is ASCII-only.
ALTER TABLE languages ADD COLUMN normalized_name TEXT;
ALTER TABLE tags ADD COLUMN normalized_name TEXT;
ALTER TABLE notebooks ADD COLUMN normalized_name TEXT;

UPDATE languages SET normalized_name = lower(trim(display_name));
UPDATE tags SET normalized_name = lower(trim(display_name));
UPDATE notebooks SET normalized_name = lower(trim(display_name));

CREATE UNIQUE INDEX languages_normalized_name_idx ON languages(normalized_name);
CREATE UNIQUE INDEX tags_normalized_name_idx ON tags(normalized_name);
CREATE UNIQUE INDEX notebooks_normalized_name_idx ON notebooks(normalized_name);
CREATE UNIQUE INDEX app_users_identity_nocase_idx ON app_users(identity COLLATE NOCASE);

CREATE TRIGGER validate_language_name_insert
BEFORE INSERT ON languages
WHEN NEW.normalized_name IS NULL OR length(trim(NEW.normalized_name)) = 0
BEGIN
  SELECT RAISE(ABORT, 'invalid_language_name');
END;

CREATE TRIGGER validate_language_name_update
BEFORE UPDATE OF display_name, normalized_name ON languages
WHEN NEW.normalized_name IS NULL OR length(trim(NEW.normalized_name)) = 0
BEGIN
  SELECT RAISE(ABORT, 'invalid_language_name');
END;

CREATE TRIGGER validate_tag_name_insert
BEFORE INSERT ON tags
WHEN NEW.normalized_name IS NULL OR length(trim(NEW.normalized_name)) = 0
BEGIN
  SELECT RAISE(ABORT, 'invalid_tag_name');
END;

CREATE TRIGGER validate_tag_name_update
BEFORE UPDATE OF display_name, normalized_name ON tags
WHEN NEW.normalized_name IS NULL OR length(trim(NEW.normalized_name)) = 0
BEGIN
  SELECT RAISE(ABORT, 'invalid_tag_name');
END;

CREATE TRIGGER validate_notebook_name_insert
BEFORE INSERT ON notebooks
WHEN NEW.normalized_name IS NULL OR length(trim(NEW.normalized_name)) = 0
BEGIN
  SELECT RAISE(ABORT, 'invalid_notebook_name');
END;

CREATE TRIGGER validate_notebook_name_update
BEFORE UPDATE OF display_name, normalized_name ON notebooks
WHEN NEW.normalized_name IS NULL OR length(trim(NEW.normalized_name)) = 0
BEGIN
  SELECT RAISE(ABORT, 'invalid_notebook_name');
END;

-- Songs gain the normalized identity used for duplicate prevention. A partial
-- index lets a later Song reuse a trashed title, while restore still conflicts.
ALTER TABLE songs ADD COLUMN normalized_title_latin TEXT;
UPDATE songs
SET normalized_title_latin = lower(trim(title_latin)),
    status = COALESCE(NULLIF(trim(status), ''), 'draft');

CREATE UNIQUE INDEX songs_active_normalized_title_idx
ON songs(normalized_title_latin)
WHERE trashed_at IS NULL;

CREATE TRIGGER validate_song_values_insert
BEFORE INSERT ON songs
WHEN NEW.normalized_title_latin IS NULL
  OR length(trim(NEW.normalized_title_latin)) = 0
  OR NEW.status IS NULL
  OR NEW.status NOT IN ('draft', 'checked')
BEGIN
  SELECT RAISE(ABORT, 'invalid_song_values');
END;

CREATE TRIGGER validate_song_values_update
BEFORE UPDATE OF title_latin, normalized_title_latin, status ON songs
WHEN NEW.normalized_title_latin IS NULL
  OR length(trim(NEW.normalized_title_latin)) = 0
  OR NEW.status IS NULL
  OR NEW.status NOT IN ('draft', 'checked')
BEGIN
  SELECT RAISE(ABORT, 'invalid_song_values');
END;

-- New lyric blocks deliberately do not require language/script/representation
-- classification. The hidden origin marker is enough to find imported blocks
-- that still need a later deliberate split.
DROP TRIGGER prevent_song_delete_with_content;

CREATE TABLE lyric_texts_v2 (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'legacy_import')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  trashed_at TEXT,
  trashed_by TEXT,
  CHECK (
    (trashed_at IS NULL AND trashed_by IS NULL)
    OR (trashed_at IS NOT NULL AND trashed_by IS NOT NULL)
  )
);

INSERT INTO lyric_texts_v2 (
  id, song_id, content, origin, sort_order, revision,
  created_at, created_by, updated_at, updated_by, trashed_at, trashed_by
)
SELECT
  id,
  song_id,
  content,
  CASE WHEN representation = 'legacy_combined' THEN 'legacy_import' ELSE 'user' END,
  sort_order,
  revision,
  created_at,
  created_by,
  updated_at,
  updated_by,
  trashed_at,
  trashed_by
FROM lyric_texts;

DROP TABLE lyric_texts;
ALTER TABLE lyric_texts_v2 RENAME TO lyric_texts;

CREATE INDEX lyric_texts_song_idx ON lyric_texts(song_id, sort_order);
CREATE INDEX lyric_texts_origin_idx ON lyric_texts(origin, song_id);
CREATE UNIQUE INDEX lyric_texts_active_exact_content_idx
ON lyric_texts(song_id, content)
WHERE trashed_at IS NULL;

-- Credit Notes were unused and are intentionally not part of the editor model.
CREATE TABLE song_credits_v2 (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('Lyricist', 'Composer')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (song_id, person_id, role)
);

INSERT INTO song_credits_v2 (id, song_id, person_id, role, sort_order)
SELECT
  id,
  song_id,
  person_id,
  CASE WHEN role = 'Writer' THEN 'Lyricist' ELSE role END,
  sort_order
FROM song_credits;

DROP TABLE song_credits;
ALTER TABLE song_credits_v2 RENAME TO song_credits;
CREATE INDEX song_credits_person_idx ON song_credits(person_id, role, song_id);

-- Editor-facing Scan metadata is only optional Notebook/Page. Imported fields
-- remain in explicitly hidden legacy columns so the migration loses nothing.
CREATE TABLE scans_v2 (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  media_id TEXT NOT NULL UNIQUE REFERENCES media_objects(id) ON DELETE RESTRICT,
  notebook_id TEXT REFERENCES notebooks(id) ON DELETE RESTRICT,
  page_label TEXT,
  legacy_version TEXT,
  legacy_captured_on TEXT,
  legacy_source TEXT,
  legacy_scan_text TEXT,
  legacy_notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  trashed_at TEXT,
  trashed_by TEXT,
  CHECK (notebook_id IS NOT NULL OR page_label IS NULL),
  CHECK (
    (trashed_at IS NULL AND trashed_by IS NULL)
    OR (trashed_at IS NOT NULL AND trashed_by IS NOT NULL)
  )
);

INSERT INTO scans_v2 (
  id, song_id, media_id, notebook_id, page_label,
  legacy_version, legacy_captured_on, legacy_source, legacy_scan_text, legacy_notes,
  revision, created_at, created_by, updated_at, updated_by, trashed_at, trashed_by
)
SELECT
  id, song_id, media_id, notebook_id, page_label,
  version, captured_on, source, scan_text, notes,
  revision, created_at, created_by, updated_at, updated_by, trashed_at, trashed_by
FROM scans;

DROP TABLE scans;
ALTER TABLE scans_v2 RENAME TO scans;
CREATE INDEX scans_song_idx ON scans(song_id);
CREATE INDEX scans_notebook_idx ON scans(notebook_id, page_label);

-- Recording Version becomes the required description. The four populated Notes
-- are appended losslessly, while both source values remain available privately.
ALTER TABLE recordings RENAME COLUMN version TO legacy_version;
ALTER TABLE recordings RENAME COLUMN notes TO legacy_notes;
ALTER TABLE recordings ADD COLUMN description TEXT;
ALTER TABLE recordings ADD COLUMN normalized_description TEXT;
ALTER TABLE recordings ADD COLUMN processing_state TEXT NOT NULL DEFAULT 'ready'
  CHECK (processing_state IN ('processing', 'ready', 'failed'));
ALTER TABLE recordings ADD COLUMN processing_error TEXT;

UPDATE recordings
SET description = CASE
      WHEN length(trim(COALESCE(legacy_version, ''))) = 0 THEN 'Recording ' || id
      WHEN length(trim(COALESCE(legacy_notes, ''))) = 0 THEN legacy_version
      ELSE legacy_version || char(10) || char(10) || legacy_notes
    END;

UPDATE recordings
SET normalized_description = lower(trim(description));

CREATE UNIQUE INDEX recordings_active_description_idx
ON recordings(song_id, normalized_description)
WHERE trashed_at IS NULL;

CREATE TRIGGER validate_recording_values_insert
BEFORE INSERT ON recordings
WHEN NEW.description IS NULL
  OR length(trim(NEW.description)) = 0
  OR NEW.normalized_description IS NULL
  OR length(trim(NEW.normalized_description)) = 0
  OR (NEW.recorded_on IS NOT NULL AND (date(NEW.recorded_on) IS NULL OR date(NEW.recorded_on) > date('now')))
  OR (NEW.processing_state = 'failed' AND length(trim(COALESCE(NEW.processing_error, ''))) = 0)
  OR (NEW.processing_state <> 'failed' AND NEW.processing_error IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_values');
END;

CREATE TRIGGER validate_recording_values_update
BEFORE UPDATE OF description, normalized_description, recorded_on, processing_state, processing_error ON recordings
WHEN NEW.description IS NULL
  OR length(trim(NEW.description)) = 0
  OR NEW.normalized_description IS NULL
  OR length(trim(NEW.normalized_description)) = 0
  OR (NEW.recorded_on IS NOT NULL AND (date(NEW.recorded_on) IS NULL OR date(NEW.recorded_on) > date('now')))
  OR (NEW.processing_state = 'failed' AND length(trim(COALESCE(NEW.processing_error, ''))) = 0)
  OR (NEW.processing_state <> 'failed' AND NEW.processing_error IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_values');
END;

CREATE TABLE recording_credits_v2 (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (length(trim(role)) > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (recording_id, person_id, role)
);

INSERT INTO recording_credits_v2 (id, recording_id, person_id, role, sort_order)
SELECT
  id,
  recording_id,
  person_id,
  CASE WHEN role = 'Singer' THEN 'Vocals' ELSE role END,
  sort_order
FROM recording_credits;

DROP TABLE recording_credits;
ALTER TABLE recording_credits_v2 RENAME TO recording_credits;
CREATE INDEX recording_credits_person_idx
ON recording_credits(person_id, role, recording_id);

-- An active Song must keep at least one Language. Trashed Songs can have their
-- joins removed only as part of a deliberate administrator cleanup.
CREATE TRIGGER prevent_last_active_song_language_delete
BEFORE DELETE ON song_languages
WHEN EXISTS (
  SELECT 1 FROM songs
  WHERE id = OLD.song_id AND trashed_at IS NULL
)
AND (SELECT COUNT(*) FROM song_languages WHERE song_id = OLD.song_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'song_requires_language');
END;

CREATE TRIGGER prevent_song_trash_with_active_content
BEFORE UPDATE OF trashed_at ON songs
WHEN OLD.trashed_at IS NULL
  AND NEW.trashed_at IS NOT NULL
  AND (
    EXISTS (SELECT 1 FROM lyric_texts WHERE song_id = OLD.id AND trashed_at IS NULL)
    OR EXISTS (SELECT 1 FROM scans WHERE song_id = OLD.id AND trashed_at IS NULL)
    OR EXISTS (SELECT 1 FROM recordings WHERE song_id = OLD.id AND trashed_at IS NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'song_has_active_content');
END;

CREATE TRIGGER prevent_song_delete_with_content
BEFORE DELETE ON songs
WHEN EXISTS (SELECT 1 FROM lyric_texts WHERE song_id = OLD.id)
  OR EXISTS (SELECT 1 FROM scans WHERE song_id = OLD.id)
  OR EXISTS (SELECT 1 FROM recordings WHERE song_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'song_has_content');
END;
