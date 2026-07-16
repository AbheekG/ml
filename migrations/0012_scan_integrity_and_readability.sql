CREATE TABLE scan_fingerprints (
  sha256 TEXT PRIMARY KEY CHECK (
    length(sha256) = 64
    AND sha256 = lower(sha256)
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  canonical_media_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE scan_fingerprint_members (
  media_id TEXT PRIMARY KEY REFERENCES media_objects(id) ON DELETE RESTRICT,
  sha256 TEXT NOT NULL REFERENCES scan_fingerprints(sha256) ON DELETE RESTRICT,
  is_historical_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (is_historical_duplicate IN (0, 1)),
  registered_at TEXT NOT NULL
);

CREATE INDEX scan_fingerprint_members_sha_idx
ON scan_fingerprint_members(sha256, media_id);

INSERT INTO scan_fingerprints (sha256, canonical_media_id, first_seen_at)
SELECT sha256, MIN(id), MIN(created_at)
FROM media_objects
WHERE kind = 'scan' AND sha256 IS NOT NULL
GROUP BY sha256;

INSERT INTO scan_fingerprint_members (
  media_id, sha256, is_historical_duplicate, registered_at
)
SELECT
  media_objects.id,
  media_objects.sha256,
  CASE WHEN media_objects.id = scan_fingerprints.canonical_media_id THEN 0 ELSE 1 END,
  media_objects.created_at
FROM media_objects
JOIN scan_fingerprints ON scan_fingerprints.sha256 = media_objects.sha256
WHERE media_objects.kind = 'scan';

CREATE TRIGGER validate_new_scan_fingerprint
BEFORE INSERT ON media_objects
WHEN NEW.kind = 'scan'
  AND (
    NEW.sha256 IS NULL
    OR length(NEW.sha256) <> 64
    OR NEW.sha256 <> lower(NEW.sha256)
    OR NEW.sha256 GLOB '*[^0-9a-f]*'
    OR EXISTS (SELECT 1 FROM scan_fingerprints WHERE sha256 = NEW.sha256)
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate_or_invalid_scan_fingerprint');
END;

CREATE TRIGGER register_new_scan_fingerprint
AFTER INSERT ON media_objects
WHEN NEW.kind = 'scan'
BEGIN
  INSERT INTO scan_fingerprints (sha256, canonical_media_id, first_seen_at)
  VALUES (NEW.sha256, NEW.id, NEW.created_at);

  INSERT INTO scan_fingerprint_members (
    media_id, sha256, is_historical_duplicate, registered_at
  ) VALUES (NEW.id, NEW.sha256, 0, NEW.created_at);
END;

-- Imported scans predate fingerprint enforcement. A null-to-hash update is the
-- only permitted backfill transition and deliberately preserves any historical
-- duplicate as a non-canonical member.
CREATE TRIGGER validate_scan_fingerprint_backfill
BEFORE UPDATE OF kind, sha256 ON media_objects
WHEN OLD.kind = 'scan'
  AND OLD.sha256 IS NULL
  AND (
    NEW.kind <> 'scan'
    OR NEW.sha256 IS NULL
    OR length(NEW.sha256) <> 64
    OR NEW.sha256 <> lower(NEW.sha256)
    OR NEW.sha256 GLOB '*[^0-9a-f]*'
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_scan_fingerprint_backfill');
END;

CREATE TRIGGER register_scan_fingerprint_backfill
AFTER UPDATE OF sha256 ON media_objects
WHEN OLD.kind = 'scan' AND OLD.sha256 IS NULL AND NEW.sha256 IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO scan_fingerprints (sha256, canonical_media_id, first_seen_at)
  VALUES (NEW.sha256, NEW.id, NEW.created_at);

  INSERT INTO scan_fingerprint_members (
    media_id, sha256, is_historical_duplicate, registered_at
  )
  SELECT
    NEW.id,
    NEW.sha256,
    CASE WHEN canonical_media_id = NEW.id THEN 0 ELSE 1 END,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM scan_fingerprints
  WHERE sha256 = NEW.sha256;
END;

CREATE TRIGGER prevent_registered_scan_fingerprint_change
BEFORE UPDATE OF kind, sha256 ON media_objects
WHEN OLD.kind = 'scan'
  AND OLD.sha256 IS NOT NULL
  AND (NEW.kind <> 'scan' OR NEW.sha256 IS NOT OLD.sha256)
BEGIN
  SELECT RAISE(ABORT, 'registered_scan_fingerprint_is_immutable');
END;

CREATE TRIGGER validate_media_becoming_scan
BEFORE UPDATE OF kind, sha256 ON media_objects
WHEN OLD.kind <> 'scan'
  AND NEW.kind = 'scan'
  AND (
    NEW.sha256 IS NULL
    OR length(NEW.sha256) <> 64
    OR NEW.sha256 <> lower(NEW.sha256)
    OR NEW.sha256 GLOB '*[^0-9a-f]*'
    OR EXISTS (SELECT 1 FROM scan_fingerprints WHERE sha256 = NEW.sha256)
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate_or_invalid_scan_fingerprint');
END;

CREATE TRIGGER register_media_becoming_scan
AFTER UPDATE OF kind, sha256 ON media_objects
WHEN OLD.kind <> 'scan' AND NEW.kind = 'scan'
BEGIN
  INSERT INTO scan_fingerprints (sha256, canonical_media_id, first_seen_at)
  VALUES (NEW.sha256, NEW.id, NEW.created_at);

  INSERT INTO scan_fingerprint_members (
    media_id, sha256, is_historical_duplicate, registered_at
  ) VALUES (NEW.id, NEW.sha256, 0, NEW.created_at);
END;

CREATE TRIGGER unregister_deleted_scan_fingerprint
BEFORE DELETE ON media_objects
WHEN OLD.kind = 'scan' AND OLD.sha256 IS NOT NULL
BEGIN
  DELETE FROM scan_fingerprint_members WHERE media_id = OLD.id;

  UPDATE scan_fingerprints
  SET canonical_media_id = (
    SELECT MIN(media_id)
    FROM scan_fingerprint_members
    WHERE sha256 = OLD.sha256
  )
  WHERE sha256 = OLD.sha256
    AND canonical_media_id = OLD.id
    AND EXISTS (
      SELECT 1 FROM scan_fingerprint_members WHERE sha256 = OLD.sha256
    );

  DELETE FROM scan_fingerprints
  WHERE sha256 = OLD.sha256
    AND NOT EXISTS (
      SELECT 1 FROM scan_fingerprint_members WHERE sha256 = OLD.sha256
    );
END;

CREATE TABLE scan_readability_derivatives (
  source_media_id TEXT PRIMARY KEY REFERENCES media_objects(id) ON DELETE RESTRICT,
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64
    AND source_sha256 = lower(source_sha256)
    AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_byte_size INTEGER NOT NULL CHECK (source_byte_size > 0),
  object_key TEXT NOT NULL UNIQUE CHECK (
    object_key = 'scans/readability/' || source_media_id || '.jpg'
  ),
  mime_type TEXT NOT NULL CHECK (mime_type = 'image/jpeg'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 20971520),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND sha256 = lower(sha256)
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 2400),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 2400),
  policy_id TEXT NOT NULL CHECK (policy_id = 'scan-jpeg-v1-2400-q85'),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TRIGGER validate_scan_readability_derivative_insert
BEFORE INSERT ON scan_readability_derivatives
WHEN NOT EXISTS (
  SELECT 1 FROM media_objects
  WHERE id = NEW.source_media_id
    AND kind = 'scan'
    AND sha256 = NEW.source_sha256
    AND byte_size = NEW.source_byte_size
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_scan_readability_provenance');
END;

CREATE TRIGGER prevent_scan_readability_derivative_update
BEFORE UPDATE ON scan_readability_derivatives
BEGIN
  SELECT RAISE(ABORT, 'scan_readability_provenance_is_immutable');
END;

CREATE TRIGGER prevent_scan_readability_source_change
BEFORE UPDATE OF kind, sha256, byte_size ON media_objects
WHEN EXISTS (
  SELECT 1 FROM scan_readability_derivatives
  WHERE source_media_id = OLD.id
    AND (
      NEW.kind <> 'scan'
      OR NEW.sha256 IS NOT source_sha256
      OR NEW.byte_size <> source_byte_size
    )
)
BEGIN
  SELECT RAISE(ABORT, 'media_is_bound_to_scan_readability_provenance');
END;

CREATE TABLE scan_maintenance_failures (
  media_id TEXT PRIMARY KEY REFERENCES media_objects(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('source_read', 'source_verify', 'derivative', 'commit')),
  error_code TEXT NOT NULL CHECK (
    length(error_code) BETWEEN 1 AND 100
    AND substr(error_code, 1, 1) GLOB '[a-z]'
    AND error_code NOT GLOB '*[^a-z0-9_]*'
  ),
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  first_failed_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL,
  retry_after TEXT NOT NULL,
  CHECK (last_failed_at >= first_failed_at AND retry_after > last_failed_at)
);
