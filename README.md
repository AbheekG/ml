# Music Library

A private, installable song-library PWA for a small group using iPhone, iPad, Android, and desktop browsers.

The application is being rebuilt from private legacy attempts (grouped inside the `legacy/` folder). The AppSheet workbook and media are the migration source; the older woodchime Flask project is reference material only. None of the legacy directories are tracked by Git.

## Product direction

- catalog and typed lyrics available offline after an initial authenticated sync;
- scans and recordings private and available online;
- online-only editing with clear offline state;
- one primary editor initially, with viewer/editor/admin roles and audit history;
- strict Song children for lyric texts, scans, and recordings;
- no cascading Song deletion;
- installable PWA without App Store distribution;
- Cloudflare Worker + D1 + private R2 + Access deployment, validated in staging before production;
- target zero recurring cloud spend under the providers' free allowances when that does not compromise privacy, correctness, durability, or media quality;
- immediate local/offline field-aware search with phonetic/transliteration and bounded typo-tolerant title/alias ranking.

See [the product plan](docs/product-plan.md) and [the implementation plan](docs/implementation-plan.md).

## Repository privacy

The following local directories are intentionally ignored:

- `legacy/` — private legacy directories (including `legacy/appsheet/` workbook/media, `legacy/woodchime/` Flask prototype, and any older legacy assets);
- `notes/private/` — private assessments and captures.

Do not commit song titles, lyrics, names, email addresses, media, credentials, generated imports, or local Cloudflare state.

## Current status

The necessary private-beta feature set is implemented and operational in
protected staging. The individual typed-lyric document reconciliation is also
complete in staging, and the additional Drive Recording inventory is triaged.
Private legacy file work is now owner-paused: the remaining boundary is an
owner-review set of unassigned Recordings plus deferred visual/OCR,
compilation/index, and notation material. Other possible work includes optional
UX refinement, broader device coverage, workspace/production-readiness review,
and separately authorized cutover work:

- the normalized D1 schema and guarded relationships are implemented;
- the AppSheet importer reproducibly validates and loads the original 454-Song
  workbook baseline plus related lyrics and media metadata into local D1; later
  staging additions are tracked separately and do not rewrite that baseline;
- the responsive catalog reads real local data and composes field-aware relevance search with offline Language/Tag/Person-role/Notebook/status/media filters and six local sort choices;
- exact and phonetic title/alias matches outrank literal metadata and lyric-only matches; bounded Indic-roman normalization, typos, later title words, and locally joined/split words work entirely from the offline cache;
- song detail displays metadata, typed lyrics, scan records, and recording records;
- the complete catalog, metadata, and typed lyrics are atomically cached in IndexedDB, while the production app shell and hashed assets are precached by a service worker;
- the protected manifest request explicitly includes the Cloudflare Access session credentials required for Chrome to evaluate the authenticated PWA; the owner confirms that Android Chrome now installs it with the intended standalone app experience instead of creating a browser shortcut;
- private scans open in an in-app zoom/pan viewer and recordings stream with seeking; starting one Recording pauses any other Recording playing on that Song without changing its verified stored source;
- the Scan viewer supports clockwise quarter-turn correction: every reader may rotate locally, online editors persist one revision-guarded orientation value, and browser display/share transforms leave both retained originals and readability derivatives unchanged;
- capable online browsers can share the authenticated optimized JPEG for an individual Scan directly from its Song row or from the viewer through the native system share sheet; original Scan bytes, public URLs, and persistent media caches are not involved, and the owner reports that the deployed behavior works well;
- private Recording playback sharing is deployed with a Recording-scoped ready-MP3 route, a 50 MiB safety bound, generic filenames, and no client-selected storage identifier or public URL; the owner accepted the principal device behavior after checking correct-row sharing, quiet cancellation, offline disabling, and multiple Recordings on one Song, while the deliberately oversized and slow-download second-tap paths remain automatically covered rather than manually forced;
- ordinary Recording rows, Scan rows/viewer headers, and Trash now use semantic descriptions, Notebook/Page labels, and positions without exposing original upload filenames; editor file selection, upload recovery, duplicate diagnostics, and private provenance metadata retain filenames where operationally useful;
- repeated Song, typed-lyric, Recording, and Scan actions use accessible symbols with text on wider layouts and 44-pixel icon-only touch targets where compactness helps on narrow layouts; Add, Replace, and higher-consequence actions retain descriptive text;
- the global offline/read-only indicator follows browser connectivity rather than treating one slow API request as proof that the whole app is offline; online-only media handles request failures locally, and an open Scan viewer remains mounted with immediate loading feedback; the Scan/connectivity behavior is owner-accepted in Android Chrome/Brave and macOS Safari;
- catalog search, filters, sorting, and scroll position survive in-app Song navigation and Back in private memory, while reload/logout intentionally resets them; Song details open at the top, and the navigation behavior is owner-accepted on Android and macOS; action-wide errors and duplicate outcomes reveal themselves without moving background-refresh messages or field-level validation away from their context;
- the deployed audit follow-up gives focus and interactive controls at least 3:1 non-text contrast, completes keyboard/ARIA behavior for the Lists tabs, protects dirty editor state across navigation and reconnect, and classifies terminal pre-intent upload history as informational; the owner accepted its keyboard, unsaved-work, offline/reconnect, and date-input behavior on macOS;
- the deployed Recording-date follow-up uses `Asia/Kolkata` as the shared library calendar while showing a compact India-date note only when the editor's device shows a different date; the owner confirmed the ordinary selector still behaves normally, and automated boundary coverage accepts the conditional note that could not naturally appear while both locations shared the same date;
- the current application checkpoint passes 58 Vitest files / 394 tests, all 90 Python audio tests, all three TypeScript projects, the production/service-worker build, whitespace checks, an exact dependency tree with zero reported npm vulnerabilities, and a clean zero-write staging D1 postflight.

