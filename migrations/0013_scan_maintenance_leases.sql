CREATE TABLE scan_maintenance_leases (
  media_id TEXT PRIMARY KEY REFERENCES media_objects(id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL UNIQUE CHECK (length(lease_token) BETWEEN 32 AND 100),
  leased_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  CHECK (lease_expires_at > leased_at)
);

CREATE INDEX scan_maintenance_leases_expiry_idx
ON scan_maintenance_leases(lease_expires_at, media_id);

-- When a historical duplicate's canonical member is ever removed during an
-- explicitly approved cleanup, promote the replacement member consistently.
DROP TRIGGER unregister_deleted_scan_fingerprint;

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

  UPDATE scan_fingerprint_members
  SET is_historical_duplicate = 0
  WHERE media_id = (
    SELECT canonical_media_id
    FROM scan_fingerprints
    WHERE sha256 = OLD.sha256
  );

  DELETE FROM scan_fingerprints
  WHERE sha256 = OLD.sha256
    AND NOT EXISTS (
      SELECT 1 FROM scan_fingerprint_members WHERE sha256 = OLD.sha256
    );
END;
