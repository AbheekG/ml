PRAGMA foreign_keys = ON;

-- A unique per-request marker lets every related join-table statement prove
-- that its optimistic Song update won the revision check. It intentionally
-- remains on the row as harmless mutation provenance for the latest edit.
ALTER TABLE songs ADD COLUMN last_mutation_id TEXT;
