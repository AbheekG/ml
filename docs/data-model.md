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
Recording upload session ── immutable create/replace intent
                         ├── Uploaded part[]
                         └── pending Recording credit[]
Recording ── Audio processing job[] ── dispatch attempt[]
Scan ── optional Notebook
  └── fingerprint member / readability derivative
```

## Core records

- `songs` stores titles, notes, status, revision, audit fields, Trash state, and a latest-mutation identifier used to make optimistic multi-table edits safe.
- `lyric_texts` stores required content, stable automatic order, audit/Trash fields, and a hidden `user`/`legacy_import` origin. Existing combined workbook text remains intact; editors do not classify language, script, representation, or label.
- `scans` references exactly one private media object and exposes optional Notebook/Page metadata plus a constrained `0`–`3` clockwise display orientation. Imported Source, Version, Date, ScanText, and Notes remain preserved in hidden `legacy_*` columns but are not part of the initial editor model.
- `recordings` stores one required, normalized-unique per-Song description, optional recorded date and contributors, processing state, an original media object, and an optional playback object. Imported Version and the four populated Notes are combined losslessly for display and also remain in hidden `legacy_*` columns.
- `media_objects` stores private R2 object metadata and recovery state; binary data does not enter D1.
- `audio_derivatives` immutably binds each playback-audio media object to its original-audio source, conversion-policy ID, and the verified source/derivative hashes and byte sizes.
- `recording_upload_sessions`, `recording_upload_intents`, `recording_upload_parts`, and `recording_upload_credits` durably retain an editor-owned multipart request, its immutable create/replace target, only the R2-returned part ETags, intended metadata, revisions, and terminal outcome. Finalization rechecks duplicates and atomically creates or updates the exact Recording, preserves replacement history, copies credits, and creates the policy-bound pending job. Private object keys, multipart IDs, ETags, hashes, and generated catalog/job IDs are never browser inputs.
- `audio_processing_jobs` durably binds a processing Recording to the exact original media ID/hash/size and conversion policy. Attempt counts, expiring leases, results, and privacy-safe failure codes follow a database-enforced retry state machine. Uniqueness is not enforced per recording (removed in migration `0010` to allow historical jobs from audio replacements). Migration `0007` rejects already-expired running leases and rejects expired-lease recovery or editor retry unless the exact active source Recording is back in `processing` state. Migration `0008` permits only one global `running` row, rejects recovery before lease expiry, and rejects automatic recovery after the third expired attempt so the Worker must checkpoint a durable `processing_lease_expired` failure before an editor can retry.
- `audio_processing_dispatch_attempts` is the immutable audit trail for immediate Cloud Run invocation. A pending job creates a `started` attempt, which transitions once to `accepted` or a bounded failure code; failed dispatch never changes the pending job, so Scheduler can recover it.
- `scan_fingerprints` and `scan_fingerprint_members` form the global race-safe content registry. New duplicate bytes are rejected; duplicate imported history is preserved and marked instead of merged.
- `scan_readability_derivatives` immutably binds a private bounded JPEG derivative to the exact source hash/size and policy. `scan_maintenance_failures` records bounded retry state and `scan_maintenance_leases` prevents overlapping repair runs from racing on one object.
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
- Recording source replacement is blocked while processing is active. Scan/Recording replacement history is immutable, and historical media remains referenced/recoverable.

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
- New Scan creation/replacement accepts verified JPEG, PNG, or WebP files up to 20,000,000 bytes, fully decodes them through the Cloudflare Images binding, stores the private original, and creates a correctly oriented JPEG derivative with longest edge at most 2400 pixels at quality 85. Exact content is rejected globally before upload and again by D1 to close races. If storage or D1 finalization fails, both uncommitted objects and rows are removed while prior media remains unchanged.
- Saved quarter-turn corrections are browser presentation metadata. Viewers may rotate locally; editors may persist the absolute orientation with revision/audit guards. Neither the original nor readability derivative is rewritten, and current-view sharing creates only a temporary browser JPEG. The exact behavior is defined in [scan-orientation.md](scan-orientation.md).
- Imported Scan fingerprints are prepared by a local, dry-run-by-default planner
  that reconciles every Scan/media relationship, verifies the catalog byte size,
  hashes source bytes without loading whole files into memory, and writes details
  only under ignored private paths when explicitly requested. It reports equal
  hashes for review but never merges distinct historical records. Applying the
  guarded database backfill is a separate exact-plan-confirmed local command. It
  re-runs source reconciliation, checks each live Scan/media relationship, and
  updates only null hashes in one rollback-safe transaction; exact reruns are
  idempotent. The executor is restricted to local/temporary SQLite files and has
  no D1/R2 client. Staging uses a separate bounded Worker maintenance path to
  hash the retained source bytes, preserve historical duplicates, and generate
  private derivatives without modifying any legacy input.
- Files present on disk but absent from the workbook are quarantined for review and are not silently uploaded or deleted.
