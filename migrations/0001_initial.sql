PRAGMA foreign_keys = ON;

CREATE TABLE app_users (
  identity TEXT PRIMARY KEY,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE languages (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE,
  bcp47_tag TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE notebooks (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (normalized_name)
);

CREATE TABLE songs (
  id TEXT PRIMARY KEY,
  title_latin TEXT NOT NULL CHECK (length(trim(title_latin)) > 0),
  title_native TEXT,
  status TEXT,
  notes TEXT,
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

CREATE TABLE song_aliases (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  alias TEXT NOT NULL CHECK (length(trim(alias)) > 0),
  normalized_alias TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (song_id, normalized_alias)
);

CREATE TABLE song_languages (
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  language_id TEXT NOT NULL REFERENCES languages(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (song_id, language_id)
);

CREATE TABLE song_tags (
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (song_id, tag_id)
);

CREATE TABLE song_credits (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (length(trim(role)) > 0),
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (song_id, person_id, role)
);

CREATE TABLE lyric_texts (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  language_id TEXT REFERENCES languages(id) ON DELETE RESTRICT,
  script_code TEXT,
  representation TEXT NOT NULL CHECK (
    representation IN ('original', 'transliteration', 'translation', 'legacy_combined')
  ),
  label TEXT,
  content TEXT NOT NULL CHECK (length(content) > 0),
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

CREATE TABLE media_objects (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  mime_type TEXT,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('scan', 'original_audio', 'playback_audio')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'trashed')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  trashed_at TEXT,
  trashed_by TEXT,
  CHECK (
    (state = 'active' AND trashed_at IS NULL AND trashed_by IS NULL)
    OR (state = 'trashed' AND trashed_at IS NOT NULL AND trashed_by IS NOT NULL)
  )
);

CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  media_id TEXT NOT NULL UNIQUE REFERENCES media_objects(id) ON DELETE RESTRICT,
  version TEXT,
  captured_on TEXT,
  source TEXT NOT NULL CHECK (source IN ('Notebook', 'External')),
  notebook_id TEXT REFERENCES notebooks(id) ON DELETE RESTRICT,
  page_label TEXT,
  scan_text TEXT,
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  trashed_at TEXT,
  trashed_by TEXT,
  CHECK (source = 'Notebook' OR notebook_id IS NULL),
  CHECK (
    (trashed_at IS NULL AND trashed_by IS NULL)
    OR (trashed_at IS NOT NULL AND trashed_by IS NOT NULL)
  )
);

CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  original_media_id TEXT NOT NULL UNIQUE REFERENCES media_objects(id) ON DELETE RESTRICT,
  playback_media_id TEXT REFERENCES media_objects(id) ON DELETE RESTRICT,
  version TEXT,
  recorded_on TEXT,
  notes TEXT,
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

CREATE TABLE recording_credits (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (length(trim(role)) > 0),
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (recording_id, person_id, role)
);

CREATE INDEX songs_title_latin_idx ON songs(title_latin COLLATE NOCASE);
CREATE INDEX songs_title_native_idx ON songs(title_native);
CREATE INDEX songs_updated_at_idx ON songs(updated_at DESC);
CREATE INDEX songs_trashed_at_idx ON songs(trashed_at);
CREATE INDEX song_aliases_song_idx ON song_aliases(song_id);
CREATE INDEX song_languages_language_idx ON song_languages(language_id, song_id);
CREATE INDEX song_tags_tag_idx ON song_tags(tag_id, song_id);
CREATE INDEX song_credits_person_idx ON song_credits(person_id, role, song_id);
CREATE INDEX lyric_texts_song_idx ON lyric_texts(song_id, sort_order);
CREATE INDEX lyric_texts_language_idx ON lyric_texts(language_id, representation);
CREATE INDEX scans_song_idx ON scans(song_id);
CREATE INDEX scans_notebook_idx ON scans(notebook_id, page_label);
CREATE INDEX recordings_song_idx ON recordings(song_id);
CREATE INDEX recording_credits_person_idx ON recording_credits(person_id, role, recording_id);
CREATE INDEX media_objects_state_idx ON media_objects(state, kind);

CREATE TRIGGER prevent_song_delete_with_content
BEFORE DELETE ON songs
WHEN EXISTS (SELECT 1 FROM lyric_texts WHERE song_id = OLD.id)
  OR EXISTS (SELECT 1 FROM scans WHERE song_id = OLD.id)
  OR EXISTS (SELECT 1 FROM recordings WHERE song_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'song_has_content');
END;
