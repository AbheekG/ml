# Editing and validation rules

This document records the implemented and owner-confirmed online-editing business rules. The legacy AppSheet design and workbook remain evidence, but existing completeness alone does not prove that a field should be required.

Rules should be enforced at every relevant layer:

- the form should prevent or clearly explain invalid input;
- the API must reject invalid writes even if the form is bypassed;
- D1 should enforce durable relational and value constraints where practical.

## Confirmed rules

### Songs

- The Latin/transliterated title is required. The native-script title is optional.
- Latin/transliterated titles are automatically normalized to title case because editors may enter inconsistent capitalization. Leading/trailing whitespace and repeated internal spaces are also normalized.
- Two Songs cannot currently have the same normalized Latin/transliterated title. Revisit this later if legitimate same-title Songs occur; do not silently merge them.
- A Song must have at least one Language before it can be saved. Multiple Languages are allowed, Languages must come from the controlled Language lookup, and no primary Language is required.
- Song Status is required and restricted to `draft` or `checked`, with `draft` selected for new Songs. It remains useful for finding unverified/incomplete Songs; revisit the workflow if more states are actually needed.
- Tags are optional and must come from the controlled Tag lookup.
- The initial Song form may show Tags as checkboxes while the lookup is small. When the list grows, replace them with an accessible searchable multi-select: typing filters existing Tags, selecting one adds a removable chip, and the editor can continue typing to add more. Keep Tag creation in the dedicated lookup-management workflow rather than accepting arbitrary new values in the Song form.
- Aliases are an optional list of alternative transliterations for later search. Normalize them to title case, remove repeated whitespace, and prevent normalized duplicates within the same Song.
- Notes are optional free-form text.
- A Song cannot be permanently deleted while any typed lyric, scan, or recording exists, including trashed children. The user must remove those children first.

### Controlled lookup records

- Editors and administrators may manage Languages, Tags, Notebooks, and People through dedicated management screens. Song/child forms select existing values rather than accepting hidden free-form lookup values.
- Lookup display names are required and whitespace-normalized. Preserve editor-entered capitalization because People, acronyms, and Notebook codes may have intentional casing; lookup management warns about capitalization-only duplicates instead of rewriting the display name.
- Block exact normalized duplicates, ignoring capitalization and repeated surrounding/internal spaces. Show likely similar existing names before allowing a genuinely different value to be created.
- Do not delete a Language, Tag, Notebook, or Person while another record references it.

### Typed lyrics

- A Song may have zero or more typed-lyric records. Each record is a strict child of exactly one Song.
- Content is required when a typed-lyric record exists. Preserve capitalization, Unicode text, spaces, blank lines, and line breaks exactly as entered; title normalization never applies to lyric content.
- Do not require the editor to choose lyric language, script, or representation. Those classifications add work and visual clutter without a current filtering or display need.
- Do not create an exact duplicate lyric block within the same Song. Duplicate comparison may normalize line-ending encoding for comparison but must not rewrite the stored content.
- Existing combined workbook lyrics remain intact for now and carry a hidden legacy-import marker. Later provide a deliberate workflow to split each block into suitable new lyric records, replace/trash the imported block, and find all legacy blocks still awaiting cleanup.
- Lyric blocks have no required label and no manual ordering control. Assign a stable order automatically, append new blocks after existing ones, and show active blocks sequentially for scrolling.
- Read views omit the entire typed-lyrics section when no active lyric record exists.

### People and credits

- People are shared controlled lookup records used by both Song credits and Recording contributors.
- Song credits are optional. A credit requires a Person and a contribution Role; initial display labels are `Lyrics` and `Music`. Store these as stable internal codes `lyrics` and `music`; `lyrics` replaces the legacy `Writer` label. The same Person may hold both Roles on one Song, but the same Song/Person/Role combination cannot be duplicated.
- Recording contributors are optional and may remain unused. Retain the flexible Person/Role relationship for future singers and instrumental performers, but omit an empty contributor section from reading views.
- When the first Recording contributor is added, default the display Role to `Vocals`, stored as the stable internal code `vocals`. Add controlled contribution codes and display labels for instruments/production such as Guitar, Drums, or Piano only when actual use requires them rather than pre-populating an unused taxonomy.
- Contributor editing uses compact repeatable rows: search and choose an existing Person, choose one of the currently supported Roles, add the pair, and remove a row explicitly. Do not render the entire People lookup as a checkbox grid or allow a duplicate Person/Role pair.
- Credit records do not have editor-facing Notes. Song Notes remain available; Scan Notes are not exposed, and legacy Recording Notes are losslessly folded into Recording descriptions.

