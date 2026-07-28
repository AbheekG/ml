PRAGMA foreign_keys = ON;

-- Existing selected derivatives are rewritten to metadata-free bytes under a
-- versioned key before their D1 rows are replaced. Historical, unselected
-- derivatives keep their immutable legacy keys.
DROP TRIGGER validate_portable_export_ready;
DROP TRIGGER validate_scan_readability_selection_insert;
DROP TRIGGER prevent_derivative_for_direct_scan_readability;
DROP TRIGGER prevent_selected_scan_readability_derivative_delete;
DROP TRIGGER validate_scan_readability_derivative_insert;
DROP TRIGGER prevent_scan_readability_derivative_update;
DROP TRIGGER prevent_scan_readability_source_change;
DROP TRIGGER validate_new_scan_fingerprint;
DROP TRIGGER validate_media_becoming_scan;
DROP INDEX scan_readability_derivatives_fingerprint_idx;

ALTER TABLE scan_readability_derivatives
RENAME TO scan_readability_derivatives_v1;

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
    OR object_key = 'scans/readability-v2/' || source_media_id || '.jpg'
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

INSERT INTO scan_readability_derivatives (
  source_media_id,
  source_sha256,
  source_byte_size,
  object_key,
  mime_type,
  byte_size,
  sha256,
  width,
  height,
  policy_id,
  created_at,
  created_by
)
SELECT
  source_media_id,
  source_sha256,
  source_byte_size,
  object_key,
  mime_type,
  byte_size,
  sha256,
  width,
  height,
  policy_id,
  created_at,
  created_by
FROM scan_readability_derivatives_v1;

DROP TABLE scan_readability_derivatives_v1;

CREATE INDEX scan_readability_derivatives_fingerprint_idx
ON scan_readability_derivatives(sha256, byte_size, source_media_id);

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

CREATE TRIGGER validate_new_scan_fingerprint
BEFORE INSERT ON media_objects
WHEN NEW.kind = 'scan'
  AND (
    NEW.sha256 IS NULL
    OR length(NEW.sha256) <> 64
    OR NEW.sha256 <> lower(NEW.sha256)
    OR NEW.sha256 GLOB '*[^0-9a-f]*'
    OR EXISTS (SELECT 1 FROM scan_fingerprints WHERE sha256 = NEW.sha256)
    OR EXISTS (
      SELECT 1 FROM scan_readability_derivatives
      WHERE sha256 = NEW.sha256 AND byte_size = NEW.byte_size
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate_or_invalid_scan_fingerprint');
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
    OR EXISTS (
      SELECT 1 FROM scan_readability_derivatives
      WHERE sha256 = NEW.sha256 AND byte_size = NEW.byte_size
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate_or_invalid_scan_fingerprint');
END;

CREATE TRIGGER validate_scan_readability_selection_insert
BEFORE INSERT ON scan_readability_selections
WHEN NOT EXISTS (
  SELECT 1
  FROM media_objects
  WHERE media_objects.id = NEW.source_media_id
    AND media_objects.kind = 'scan'
    AND media_objects.sha256 = NEW.source_sha256
    AND media_objects.byte_size = NEW.source_byte_size
    AND (
      (
        NEW.representation_kind = 'source'
        AND media_objects.mime_type = 'image/jpeg'
        AND NEW.source_width <= 2400
        AND NEW.source_height <= 2400
        AND NOT EXISTS (
          SELECT 1 FROM scan_readability_derivatives
          WHERE source_media_id = NEW.source_media_id
        )
      )
      OR
      (
        NEW.representation_kind = 'derivative'
        AND EXISTS (
          SELECT 1
          FROM scan_readability_derivatives
          WHERE source_media_id = NEW.source_media_id
            AND source_sha256 = NEW.source_sha256
            AND source_byte_size = NEW.source_byte_size
            AND byte_size = NEW.candidate_byte_size
            AND object_key
              = 'scans/readability-v2/' || NEW.source_media_id || '.jpg'
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_scan_readability_selection');
END;

CREATE TRIGGER prevent_derivative_for_direct_scan_readability
BEFORE INSERT ON scan_readability_derivatives
WHEN EXISTS (
  SELECT 1
  FROM scan_readability_selections
  WHERE source_media_id = NEW.source_media_id
    AND representation_kind = 'source'
)
BEGIN
  SELECT RAISE(ABORT, 'direct_scan_readability_cannot_have_derivative');
END;

CREATE TRIGGER prevent_selected_scan_readability_derivative_delete
BEFORE DELETE ON scan_readability_derivatives
WHEN EXISTS (
  SELECT 1
  FROM scan_readability_selections
  WHERE source_media_id = OLD.source_media_id
    AND representation_kind = 'derivative'
)
BEGIN
  SELECT RAISE(ABORT, 'selected_scan_readability_derivative_is_retained');
END;

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
    OR (
      EXISTS (
        SELECT 1 FROM portable_export_item_chunks WHERE export_id = OLD.id
      )
      AND EXISTS (
        SELECT 1 FROM portable_export_items WHERE export_id = OLD.id
      )
    )
    OR NEW.item_count <> CASE
      WHEN EXISTS (
        SELECT 1 FROM portable_export_item_chunks WHERE export_id = OLD.id
      ) THEN COALESCE((
        SELECT SUM(item_count)
        FROM portable_export_item_chunks
        WHERE export_id = OLD.id
      ), 0)
      ELSE (
        SELECT COUNT(*) FROM portable_export_items WHERE export_id = OLD.id
      )
    END
    OR NEW.planned_bytes <> CASE
      WHEN EXISTS (
        SELECT 1 FROM portable_export_item_chunks WHERE export_id = OLD.id
      ) THEN COALESCE((
        SELECT SUM(planned_bytes)
        FROM portable_export_item_chunks
        WHERE export_id = OLD.id
      ), 0)
      ELSE COALESCE((
        SELECT SUM(byte_size)
        FROM portable_export_items
        WHERE export_id = OLD.id
      ), 0)
    END
    OR EXISTS (
      SELECT 1
      FROM scans
      LEFT JOIN scan_readability_selections
        ON scan_readability_selections.source_media_id = scans.media_id
      WHERE scan_readability_selections.source_media_id IS NULL
    )
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
        OR object_key IS NULL
        OR length(object_key) NOT BETWEEN 1 AND 1024
        OR instr(object_key, char(0)) <> 0
        OR instr(object_key, char(10)) <> 0
        OR instr(object_key, char(13)) <> 0
    )
    OR EXISTS (
      SELECT 1
      FROM scan_readability_derivatives
      WHERE byte_size <= 0
        OR sha256 IS NULL
        OR length(sha256) <> 64
        OR sha256 <> lower(sha256)
        OR sha256 GLOB '*[^0-9a-f]*'
        OR object_key IS NULL
        OR length(object_key) NOT BETWEEN 1 AND 1024
        OR instr(object_key, char(0)) <> 0
        OR instr(object_key, char(10)) <> 0
        OR instr(object_key, char(13)) <> 0
    )
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT object_key FROM media_objects
        UNION ALL
        SELECT object_key FROM scan_readability_derivatives
      )
      GROUP BY lower(rtrim(object_key, ' .'))
      HAVING COUNT(*) > 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'portable_export_precondition_failed');
END;
