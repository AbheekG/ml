# Music Library product plan

Status: approved starting direction, intentionally refined through real-device feedback. This document defines the replacement product, not an AppSheet screen-for-screen copy.

## Product goal

Create a small private music library for a few trusted users. It must work as an installable PWA on iPhone, iPad, Android, and desktop browsers. Catalog data and typed lyrics must remain readable offline; scans and recordings may require a connection. Writes are online-only.

The product should optimize for:

1. quickly finding a song;
2. comfortably reading everything known about it;
3. reliable scan viewing and audio playback;
4. simple, safe maintenance by one primary editor;
5. very low hosting and operational overhead.

## Design principles

- Make the song catalog the center of the application. Tags, people, languages, and notebooks are filters into that catalog, not separate navigation destinations unless later usage proves otherwise.
- Prefer a clear, responsive list and detail view over dashboards.
- Keep the default presentation quiet; reveal advanced filters and less-used metadata on demand.
- Preserve the workbook's normalized concepts while improving database integrity.
- Keep media private and online. Never delay catalog startup by downloading audio or scans.
- Make offline state explicit and predictable. Reading works; writing controls do not.
- Design for one editor now without preventing more role-based editors later.
- Preserve imported text and media exactly. Normalize references during import, not legacy source files.

## Information architecture

The initial application has two top-level destinations:

1. **Songs** — the main catalog, filtering, sorting, and basic search.
2. **Account/settings** — session, offline catalog status, last successful sync, storage/version information, and logout.

**Add song** is a prominent online-only editor action on the catalog, not a permanent navigation destination. “Recently viewed” can be added later as a local convenience if real use justifies it.

There are no top-level Recordings or Scans pages in the initial release. Those records only make sense in the context of their parent song. A future administration screen may expose them for cleanup without changing the public information architecture.

## Main catalog

### Default list

Default sort: transliterated/Latin title, ascending, using case-insensitive natural collation.

Each song row/card shows:

- Latin/transliterated title as the primary label;
- native title beneath it when present;
- language;
- a small number of optional tag chips;
- compact indicators for typed lyrics, scans, and recordings;
- no audit or verbose notes by default.

At the current and expected scale, the complete locally cached catalog can be filtered without server round trips.

### Search

The first release includes immediate local substring search over Latin title, native title, aliases, and typed lyrics. Advanced typo-tolerant phonetic/transliteration ranking is a later phase based on the woodchime and AppSheet experiments plus owner-provided expected results.

Search and filters operate together on the same catalog. A separate search-results page is unnecessary unless later usability testing shows a benefit.

### Filters

Filters open in a mobile sheet or desktop side panel. Proposed filters:

- language;
- tag;
- person, optionally narrowed by credit role;
- notebook (songs having at least one scan from that notebook);
- status, if status remains meaningful;
- has typed lyrics;
- has scans;
- has recordings;
- created/updated date range later, if useful.

Selected filters appear as removable chips above the result list. “Clear all” is always available. Clicking a language, tag, person, or notebook from a song detail opens this same catalog with the corresponding filter applied.

### Sorting

Initial sort options:

- Latin title A–Z / Z–A;
- native title A–Z / Z–A;
- most recently updated;
- most recently created.

Notebook page ordering belongs in scan presentation, not the song catalog's general sort menu.

### Display options

Start with one polished compact list. A small display menu may later control optional secondary fields rather than building multiple list/gallery modes before they are needed.

## Song detail

The detail screen is one scrollable page with a compact sticky section navigator on smaller devices. Proposed sections:

### Header and overview

- Latin and native titles;
- aliases, languages, tags, and status;
- lyricist/composer credits;
- song notes;
- edit action for authorized online editors;
- audit summary such as last updated time, with detailed user metadata kept unobtrusive.

Languages, tags, and people are clickable filters back into the catalog.

### Typed lyrics

Typed lyrics are structured Song children rather than one overloaded Song column. A Song can have any number of lyric texts. Each record has required preformatted Unicode content, stable automatic order, revision/audit metadata, and recoverable Trash state.

Language, script, representation, and labels are not required editor-facing classifications. In this collection they are usually apparent from the Song and the text itself, while mandatory classification would add work and viewer clutter without a demonstrated workflow benefit. Blocks appear sequentially in a stable automatic order so viewers can scroll through them. Editing uses a large plain-text field and preserves capitalization, spaces, and line breaks exactly.