### Scans

- A Scan is a strict Song child and requires exactly one media file.
- Notebook is optional and selected from the controlled Notebook lookup. A selected Notebook identifies a notebook scan; no selected Notebook identifies an external scan, so editors do not need a separate Source field.
- Page is optional, appears only when a Notebook is selected, and is stored as normalized short text rather than a number so values such as `12A`, `cover`, or Roman numerals remain possible.
- Do not expose Scan Version, captured Date, extracted ScanText, or Scan Notes in the initial editor. Creation/audit time is automatic, OCR can be added later if useful, and only Song-level Notes are retained for now.
- Display notebook scans in natural Notebook/Page order when those values exist, followed by stable creation order. Empty optional Scan metadata and empty Scan sections remain hidden.
- Every reader may rotate a Scan clockwise in quarter turns for the current viewer session. Only an online editor/admin persists the absolute `0`–`3` display orientation; this is revision-guarded presentation metadata and does not modify the original or stored readability derivative. Replacing the Scan file resets the correction to zero. Current-view sharing applies the effective saved-plus-local orientation to the complete page in the browser. See [scan-orientation.md](scan-orientation.md).

### Recordings

- A Recording is a strict Song child and requires exactly one original audio file.
- Replace the legacy Version and Recording Notes inputs with one required `Recording description` field. It may contain a short distinguishing label or a longer explanation about an old tune, changed section, incomplete take, performer, accompaniment, or other recording context.
- When the editor supplies no description, generate the next available stable fallback such as `Recording 1`, `Recording 2`, and so on. Descriptions must be normalized-unique within one Song so every Recording remains distinguishable.
- Trim surrounding whitespace but do not title-case or otherwise rewrite description content. Include the description in later search behavior and show it above the audio player.
- Preserve every imported Version exactly. For the four imported Recording rows with separate Notes, append the Note to that Recording's description during the editing-schema migration without discarding either value.
- Recorded date remains optional and is hidden when absent. The shared library
  calendar is `Asia/Kolkata`: browser and server both use the current date in
  India as the latest allowed date. The field keeps its short normal label; only
  while the device and India have different dates does it show a compact India-
  date note. Stored values remain timezone-free calendar dates and are not
  converted or rewritten for viewers elsewhere.
- Recording contributors remain optional and hidden when absent. The original audio is retained, with a compatible playback derivative generated when required.

### Media upload and playback

- Treat an original upload filename as private provenance, not a reader-facing
  label. It may identify a newly selected local file or an editor-owned resumable
  upload, but ordinary Recording, Scan, viewer, and Trash presentation uses
  Recording description or Scan Notebook/Page/generic position instead. Retain
  the basename in storage metadata; do not replace it with an internal ID or
  erase it through a presentation-only change. See
  [media-filename-presentation.md](media-filename-presentation.md).
- Inspect actual file signatures/codecs rather than trusting extensions and calculate a SHA-256 content fingerprint before finalizing an upload.
- Reject an accidental exact-content duplicate and link to the existing record. When the same media legitimately belongs in another context, reuse the private stored object rather than uploading duplicate bytes.
- When an exact duplicate belongs to a trashed Scan or Recording, the duplicate
  panel may restore that existing child directly into the requested active Song.
  The same recovery is available contextually from Trash with a searchable
  destination-Song picker. It changes the existing child parent and Trash state
  atomically, reactivates its existing media rows, preserves IDs, metadata,
  credits, fingerprints, upload/replacement history, and private objects, and
  never creates or deletes a child or media row. An actual cross-Song move is
  recorded in an immutable parent-move audit row; restoring to the same parent is
  an ordinary restore. Active children cannot be re-parented through this path.
