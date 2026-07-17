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

The private staging application is operational:

- the normalized D1 schema and guarded relationships are implemented;
- the AppSheet importer validates and loads all 454 songs plus related lyrics and media metadata into local D1;
- the responsive catalog reads real local data and composes field-aware relevance search with offline Language/Tag/Person-role/Notebook/status/media filters and six local sort choices;
- exact and phonetic title/alias matches outrank literal metadata and lyric-only matches; bounded Indic-roman normalization, typos, later title words, and locally joined/split words work entirely from the offline cache;
- song detail displays metadata, typed lyrics, scan records, and recording records;
- the complete catalog, metadata, and typed lyrics are atomically cached in IndexedDB, while the production app shell and hashed assets are precached by a service worker;
- private scans open in an in-app zoom/pan viewer and recordings stream with seeking; starting one Recording pauses any other Recording playing on that Song without changing its verified stored source;
- type checks, importer/schema/API tests, production builds, and local end-to-end API smoke tests pass.

- a reconciled forward migration enforces normalized active Song titles, statuses, controlled lookup keys, simplified typed lyrics, Recording descriptions, and Trash safety;
- all imported row and media-reference counts remain unchanged, with legacy Scan/Recording metadata retained privately;
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
- Song and Recording contributor forms now use compact repeatable rows with a searchable existing-Person picker, controlled Role selection, duplicate Person/Role prevention, and per-row removal instead of rendering every Person as a checkbox; the protected-staging interaction is manually accepted, while real-device accessibility remains a later gate;
- editors/admins can add and rename controlled Languages, Tags, Notebooks, and People from a compact searchable screen; normalized duplicates are blocked, likely similar names require confirmation, and deletion is intentionally unavailable;
- editors/admins can create and replace private JPEG, PNG, or WebP Scans up to the Cloudflare Images 20 MB input limit; the Worker verifies signatures and SHA-256, rejects exact content globally with race-safe D1 fingerprints, retains immutable originals/history, and creates a bounded private JPEG readability derivative before finalization;
- the Worker has a durable, editor-owned 8 MiB multipart intake for creating or replacing private Recording originals. Immutable upload intents bind each session to its exact operation, recovery controls expose resumable/stored/duplicate sessions without exposing storage identifiers, replacement preserves prior media history, and active processing/upload guards prevent conflicting Trash or source changes;
- the deployed audio processor uses a separately authenticated claim/lease boundary, database-enforced global single-running-job gate, bounded lease recovery, operation-scoped transfer capabilities, immutable derivative attempts, independent byte verification, atomic provenance finalization, and explicit editor retry. Finalization records an immutable dispatch attempt and starts the bounded Cloud Run Job asynchronously through keyless Cloudflare Access-to-Google Workload Identity Federation; a 15-minute OAuth Scheduler remains enabled as the reliable/cost-bounded fallback, so a failed immediate trigger leaves durable pending work rather than losing it;
- imported and newly uploaded Scans use a private derivative-or-original read path; a bounded daily repair task backfills fingerprints and derivatives with expiring per-media leases and privacy-safe failure records. Originals remain private and retained;
- the owner accepted the representative local Scan-derivative visual review; the historical pre-intent Recording upload review is complete, with all six recoverable test sessions discarded without deleting their retained private objects and both finalized historical rows left unchanged; macOS Safari and Android Chrome/Brave read-only, offline, Scan-viewer, playback, and unsaved-form checks are owner-accepted, while iOS/iPadOS compatibility, staging-mutating upload/replace/recovery checks, logout/cache removal, and per-Scan orientation corrections remain explicit later work; broader contribution roles and product expansion remain evidence-driven.

The exact Scan conversion, provenance, repair, and visual-acceptance rules are
recorded in [the Scan integrity/readability policy](docs/scan-readability.md).

The private staging catalog is loaded into an APAC-primary D1 database for the application's users in India. Its 455 Songs, 498 Scans, 829 Recordings, and retained originals/derivatives remain in private APAC storage and are delivered only through authenticated API routes. Unassigned/unlinked legacy files remain local for later identification.

Staging URL: `https://app.musiclibrary.workers.dev`. The Cloudflare Worker is named `app`; the project, service identifier, browser database, and D1 database retain their descriptive `music-library` names.

Staging is protected by Cloudflare Access using an exact-email allowlist and email one-time PIN. The Worker also validates Access JWT signatures, issuer, and audience on every API request. Access audience/JWKS identifiers are deployment configuration, not secret credentials; local development overrides `AUTH_MODE` through ignored `.dev.vars`.

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