The first migration stores each existing workbook `LyricsTyped` block intact and marks its legacy origin internally. It must not guess where one language or script ends. Editors can later split each imported block into suitable new lyric records and remove the imported block, with a way to find the remaining legacy records until that cleanup is complete.

### Scans

- thumbnail grid or compact list;
- show optional notebook/page where present and otherwise treat the Scan as external;
- group notebook scans naturally by notebook and page when useful, with stable creation order as fallback;
- full-screen viewer with zoom and next/previous navigation;
- clear online-only message when offline;
- editor actions to add, edit metadata, replace a file, move to Trash, or restore.

### Recordings

- one card per recording with its required description, optional date, and contributors where available;
- reliable inline play/pause/seek;
- only one recording plays at a time;
- prepare any required playback derivative once before the Recording becomes ready; pressing Play never starts transcoding;
- use runtime browser media-capability checks only to choose or verify already stored sources;
- persistent mini-player while navigating within the song is optional for the first release;
- clear online-only message when offline;
- editor actions to add, edit metadata, replace audio, move to Trash, or restore.

Mixed legacy formats remain preserved. Import or post-upload processing creates and verifies a browser-compatible playback derivative once when needed, stores it privately, and never discards the original. Playback only streams an already prepared source.

## Editing workflow

- All writes require connectivity and an authenticated editor role.
- Offline mode visibly disables add, edit, Trash, restore, and upload controls.
- Use explicit Save/Cancel actions and warn before discarding unsaved changes.
- Song metadata is edited in one form.
- Lyric texts, scans, and recordings are added from inside a song detail, so the parent is implicit and cannot be omitted or changed accidentally.
- Lookup administration for tags, people, languages, and notebooks can be added after the primary song workflow works.
- Use indefinite Trash/restore in normal UI. Permanent deletion is absent from ordinary workflows and may be added later only as an exceptional administrator cleanup operation after backups and relationship checks.

## Domain model

### Song

Core fields imported from the workbook:

- stable song ID;
- Latin/transliterated title;
- native title;
- aliases;
- status;
- notes;
- created/updated timestamps and user identities.

Song relationships:

- many-to-many languages;
- many-to-many tags;
- one-to-many song credits linking people and roles;
- one-to-many lyric texts;
- one-to-many scans;
- one-to-many recordings.

### Lyric text

A Lyric text is a strict Song child containing one preserved text block. Its mandatory Song foreign key prevents orphaning. Content is required and its order is assigned automatically. Labels and language/script/representation classification are not required.

### Scan

A Scan is an independent child record because one Song can have many images/pages. Its Song foreign key and media file are mandatory. Notebook and short-text Page are optional; selecting a Notebook identifies a notebook scan, while no Notebook identifies an external scan. A separate Source field, Version, captured Date, ScanText, and Scan Notes are not exposed in the initial editor.

### Recording

A Recording is an independent child record because one Song can have multiple composition-stage fragments, old tunes, alternate takes, accompaniment tracks, and finished performances. Its Song foreign key and original file are mandatory. One required Recording description replaces the overlapping legacy Version and Notes fields; a stable `Recording N` fallback is generated when the editor supplies no description. Recorded date and contributors remain optional.

### Lookups and credits

- People are canonical records.
- Song credits link a person to a song with contribution labels such as Lyrics or Music, backed by stable `lyrics`/`music` codes.
- Recording credits link a person to a recording with a contribution label such as Vocals, backed by a stable `vocals` code; this table is supported even though it is currently empty, and instrument/production roles can be added when actually needed.
- Tags, languages, and notebooks are canonical lookup records.
- Join tables replace comma-separated reference lists in the runtime database.

### Users and roles

Maintain an allowlisted application-user record keyed by authenticated email/identity:

- `admin`: manages users/lookups and exceptional recovery operations;
- `editor`: creates and edits songs and children;
- `viewer`: reads the catalog and media.

One owner may initially hold both admin and editor responsibilities. Every mutation records actor and timestamp.

## Relationship and deletion rules

The AppSheet parent/child concept is correct and should be retained with stronger database guarantees:

- every Scan has exactly one Song;
- every Recording has exactly one Song;
- every Lyric text has exactly one Song;
- none can exist orphaned;
- adding children happens through their Song;
- removing a Lyric text, Scan, or Recording moves it to Trash and retains recoverable data indefinitely for now;
- moving a Song to Trash is blocked while any active Lyric text, Scan, or Recording exists; the UI identifies and links to what must be trashed first;
- permanent Song deletion is blocked while any child exists, including trashed children;
- there is no cascading Song deletion;
- removing an otherwise active-child-free Song moves it to Trash before any later permanent cleanup;
- replacing media uploads the new object and commits the database change before the old object becomes eligible for cleanup.