The bounded improvements selected from the 2026-07-18 whole-application audit are
implemented, deployed, and accepted. No further implementation slice is implied
by this checkpoint; optional UX ideas and production-readiness gates remain
separately prioritized work.

The media-presentation refinement now keeps original upload filenames out of
ordinary Song, Scan-viewer, and Trash views because they are frequently opaque
AppSheet-generated or generic device basenames. Semantic Recording descriptions,
Scan Notebook/Page labels, and Scan position identify the media instead.
Filenames remain private provenance and upload/recovery metadata; no schema or
media deletion is implied. See
[the media filename presentation decision](docs/media-filename-presentation.md).

- a reconciled forward migration enforces normalized active Song titles, statuses, controlled lookup keys, simplified typed lyrics, Recording descriptions, and Trash safety;
- all original AppSheet row and media-reference counts remain preserved, with
  legacy Scan/Recording metadata retained privately; later reviewed catalog
  additions are recorded as separate reconciliation milestones;
- authenticated identities must map to an active `app_users` record, with reusable viewer/editor/admin authorization guards;
- the authenticated session exposes the current viewer/editor/admin role without exposing the identity;
- editors/admins can create and update Song titles, status, Languages, Tags, Aliases, and Notes only while online;
- editors/admins can independently assign existing People to Song-level Lyrics and Music credits;
- the API normalizes title case, validates controlled references, records actor/timestamps, and updates all Song relationships atomically;
- revisions and per-request mutation identifiers reject stale concurrent edits without allowing their related Language/Tag/Alias changes to leak through;
- editors/admins can create, edit, move to Trash, and restore typed-lyric blocks;
- editors/admins can move an active-child-free Song to recoverable Trash and restore it; Songs with active typed lyrics, Scans, or Recordings are blocked with dependency guidance;
- editors/admins can edit Scan Notebook/Page metadata and move existing Scans and their private media to recoverable Trash or restore them;
- editors/admins can edit existing Recording descriptions, dates, and Vocals credits, and move Recordings and unshared private media to recoverable Trash or restore them;
- editors/admins can recover a trashed Scan or Recording into another active Song
  from a searchable contextual Trash action; exact duplicate uploads that match
  a trashed child offer the same move at the point of need. Recording duplicate
  checks cover both retained originals and generated playback representations,
  including an exact app-shared MP3 reupload. The operation reuses
  the existing private media without creating or deleting rows/objects, applies
  revision and destination guards, and immutably audits actual parent changes.
  The owner has accepted the deployed Trash and `Move to Song…` interaction;
  the newer exact Recording-playback and Scan-readability duplicate extensions
  are automatically covered but were deliberately not exercised with additional
  retained manual test uploads;
