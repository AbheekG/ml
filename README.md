# Music Library

A private, installable song-library PWA for a small group using iPhone, iPad, Android, and desktop browsers.

The application is being rebuilt from two private legacy attempts. The AppSheet workbook and media are the migration source; the older woodchime Flask project is reference material only. Neither legacy directory is tracked by Git.

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

- `appsheet/` — private workbook, scans, recordings, and legacy scripts;
- `woodchime/` — old private prototype;
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
- editors/admins can choose an existing image or request mobile rear-camera capture for a new private JPEG, PNG, or WebP Scan; file signatures, size, and SHA-256 are checked, exact-content duplicates identify the existing Song/Notebook/Page, and failed database finalization removes the uncommitted R2 object;
- the Worker now has a durable, editor-owned 8 MiB multipart intake for new private Recording originals, including resumable server-held part state, crash-safe R2 completion, streaming SHA-256 verification, exact-content duplicate stopping, and atomic creation of the processing Recording/media/credits/job; the deployed online-only Add Recording form drives that contract with sequential slices, checkpoint reconciliation after lost responses, aggregate progress, duplicate guidance, stored-object description-conflict retry, and explicit incomplete-upload abort; its protected-staging screen is manually accepted without selecting or uploading a real file, and processing originals are not exposed for playback;
- the deployed Worker also has a separately authenticated audio-processor claim/lease boundary, a database-enforced global single-running-job gate, bounded expired-lease recovery, operation-scoped source/derivative/result/failure capabilities, immutable per-attempt derivative upload, independent stored-byte verification, atomic ready/provenance finalization, safe failure checkpointing, and explicit editor retry; the online Song view exposes that retry only for a failed Recording, by Recording ID and current revision, while keeping the job ID and failure code private; a provider-neutral local Python adapter can claim and process one job with strict origin, redirect, byte-integrity, retry, temporary-file, 45-minute deadline, 55-minute lease-remaining, and generated-output controls; its run-once entrypoint reads the processor token only from a file, rejects unknown prefixed configuration, logs one aggregate outcome, and uses explicit success/failure/reconciliation exit codes; the accepted hosted-boundary design uses a scheduled single-task Cloud Run Job with no HTTP server; the current hardened Debian 13/FFmpeg 7.1 pinned `linux/amd64` image targets build and run locally, and the full non-root 2 GiB cgroup/tmpfs/FFmpeg/dummy-secret proof passes; Google runtime/scanning APIs, two keyless no-project-role identities, and a regional scanning-enabled repository now exist; the first Bookworm image was rejected after scanning, while the exact hardened commit image passed the reviewed scan/reachability gate; a version-pinned processor secret with secret-level runtime access and the matching protected Worker token/origin now exist; the exact digest-pinned bounded Cloud Run Job is Ready, but its first execution failed safely when Cloudflare Access redirected the claim before the Worker; no work was claimed or changed, Service Auth support is now the next gate, and no Scheduler trigger is configured;
- Scan replacement, image derivatives/compression, Recording replacement, and any evidence-driven expansion beyond Lyrics/Music/Vocals contribution roles remain later incremental slices.

The private staging catalog is loaded into an APAC-primary D1 database for the application's users in India. All 1,325 workbook-linked media files are stored in private APAC R2 and delivered only through the authenticated API. Two unassigned legacy recordings and two unlinked scans remain local for later identification.

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
other cloud client. Never point it at a legacy tree; remote application remains
a separately reviewed and authorized operation.

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
