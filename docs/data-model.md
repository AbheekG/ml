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
Scan ── optional Notebook
```

## Core records

- `songs` stores titles, notes, status, revision, audit fields, and Trash state.
- `lyric_texts` stores required content, stable automatic order, audit/Trash fields, and a hidden `user`/`legacy_import` origin. Existing combined workbook text remains intact; editors do not classify language, script, representation, or label.
- `scans` references exactly one private media object and exposes optional Notebook/Page metadata. Imported Source, Version, Date, ScanText, and Notes remain preserved in hidden `legacy_*` columns but are not part of the initial editor model.
- `recordings` stores one required, normalized-unique per-Song description, optional recorded date and contributors, processing state, an original media object, and an optional playback object. Imported Version and the four populated Notes are combined losslessly for display and also remain in hidden `legacy_*` columns.
- `media_objects` stores private R2 object metadata and recovery state; binary data does not enter D1.
- `people`, `song_credits`, and `recording_credits` model contributors and roles.
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
- Browser playback uses the original only when its detected container/codec is in the canonical supported set.
- Other inputs receive a generated MP3 `playback_audio` derivative; conversion never replaces or deletes the original.
- File signatures and decodability are checked from content rather than trusting filename extensions.
- SHA-256 is recorded for upload verification and duplicate detection. Equal content does not automatically merge distinct historical records.
- Files present on disk but absent from the workbook are quarantined for review and are not silently uploaded or deleted.