- Song and Recording contributor forms now use compact repeatable rows with a searchable existing-Person picker, controlled Role selection, duplicate Person/Role prevention, and per-row removal instead of rendering every Person as a checkbox; the protected-staging interaction is manually accepted, while real-device accessibility remains a later gate;
- editors/admins can add and rename controlled Languages, Tags, Notebooks, and People from a compact searchable screen; normalized duplicates are blocked, likely similar names require confirmation, and deletion is intentionally unavailable;
- editors/admins can create and replace private JPEG, PNG, or WebP Scans up to the Cloudflare Images 20 MB input limit; the Worker verifies signatures and SHA-256, rejects exact content against both registered originals and stored readability JPEGs with race-safe D1 guards, resolves derivative matches to their source Scan, retains immutable originals/history, and creates a bounded private JPEG readability derivative before finalization;
- the Worker has a durable, editor-owned 8 MiB multipart intake for creating or replacing private Recording originals. Immutable upload intents and a Worker-verified per-part file manifest bind each resumable session to its exact operation and bytes; byte-exact duplicate checks cover current and historical originals plus generated playback representations; same-Recording retained history can be restored without another processing job; recovery controls expose resumable/stored/duplicate sessions without storage identifiers; replacement preserves prior media history; and active processing/upload guards prevent conflicting Trash or source changes;
- the deployed audio processor uses a separately authenticated claim/lease boundary, database-enforced global single-running-job gate, bounded lease recovery, operation-scoped transfer capabilities, immutable derivative attempts, independent byte verification, atomic provenance finalization, and explicit editor retry. Finalization records an immutable dispatch attempt and starts the bounded Cloud Run Job asynchronously through keyless Cloudflare Access-to-Google Workload Identity Federation; a 15-minute OAuth Scheduler remains enabled as the reliable/cost-bounded fallback, so a failed immediate trigger leaves durable pending work rather than losing it;
- imported and newly uploaded Scans use a private derivative-or-original read path; a bounded daily repair task backfills fingerprints and derivatives with expiring per-media leases and privacy-safe failure records. Originals remain private and retained;
- the owner accepted the representative local Scan-derivative visual review; the historical pre-intent Recording upload review is complete, with all six recoverable test sessions discarded without deleting their retained private objects and both finalized historical rows left unchanged; macOS Safari and Android Chrome/Brave read-only, offline, Scan-viewer, playback, and unsaved-form checks are owner-accepted; a controlled synthetic staging gate also accepted Scan/Recording create, replace, interruption/resume, duplicate rejection/dismissal, processing, playback, metadata edit, and recoverable Trash/restore with exact D1/R2 postflight; the transient fast-dispatch identity-exchange failure is now strongly explained by and corrected through a Google-compatible Access application-token duration, deployed bounded diagnostics, retained Scheduler fallback, and application-scoped token revocation; four later genuine Recording uploads were each processed immediately on demand, and read-only postflight confirmed an accepted `upload_finalize` dispatch plus a first-attempt successful job for every upload, closing the deferred live recheck; a guarded read-only planner now inventories terminal unreferenced Recording-upload objects, with the next review deferred until on or after 2026-08-16 and every deletion still separately approval-gated; hardened logout/private-cache removal is deployed to protected staging with a cross-tab privacy barrier, stale-write prevention, verified browser-storage clearing, network-cache clearing, and a direct Cloudflare Access logout boundary; both normal online logout and offline logout followed by automatic reconnect completion are owner-accepted in Safari and Android; Scan-viewer touch and trackpad gestures are contained inside the modal and owner-accepted; responsive repeated actions plus private Scan and Recording sharing are owner-accepted; browser-only per-Scan orientation correction is deployed and owner-accepted; broader iOS/iPadOS compatibility, broader contribution roles, and product expansion remain evidence-driven later work.

The exact Scan conversion, provenance, repair, and visual-acceptance rules are
recorded in [the Scan integrity/readability policy](docs/scan-readability.md).
The browser-only display correction and current-view sharing boundary is
recorded in [the Scan orientation policy](docs/scan-orientation.md).
The playback-source selection, size bound, privacy contract, and device gates for
Recording sharing are recorded in [the Recording sharing policy](docs/recording-sharing.md).
The browser-connectivity boundary and online-only media behavior are recorded in
[the connectivity and online-media policy](docs/connectivity-and-online-media.md).
The private in-memory catalog restoration and action-feedback rules are recorded
in [the navigation and feedback policy](docs/navigation-and-feedback.md).
The logout/cache guarantees and remaining real-browser gate are recorded in
[the private local-data policy](docs/logout-and-local-data.md).

