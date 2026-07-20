PRAGMA foreign_keys = ON;

CREATE INDEX scan_readability_derivatives_fingerprint_idx
ON scan_readability_derivatives(sha256, byte_size, source_media_id);

-- A stored readability JPEG is another byte-exact representation of its Scan.
-- Prevent those exact bytes from becoming a new Scan original while preserving
-- the existing global original-fingerprint registry.
DROP TRIGGER IF EXISTS validate_new_scan_fingerprint;

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

DROP TRIGGER IF EXISTS validate_media_becoming_scan;

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
