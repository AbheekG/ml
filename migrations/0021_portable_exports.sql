PRAGMA foreign_keys = ON;

CREATE TABLE portable_export_sessions (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 32
    AND id = lower(id)
    AND id NOT GLOB '*[^0-9a-f]*'
  ),
  profile_version TEXT NOT NULL CHECK (profile_version = '1.0.0'),
  client_mutation_id TEXT NOT NULL CHECK (
    length(client_mutation_id) BETWEEN 1 AND 100
    AND instr(client_mutation_id, char(10)) = 0
    AND instr(client_mutation_id, char(13)) = 0
  ),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint = lower(request_fingerprint)
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (
    state IN ('preparing', 'ready', 'revoked', 'expired', 'failed')
  ),
  source_schema_version TEXT NOT NULL CHECK (source_schema_version = '0021'),
  source_commit TEXT NOT NULL CHECK (
    source_commit = 'local-development'
    OR (
      length(source_commit) BETWEEN 7 AND 40
      AND source_commit = lower(source_commit)
      AND source_commit NOT GLOB '*[^0-9a-f]*'
    )
  ),
  source_environment TEXT NOT NULL CHECK (
    length(source_environment) BETWEEN 1 AND 100
    AND instr(source_environment, char(10)) = 0
    AND instr(source_environment, char(13)) = 0
  ),
  snapshot_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  expires_at TEXT NOT NULL CHECK (expires_at > created_at),
  record_count INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  planned_bytes INTEGER NOT NULL DEFAULT 0 CHECK (planned_bytes >= 0),
  plan_digest TEXT CHECK (
    plan_digest IS NULL
    OR (
      length(plan_digest) = 64
      AND plan_digest = lower(plan_digest)
      AND plan_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  ready_at TEXT,
  revoked_at TEXT,
  expired_at TEXT,
  failed_at TEXT,
  failure_code TEXT CHECK (
    failure_code IS NULL
    OR (
      length(failure_code) BETWEEN 1 AND 100
      AND substr(failure_code, 1, 1) GLOB '[a-z]'
      AND failure_code NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  detail_purged_at TEXT,
  UNIQUE (created_by, client_mutation_id),
  CHECK (
    (state = 'preparing'
      AND plan_digest IS NULL AND ready_at IS NULL
      AND revoked_at IS NULL AND expired_at IS NULL
      AND failed_at IS NULL AND failure_code IS NULL)
    OR (state = 'ready'
      AND plan_digest IS NOT NULL AND ready_at IS NOT NULL
      AND revoked_at IS NULL AND expired_at IS NULL
      AND failed_at IS NULL AND failure_code IS NULL)
    OR (state = 'revoked'
      AND plan_digest IS NOT NULL AND ready_at IS NOT NULL
      AND revoked_at IS NOT NULL AND expired_at IS NULL
      AND failed_at IS NULL AND failure_code IS NULL)
    OR (state = 'expired'
      AND plan_digest IS NOT NULL AND ready_at IS NOT NULL
      AND revoked_at IS NULL AND expired_at IS NOT NULL
      AND failed_at IS NULL AND failure_code IS NULL)
    OR (state = 'failed'
      AND ready_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL
      AND failed_at IS NOT NULL AND failure_code IS NOT NULL)
  )
);

CREATE INDEX portable_export_sessions_creator_idx
ON portable_export_sessions(created_by, created_at DESC);

CREATE INDEX portable_export_sessions_cleanup_idx
ON portable_export_sessions(state, detail_purged_at, revoked_at, expired_at, failed_at);

CREATE TABLE portable_export_records (
  export_id TEXT NOT NULL REFERENCES portable_export_sessions(id) ON DELETE RESTRICT,
  record_kind TEXT NOT NULL CHECK (
    record_kind IN (
      'app_users',
      'audio_derivatives',
      'languages',
      'lyric_texts',
      'media_objects',
      'media_parent_moves',
      'notebooks',
      'people',
      'recording_credits',
      'recording_media_history',
      'recordings',
      'scan_fingerprint_members',
      'scan_fingerprints',
      'scan_media_history',
      'scan_readability_derivatives',
      'scans',
      'song_aliases',
      'song_credits',
      'song_languages',
      'song_tags',
      'songs',
      'tags'
    )
  ),
  record_key TEXT NOT NULL CHECK (
    length(record_key) BETWEEN 1 AND 500
    AND instr(record_key, char(0)) = 0
  ),
  order_key TEXT NOT NULL CHECK (
    length(order_key) BETWEEN 1 AND 1000
    AND instr(order_key, char(0)) = 0
  ),
  frozen_json TEXT NOT NULL CHECK (
    json_valid(frozen_json)
    AND length(CAST(frozen_json AS BLOB)) BETWEEN 2 AND 1048576
  ),
  PRIMARY KEY (export_id, record_kind, record_key)
);

CREATE INDEX portable_export_records_page_idx
ON portable_export_records(export_id, record_kind, order_key, record_key);

CREATE TABLE portable_export_items (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 32
    AND id = lower(id)
    AND id NOT GLOB '*[^0-9a-f]*'
  ),
  export_id TEXT NOT NULL REFERENCES portable_export_sessions(id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('media_object', 'scan_readability')
  ),
  source_id TEXT NOT NULL CHECK (
    length(source_id) BETWEEN 1 AND 200
    AND instr(source_id, char(0)) = 0
  ),
  representation TEXT NOT NULL CHECK (
    representation IN (
      'scan_original',
      'scan_optimized',
      'recording_original',
      'recording_playback'
    )
  ),
  object_key TEXT NOT NULL CHECK (
    length(object_key) BETWEEN 1 AND 1024
    AND instr(object_key, char(0)) = 0
    AND instr(object_key, char(10)) = 0
    AND instr(object_key, char(13)) = 0
  ),
  mime_type TEXT NOT NULL CHECK (
    length(mime_type) BETWEEN 3 AND 200
    AND mime_type = lower(trim(mime_type))
  ),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND sha256 = lower(sha256)
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE (export_id, source_kind, source_id),
  UNIQUE (export_id, object_key)
);

CREATE INDEX portable_export_items_page_idx
ON portable_export_items(export_id, source_kind, source_id, id);

CREATE TRIGGER validate_portable_export_ready
BEFORE UPDATE OF state ON portable_export_sessions
WHEN OLD.state = 'preparing' AND NEW.state = 'ready'
  AND (
    NEW.plan_digest IS NULL
    OR NEW.ready_at IS NULL
    OR NEW.expires_at <= NEW.ready_at
    OR NEW.record_count <> (
      SELECT COUNT(*) FROM portable_export_records WHERE export_id = OLD.id
    )
    OR NEW.item_count <> (
      SELECT COUNT(*) FROM portable_export_items WHERE export_id = OLD.id
    )
    OR NEW.planned_bytes <> COALESCE((
      SELECT SUM(byte_size) FROM portable_export_items WHERE export_id = OLD.id
    ), 0)
    OR NEW.item_count <> (
      SELECT COUNT(*) FROM media_objects
    ) + (
      SELECT COUNT(*) FROM scan_readability_derivatives
    )
    OR EXISTS (
      SELECT 1
      FROM media_objects
      WHERE byte_size <= 0
        OR sha256 IS NULL
        OR length(sha256) <> 64
        OR sha256 <> lower(sha256)
        OR sha256 GLOB '*[^0-9a-f]*'
    )
    OR EXISTS (
      SELECT 1
      FROM portable_export_items
      WHERE export_id = OLD.id
      GROUP BY lower(rtrim(object_key, ' .'))
      HAVING COUNT(*) > 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'portable_export_precondition_failed');
END;

CREATE TRIGGER validate_portable_export_transition
BEFORE UPDATE OF state ON portable_export_sessions
WHEN NEW.state <> OLD.state
  AND NOT (
    (OLD.state = 'preparing' AND NEW.state IN ('ready', 'failed'))
    OR (OLD.state = 'ready' AND NEW.state IN ('revoked', 'expired'))
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_portable_export_transition');
END;

CREATE TRIGGER prevent_portable_export_identity_change
BEFORE UPDATE OF
  id, profile_version, client_mutation_id, request_fingerprint,
  source_schema_version, source_commit, source_environment,
  snapshot_at, created_at, created_by, expires_at,
  record_count, item_count, planned_bytes, plan_digest, ready_at
ON portable_export_sessions
WHEN OLD.state <> 'preparing'
BEGIN
  SELECT RAISE(ABORT, 'portable_export_identity_is_immutable');
END;

CREATE TRIGGER prevent_portable_export_delete
BEFORE DELETE ON portable_export_sessions
BEGIN
  SELECT RAISE(ABORT, 'portable_export_audit_is_retained');
END;

CREATE TRIGGER prevent_portable_export_record_update
BEFORE UPDATE ON portable_export_records
BEGIN
  SELECT RAISE(ABORT, 'portable_export_record_is_immutable');
END;

CREATE TRIGGER constrain_portable_export_record_delete
BEFORE DELETE ON portable_export_records
WHEN NOT EXISTS (
  SELECT 1
  FROM portable_export_sessions
  WHERE id = OLD.export_id
    AND state IN ('revoked', 'expired', 'failed')
)
BEGIN
  SELECT RAISE(ABORT, 'portable_export_detail_is_active');
END;

CREATE TRIGGER prevent_portable_export_item_update
BEFORE UPDATE ON portable_export_items
BEGIN
  SELECT RAISE(ABORT, 'portable_export_item_is_immutable');
END;

CREATE TRIGGER constrain_portable_export_item_delete
BEFORE DELETE ON portable_export_items
WHEN NOT EXISTS (
  SELECT 1
  FROM portable_export_sessions
  WHERE id = OLD.export_id
    AND state IN ('revoked', 'expired', 'failed')
)
BEGIN
  SELECT RAISE(ABORT, 'portable_export_detail_is_active');
END;