The private staging catalog is loaded into an APAC-primary D1 database for the
application's users in India. After the retained synthetic acceptance records,
four later genuine Recording uploads, the completed guarded Lyrics imports, and
the accepted Drive Recording metadata/reparent reconciliation, the verified
2026-07-20 snapshot has 581 Songs, 335 lyric rows, 499 Scans, 835 Recordings
(833 active), and 1,979 media rows, with zero foreign-key errors. The additional
retained owner-test Recording/media row is not cleaned up implicitly; read-only
postflight records one exact playback/original overlap while leaving its review
to a separate owner decision.
Originals/derivatives remain in private APAC storage and are delivered only
through authenticated API routes. The owner-review Recording copies and all
unassigned/unlinked legacy sources remain local; legacy sources are immutable.
Aggregate completion boundaries and the paused private-file scope are recorded
in [the legacy file reconciliation status](docs/legacy-file-reconciliation.md).

Staging URL: `https://app.musiclibrary.workers.dev`. The Cloudflare Worker is named `app`; the project, service identifier, browser database, and D1 database retain their descriptive `music-library` names.

The 2026-07-21 audit remediation keeps ambiguous Scan-maintenance commits from
deleting a possibly referenced readability object, aligns D1 Recording-date
validation with the shared India calendar, completes offline Scan/Recording
media metadata, bounds declared Scan multipart bodies before parsing, and fixes
the skip-link and derivative-aware Scan-sharing UI paths. No catalog or media
row was rewritten by this release.

Current protected-staging deployment: Worker
`7a397fed-1c47-4fb1-9a37-81d4643c4624`, client/service-worker build
`1979c0380e2b`. Migration `0018_india_recording_calendar.sql` is fully applied
with all three India-calendar validation triggers present; no migration is
pending.
Production resources and DNS/cutover remain separately approval-gated.

Staging is protected by Cloudflare Access using an exact-email allowlist and email one-time PIN. The Worker validates Access JWT signatures, issuer, and audience on every API request using a bounded rotating-key cache, rechecks the active application role, and requires exact same-origin evidence plus the route's expected media type for browser mutations. Generic private-media reads require both an active child and active parent Song. Access audience/JWKS identifiers are deployment configuration, not secret credentials; local development overrides `AUTH_MODE` through ignored `.dev.vars`.

## Local development

Requirements: Node.js 24 LTS and npm.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

The local Vite/Worker server prints its URL, normally `http://127.0.0.1:5173`. Useful checks:

```bash
npm run typecheck
npm test
npm run build
```

The Worker endpoints include health/session, catalog/offline-library, Song detail/editor options and writes, and authenticated private media delivery. Generated dependencies, build output, Wrangler state, secrets, and local databases are ignored by Git.

## Legacy import validation

Run the importer without writing output:

```bash
npm run import:appsheet
```

To generate a normalized private catalog and validate it against the local relational schema:

```bash
npm run import:appsheet -- --write
npm run db:load-local
```

Generated files stay under ignored `data/import-output/` and `data/local/` directories. The source workbook and media are read-only inputs and are never modified.

Database migrations live in `migrations/`. See [the data model](docs/data-model.md) for the main relationships and safety rules.

## Private media upload

Preview the resumable upload without changing R2:

```bash
npm run media:upload
```

Upload only workbook-linked media to the private staging bucket:

```bash
npm run media:upload -- --write
```

Progress is stored under ignored `data/import-output/`; private filenames are not printed. Unlinked files are preserved locally and excluded from upload.

After the ignored audio batch has produced and reverified local playback derivatives, reconcile a proposed catalog/R2 integration without changing D1, R2, or any source file:

```bash
npm run media:plan-audio
```

Add `-- --write-plan` only to save the detailed proposed operations under ignored `data/import-output/`. This command never applies the plan or contacts cloud services. Review its aggregate counts before separately authorizing any future upload or database write.

Imported Scan fingerprints have a separate local, dry-run-by-default planner:

```bash
npm run media:plan-scan-fingerprints
```