- Upload/validation/database finalization is atomic: a failed or incomplete upload cannot create an active orphan record or replace a working file.
- Always retain original audio privately. Normally play a valid MP3 original directly; generate one MP3 derivative for other formats and only for a materially reducible oversized MP3 under the thresholds in [audio-processing.md](audio-processing.md).
- Never transcode audio in response to a playback request. Asynchronous conversion uses a `processing` state and exposes the player only after the derivative is verified and the Recording becomes `ready`; a failed job preserves the original and reports a retryable error.
- The stored playback-media reference is the default browser source. Capability detection may verify or fall back among already prepared sources, but never changes the stored original or starts conversion.
- Generate correctly oriented, readability-preserving Scan derivatives suitable for A4 pages. Retain Scan originals until derivative quality and backups are accepted; only then consider a deliberate archival/deletion policy.
- The implemented Scan pipeline accepts browser-compatible JPEG, PNG, or WebP originals up to 20,000,000 bytes, verifies signatures and full decode, records SHA-256, rejects exact duplicates globally, retains immutable originals/replacement history, and prepares a private JPEG readability derivative before committing the new current media. The derivative is at most 2400 pixels on its longest edge at quality 85; the authenticated viewer falls back to the original only while historical repair is incomplete or has a recorded failure.
- Implemented one-tap Scan and Recording sharing sends authenticated, bounded
  derivative/playback bytes through the device share interface where supported,
  with safe fallbacks; it does not expose originals or create a permanent public
  media URL.

### General safety

- Editing is online-only. Offline devices remain read-only.
- Song, typed-lyric, Scan, Recording-metadata, and Recording-upload editors warn
  before dirty local state is discarded. Dirty forms remain mounted through a
  connectivity transition and are not overwritten on reconnect; this preserves
  local inputs only and does not create an offline mutation queue.
- Child records cannot exist without their parent Song.
- Ordinary removal uses a confirmed `Move to Trash` action; permanent deletion is not present in normal user/editor workflows.
- Trashed records disappear from ordinary views and remain recoverable from a dedicated Trash screen. Editors may restore them, and Trash is retained indefinitely until a later deliberate administrator cleanup policy is approved.
- Moving a Song to Trash is blocked while it has any active typed lyric, Scan, or Recording. The error identifies and links to those dependencies. Once all active children are separately trashed, the Song may also be trashed.
- Permanent Song deletion remains blocked while any child exists, including trashed children; there is never a cascading Song deletion.
- Restore rejects normalized-title or per-Song Recording-description conflicts and requires the editor to resolve them rather than overwriting newer data.
- Moving a trashed Recording to another Song applies the same per-Song
  description uniqueness rule. A stale child revision, stale duplicate-upload
  checkpoint, inactive destination Song, unexpected media state, or active audio
  job blocks the whole transaction without a partial move.
- Successful mutations record the acting identity and timestamps.
- Read/detail views omit empty optional fields and empty sections. Edit forms may still show those fields so the user can add missing information.

## Legacy evidence, pending confirmation

The legacy design or final AppSheet export may still contain behavior that has not yet been reviewed. It is evidence rather than an automatic requirement.

## Review sequence

1. Song identity, titles, languages, status, tags, aliases, and notes. (Confirmed.)
2. Typed-lyric content, automatic ordering, clean display, and legacy handling are confirmed.
3. People and Song/Recording credit roles. (Confirmed.)
4. Scan metadata and Notebook/Page behavior. (Confirmed.)
5. Recording metadata. (Confirmed.)
6. Lookup administration, duplication rules, Trash/restore, and other cross-record behavior. (Confirmed.)
7. Media validation, duplicate handling, precomputed derivatives, retention, and private sharing semantics. (Policy and the MP3 quality/selection rules in `audio-processing.md` are confirmed.)

For each group, record required/optional behavior, allowed values, defaults, conditional rules, uniqueness, and whether the rule belongs in the form, API, and database.
