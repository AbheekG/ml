# Data model

The runtime model keeps the useful AppSheet concepts while replacing spreadsheet reference lists with relational constraints. `migrations/` is the authoritative database definition.

```text
Song
├── Lyric text[]
├── Scan[] ── Media object
├── Recording[] ── Original media object
│                └─ Optional playback media object
├── Song credit[] ── Person
├── Language[]
├── Tag[]
└── Alias[]

Recording ── Recording credit[] ── Person
Recording upload session ── Uploaded part[] / pending Recording credit[]
Recording ── Audio processing job
Scan ── optional Notebook
```

## Core records

- `songs` stores titles, notes, status, revision, audit fields, Trash state, and a latest-mutation identifier used to make optimistic multi-table edits safe.
- `lyric_texts` stores required content, stable automatic order, audit/Trash fields, and a hidden `user`/`legacy_import` origin. Existing combined workbook text remains intact; editors do not classify language, script, representation, or label.
- `scans` references exactly one private media object and exposes optional Notebook/Page metadata. Imported Source, Version, Date, ScanText, and Notes remain preserved in hidden `legacy_*` columns but are not part of the initial editor model.
- `recordings` stores one required, normalized-unique per-Song description, optional recorded date and contributors, processing state, an original media object, and an optional playback object. Imported Version and the four populated Notes are combined losslessly for display and also remain in hidden `legacy_*` columns.
- `media_objects` stores private R2 object metadata and recovery state; binary data does not enter D1.
- `audio_derivatives` immutably binds each playback-audio media object to its original-audio source, conversion-policy ID, and the verified source/derivative hashes and byte sizes.
- `recording_upload_sessions`, `recording_upload_parts`, and `recording_upload_credits` durably retain an editor-owned multipart request, only the R2-returned part ETags, intended metadata, revisions, and terminal outcome. Finalization rechecks duplicates and atomically binds a verified stored session to its exact media, processing Recording, copied credits, and pending job. Private object keys, multipart IDs, ETags, hashes, and generated catalog/job IDs are never browser inputs.
- `audio_processing_jobs` durably binds one processing Recording to the exact original media ID/hash/size and conversion policy. Attempt counts, expiring leases, results, and privacy-safe failure codes follow a database-enforced retry state machine. Migration `0007` rejects already-expired running leases and rejects expired-lease recovery or editor retry unless the exact active source Recording is back in `processing` state. Migration `0008` permits only one global `running` row, rejects recovery before lease expiry, and rejects automatic recovery after the third expired attempt so the Worker must checkpoint a durable `processing_lease_expired` failure before an editor can retry.
- `people`, `song_credits`, and `recording_credits` model contributors using stable contribution codes (`lyrics`, `music`, `vocals`, and later instrument/production codes) with friendly display labels.
- `languages`, `tags`, and `notebooks` are controlled lookup records.
- join tables model Song languages and tags without comma-separated IDs.
- `app_users` stores viewer/editor/admin authorization independently of historical audit identity strings.

## Integrity and deletion

- Lyric texts, scans, and recordings require an existing Song foreign key.
- No foreign key cascades from Song.
- A database trigger rejects permanent Song deletion while any Lyric text, Scan, or Recording exists, including trashed children.
- Media objects cannot be deleted while referenced.
- Normal application removal sets Trash metadata; later permanent cleanup is an explicit administrator process.
- Revisions support optimistic edit-conflict detection when online editing is added.
- Song Trash is also blocked while a Recording upload is live, stored but not finalized, or awaiting duplicate review. Recording Trash is blocked while its processing job is pending or running.

## Import pipeline

`scripts/appsheet-import.ts`:

1. reads every workbook sheet;
2. validates expected columns and unique keys;
3. checks every relationship and media reference;
4. applies only documented ID mappings (`BN` → `bn`, `O1` → `o1`);
5. preserves legacy lyric content exactly;
6. converts workbook relations into normalized arrays;
7. reports counts/errors without printing song content;
8. writes private output only when `--write` is supplied.

`scripts/load-local-db.ts` creates a temporary database, applies every numbered migration in order, imports all normalized rows in one transaction, runs `PRAGMA foreign_key_check`, and atomically replaces the ignored local database only after success.

## Media preservation and playback

- Every uploaded recording keeps its original bytes as an immutable `original_audio` media object.
- Browser playback normally uses a valid detected MP3 original directly. Other inputs receive a generated MP3 `playback_audio` derivative; a narrowly defined oversized/high-bit-rate MP3 may also receive one only when the verified result is materially smaller. Conversion never replaces or deletes the original.
- The exact preferred-source, quality, validation, and oversized-MP3 rules are defined in [audio-processing.md](audio-processing.md).
- File signatures and decodability are checked from content rather than trusting filename extensions.
- SHA-256 is recorded for upload verification and duplicate detection. Equal content does not automatically merge distinct historical records.
- A Recording may point directly to its original media or to a playback derivative whose `audio_derivatives` provenance row names that same original. Database guards reject unrelated playback objects and later hash/size changes that would invalidate recorded provenance.
- New Scan creation currently accepts verified JPEG, PNG, or WebP files up to 25 MB, stores the original privately, and rejects an existing Scan fingerprint before uploading. If D1 finalization fails after R2 storage, the uncommitted object is removed. Readability-sized image derivatives and replacement are separate later work.
- Imported Scan fingerprints are prepared by a local, dry-run-by-default planner
  that reconciles every Scan/media relationship, verifies the catalog byte size,
  hashes source bytes without loading whole files into memory, and writes details
  only under ignored private paths when explicitly requested. It reports equal
  hashes for review but never merges distinct historical records. Applying the
  guarded database backfill is a separate exact-plan-confirmed local command. It
  re-runs source reconciliation, checks each live Scan/media relationship, and
  updates only null hashes in one rollback-safe transaction; exact reruns are
  idempotent. The executor is restricted to local/temporary SQLite files and has
  no D1/R2 client. No remote migration or catalog mutation is part of this flow.
- Files present on disk but absent from the workbook are quarantined for review and are not silently uploaded or deleted.