It streams every workbook-referenced Scan from the read-only AppSheet tree,
reconciles the exact catalog relationship and byte size, verifies any existing
hash, and reports aggregate backfill and duplicate-content counts. Add
`-- --write-plan` only to store the deterministic detailed plan under ignored
`data/import-output/`. The planner never changes legacy files, the catalog,
the database, or cloud state; equal hashes are reported and never auto-merged.

After reviewing the ignored plan, preview its guarded application to the ignored
local catalog:

```bash
npm run media:backfill-scan-fingerprints
```

The preview re-hashes the exact plan and catalog, re-runs source reconciliation,
and checks every live Scan/media row without writing. Local application is a
separate explicit command and requires the exact reviewed plan hash:

```bash
npm run media:backfill-scan-fingerprints -- \
  --apply-local --confirm-plan-sha256 REVIEWED_HASH
```

Application is restricted to an existing database under ignored `data/local/`
or a system temporary directory, runs in one immediate transaction, accepts an
exact already-applied state for idempotency, and rolls back on any stale row,
hash conflict, final-state mismatch, or foreign-key problem. It has no D1/R2 or
other cloud client. Never point it at a legacy tree. The completed staging
backfill used the separately authorized bounded Worker repair path; this local
tool still has no remote mode, and any future environment remains a separate
reviewed operation.

Genuine Scan-source recovery from the older read-only Drive collection has a
separate aggregate-only local matcher:

```bash
npm run media:recover-scan-originals
```

It hashes exact bytes first, then combines orientation/rotation/crop-tolerant
image evidence with folder/page corroboration and one-to-one conflict checks. It
does not contact D1/R2 or write `legacy/`. Add `-- --write-report` to checkpoint
resumable features and write the deterministic detailed mapping only under
ignored `notes/private/`; add `--write-review` for private difference aids and
contact sheets. This command never applies a replacement. The separately
guarded staging activation is complete for the exact owner-reviewed set; do not
rerun it, regenerate its mappings, or garbage-collect the retained former media.
The recovery and history-preserving rollback design is in
[the Scan original recovery record](docs/scan-original-recovery.md).

After a plan has been reviewed, preview its execution locally. This re-hashes every
planned derivative and reports only aggregate counts; it does not contact R2 or D1:

```bash
npm run media:integrate-audio
```

The executor keeps cloud changes in two explicit, independently retryable phases.
Neither phase runs without the exact reviewed plan SHA-256:

```bash
npm run media:integrate-audio -- --upload-r2 --confirm-plan-sha256 REVIEWED_HASH
npm run media:integrate-audio -- --apply-d1 --confirm-plan-sha256 REVIEWED_HASH
```

Do not run these write commands until the owner has separately approved the target
resources and migration `0004_audio_derivatives.sql` has been applied. R2 upload
checks existing bytes before writing, verifies bytes after writing, and checkpoints
progress under ignored `data/import-output/`. The D1 phase freshly verifies every
planned R2 object, checks that migration `0004` is present, and then submits one
guarded transactional import. It will not apply the migration automatically.

For a machine-readable operational snapshot of staging processor health, use:

```bash
npm run ops:processor-snapshot
```

Add `-- --enforce` to return a non-zero exit code when any `critical` alert is
present, suitable for CI/automation gates. This command is read-only: it queries
Cloud Run Job/Scheduler state, recent aggregate processor logs, and D1 aggregate
invariants for processing jobs, direct dispatch, upload intents, Scan integrity,
maintenance failures/leases, and foreign keys without mutating cloud resources.

By default, warning-level log alerts use a 24-hour lookback window so accepted
older failures do not keep paging as active warnings. You can override this with
`-- --alert-lookback-hours N` (for example `N=6` for tighter active monitoring).

For a compact machine-readable payload (good for dashboards/CI summaries), add:

```bash
npm run ops:processor-snapshot -- --summary
```

Summary mode keeps enforce semantics unchanged and reports high-signal fields:
scheduler state, run-job execution status/count, D1 aggregate invariants, full
alerts, and per-severity alert counts.

To inventory terminal unreferenced Recording-upload objects without changing D1
or R2, run:

```bash
npm run ops:plan-upload-cleanup
```

Add `-- --write-report` to store the detailed digest-bound plan under ignored
mode-0600 private notes. Stdout remains aggregate-only. The planner enforces a
30-day grace period by default, exact terminal/reference/hash/size guards, and
has no deletion mode. See
[the Recording upload cleanup policy](docs/recording-upload-cleanup.md).
