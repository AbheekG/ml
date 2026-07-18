ALTER TABLE scans
ADD COLUMN rotation_quarter_turns INTEGER NOT NULL DEFAULT 0
  CHECK (rotation_quarter_turns IN (0, 1, 2, 3));
