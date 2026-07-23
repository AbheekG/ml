PRAGMA foreign_keys = ON;

-- Keep persisted Recording dates in the same canonical YYYY-MM-DD form already
-- required for upload intents.
DROP TRIGGER IF EXISTS validate_recording_values_insert;
DROP TRIGGER IF EXISTS validate_recording_values_update;

CREATE TRIGGER validate_recording_values_insert
BEFORE INSERT ON recordings
WHEN NEW.description IS NULL
  OR length(trim(NEW.description)) = 0
  OR NEW.normalized_description IS NULL
  OR length(trim(NEW.normalized_description)) = 0
  OR (NEW.recorded_on IS NOT NULL AND (
    date(NEW.recorded_on) IS NULL
    OR date(NEW.recorded_on) <> NEW.recorded_on
    OR date(NEW.recorded_on) > date('now', '+5 hours', '+30 minutes')
  ))
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
  OR (NEW.recorded_on IS NOT NULL AND (
    date(NEW.recorded_on) IS NULL
    OR date(NEW.recorded_on) <> NEW.recorded_on
    OR date(NEW.recorded_on) > date('now', '+5 hours', '+30 minutes')
  ))
  OR (NEW.processing_state = 'failed' AND length(trim(COALESCE(NEW.processing_error, ''))) = 0)
  OR (NEW.processing_state <> 'failed' AND NEW.processing_error IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid_recording_values');
END;