## Offline and synchronization behavior

Cache locally:

- app shell;
- songs and all lyric texts;
- scan and recording metadata, but not their large files;
- people, credits, tags, languages, and notebooks;
- enough authorization/session state to permit offline reading on a previously authorized device.

Do not guarantee offline availability for scans or recordings. Previously opened browser media may happen to remain cached, but product behavior must not depend on it.

On launch:

1. render the last local catalog immediately;
2. detect connectivity;
3. when online and authenticated, fetch catalog changes in the background;
4. atomically update the local cache;
5. show last successful sync and any error without blocking offline reading.

Logout clears private local catalog data. Online session expiry prompts reauthentication when the next server operation is attempted.

## Initial release scope

Included:

- private login and persistent trusted-device session;
- viewer/editor/admin roles, with one primary editor configured;
- installable responsive PWA;
- immediate offline catalog and typed-lyrics reading after first sync;
- song catalog with basic local search, filters, and sorting;
- complete song detail;
- private scan viewer and recording player while online;
- online create/edit/trash/restore for songs, lyric texts, scans, and recordings;
- audit identity/timestamps;
- AppSheet importer with dry-run reconciliation;
- migration and real-device acceptance checks.

Deferred:

- offline editing and conflict resolution;
- advanced phonetic/transliteration ranking;
- OCR, transcription, automatic transliteration, or authoritative automatic language detection;
- push notifications;
- playlists/set lists/favorites unless requested;
- recently viewed history unless requested;
- public sharing;
- native App Store packages;
- elaborate dashboards or multiple visual themes.

## Delivery sequence

### Phase 0 — product and data direction (complete)

Use the approved catalog-first design, structured Lyric-text children, guarded deletion, and iterative feedback model as the starting direction. Do not reproduce AppSheet's visual design.

### Phase 1 — migration foundation

Define the runtime schema and build an idempotent, dry-run importer. Reconcile every table and media reference while applying known lookup-case mappings. No legacy data is edited.

### Phase 2 — read-only vertical slice

Build authentication, installation, local catalog cache, list/filter/basic-search experience, song detail, scan viewing, and recording playback using a copy of real data. Validate on Safari/iPhone or iPad and Chrome/Android.

### Phase 3 — online editing

Add roles, song forms, typed-lyric editing, child add/edit/upload, trash/restore, guarded Song deletion, audit metadata, validation, and failure-safe media replacement.

### Phase 4 — private beta and migration

Invite the small user group, reconcile final data, test backups/recovery, freeze AppSheet writes, perform final import, and retain AppSheet/Drive as a read-only fallback.

### Phase 5 — search improvement

Turn real queries into automated ranking tests. Port and correct the useful normalization, Bengali transliteration, phonetic, token, and n-gram ideas from both legacy attempts. Keep all ranking local.

## Initial acceptance criteria

- After one successful online login/sync, airplane mode still permits app launch, catalog browsing, filtering, basic search, and typed-lyrics reading.
- Offline UI clearly marks scans/audio as online-only and exposes no enabled write control.
- Every imported row and referenced media object is reconciled; no child is orphaned.
- A viewer cannot mutate data or retrieve arbitrary private media.
- An editor can create/edit a song, attach a scan and recording, and see actor/timestamp metadata.
- An editor can add, edit, trash, and restore separate typed-lyric blocks, which viewers see sequentially in stable automatic order.
- Moving a Song to Trash is refused while any active lyric text, scan, or recording exists; permanent deletion is refused while any child record exists at all.
- Audio play, pause, and seek work on supported real iOS/iPadOS and Android devices.
- A failed file replacement cannot lose the old working media.
- Logout removes the cached private catalog from that browser profile.

## Product defaults to validate through use

- Person filtering starts with “any role” and optionally narrows to Lyrics, Music, Vocals, or future contribution roles.
- Status is preserved in the database but hidden from ordinary views until meaningful states are defined; imported `draft` values are not discarded.
- Catalog rows initially show Latin title, native title, language, and compact lyric/scan/recording indicators. Tag display is restrained to avoid clutter.
- These choices are deliberately easy to change after the first real-device prototype. Feedback from actual browsing, editing, sharing, and playback outranks speculative completeness.
