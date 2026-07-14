# Music Library implementation plan

Status: approved direction; execute iteratively and validate each phase on real data and devices.

## Current execution order

The core read/edit/recovery flows, safe new-Scan upload, local catalog filters/sorting, and field-aware offline search now work in staging. The owner accepted relevance-ranked phonetic/transliteration search with stronger title/alias priority, literal-only lower-ranked metadata/lyrics, bounded typos, and local joined/split-word alignment. A field-scope control was not needed for this slice and remains evidence-driven future work. Continue with broader media processing:

1. new Recording upload plus the audio validation/conversion pipeline;
2. safe Scan/Recording replacement and imported-media fingerprint/derivative work;
3. compact contributor inputs, sharing, and remaining feedback-driven polish;
4. further search tuning or a field-scope control only when concrete real-use examples justify it.

This is a delivery order rather than a schema dependency. The accepted search and filter work remains independently testable while media workflows are added.

## Technical shape

Use one TypeScript Cloudflare Worker project that serves both the PWA static assets and the authenticated API from one origin. Bind the Worker to:

- D1 for relational catalog data and audit history;
- private R2 for scans, original audio, and playback derivatives;
- Cloudflare Access for allowlisted identity at the deployed boundary.

Audio decode validation and conversion are deliberately outside the 128 MB Worker runtime. Use the provider-neutral Python/FFmpeg core described in [audio-processing.md](audio-processing.md): run existing-media preparation locally, and later execute the same core once per single-task scheduled Cloud Run Job for rare new uploads, as proposed in [audio-processing-invocation.md](audio-processing-invocation.md). Do not add an HTTP server for this boundary. Keep the Cloudflare Worker on the Free plan unless later evidence justifies changing it. Cloud project/billing setup remains an explicit owner action.

Existing prepared derivatives cross the cloud boundary through a reviewed deterministic plan and a dry-run-by-default executor. R2 upload and D1 finalization remain separate owner-approved commands. Upload is resumable and content-verified; D1 finalization requires the schema migration to exist, re-verifies the complete R2 set, and uses guarded live-state preconditions in one rollback-safe import. The executor does not deploy, apply migrations, or combine these external approvals.

New Recording originals use authenticated 8 MiB multipart requests through the
application Worker and private R2 binding, as defined in
[recording-upload.md](recording-upload.md). This avoids whole-file Worker request
limits, browser-visible storage credentials, and public/CORS bucket access. The
Worker streams the completed object through SHA-256 verification before it
stops at a durable stored-or-duplicate boundary. A separate idempotent endpoint
then rechecks duplicates and atomically creates the fingerprinted media row,
processing Recording, copied credits, and durable job only for a nonduplicate
stored upload. Readiness still requires independently verified hosted-processing
output; processing originals are not exposed as playback media.

The Worker-side processing control plane is now implemented and tested locally.
A separately configured processor can claim one pending job, receive an expiring
lease plus operation-bound same-origin transfer capabilities, stream the exact
private source, and immutably upload one derivative attempt. The Worker accepts
only a strict policy/job/source-bound result, independently re-hashes stored
source and derivative bytes, and atomically records provenance, playback
readiness, and job success. Safe failures are durable and editor-retryable. No
processor secret/origin has been configured and none of this local slice has
been deployed to staging.

The provider-neutral processor-side HTTP adapter is also implemented locally as
a one-job library boundary around the existing Python/FFmpeg `prepare()` core.
It does not retry claim, validates the strict lease/capability envelope and exact
Worker routes, disables redirects, streams the source into a private temporary
directory with exact length/hash enforcement, uploads only a reverified selected
derivative, and sends bounded idempotent result/failure callbacks. A result
delivery that may already have committed never becomes a contradictory failure
callback. No HTTP server/trigger, container, scheduler, real secret, Cloud Run
resource, or other hosted invocation mechanism has been created. The proposed
local boundary selects a scheduled single-task Cloud Run Job, but first requires
a database-enforced global running-job gate, bounded lease-loss recovery, a
45-minute processor deadline and generated-output ceiling, aggregate-only
entrypoint behavior, and local container/resource verification. Every cloud
action remains separately owner-approved.

Proposed application tooling:

- React + TypeScript + Vite for the interface;
- a small Worker API, preferably Hono or similarly minimal routing;
- IndexedDB for the offline catalog;
- a service worker for install/offline startup;
- SQL migration files as the authoritative D1 schema;
- runtime input validation;
- Vitest for unit/import tests and Playwright for key browser flows.

Keep dependencies modest and pin an LTS Node.js version. Develop locally before creating production cloud resources.

## Environments

- **Local:** local D1/R2 emulation and a sanitized or private local import; no cloud dependency for routine development.
- **Staging:** real Cloudflare bindings, private access, and a copy of data for device testing.
- **Production:** separate D1 database and R2 bucket, created only after staging acceptance.

Never point development code at production data by default.

Cloud data placement uses the APAC location hint because normal users are primarily in India. This applies to both D1 primary databases and R2 media buckets; creation from the developer's current location in Europe must not determine automatic placement.

## Phase 1 — foundation and importer

1. Scaffold the TypeScript application, formatting, linting, tests, and local Worker configuration.
2. Define a maintainable schema using clear domain names rather than copying spreadsheet column names mechanically.
3. Build a read-only workbook/media importer with dry-run mode.
4. Preserve legacy IDs and lyric blocks while normalizing known case-only reference errors.
5. Produce reconciliation output for every table, relationship, and media object.
6. Add tests for duplicate keys, orphan prevention, lyric migration, and delete guards.

Deliverable: repeatable local database creation from `appsheet/data.xlsx` with no legacy modification.

## Phase 2 — read-only PWA

1. Build the catalog list, basic local search, filters, and sorting.
2. Build song detail with typed-lyric blocks, scans, recordings, credits, tags, languages, and notes.
3. Add IndexedDB catalog storage and atomic background refresh.
4. Add installable/offline app shell and explicit offline UI.
5. Add private scan viewing and audio streaming/playback.
   - retain every source recording unchanged;
   - use reasonable valid MP3 originals directly, generate MP3 playback derivatives for other or mislabeled formats, and convert an oversized/high-bit-rate MP3 only when the result meets the material-saving rule in `audio-processing.md`;
   - generate and verify each required playback derivative once during import or asynchronously after upload, store it privately, and never transcode on a Play request;
   - keep new Recordings in a processing state until their original/derivative is verified, with retryable failure handling;
   - use browser media-capability checks only to select or verify already prepared sources, not to trigger device-specific conversion;
   - support HTTP range requests for seeking and efficient mobile streaming;
   - verify uploads with byte size and SHA-256 before marking media available.
   - retain immutable source/policy/hash/size provenance for every playback derivative and reject a Recording reference to an unrelated derivative;
   - show scans in an in-app near-fullscreen lightbox with a small close control, zoom, and optional fullscreen mode instead of opening a bare browser tab;
   - generate readability-preserving scan derivatives sized for pages no larger than A4, using a broadly supported efficient image format;
   - retain scan originals until derivative quality is visually accepted and the owner explicitly approves any later archival or deletion policy.
6. Validate layout and behavior on iPhone/iPad and Android.

Deliverable: a useful staging application that can read the real catalog offline and consume media online.

## Phase 3 — online editing and safety

Before implementing write forms, confirm the field-level business rules in [editing-rules.md](editing-rules.md). Reconstruct legacy behavior from the AppSheet design and workbook, but treat it as evidence rather than automatically preserving every old choice. Confirm the rules with the owner in small, related groups and enforce accepted rules in the form, API, and database where appropriate.

1. Add viewer/editor/admin authorization.
2. Add Song and typed-lyric create/edit/trash/restore workflows without requiring language/script/representation classification.
3. Add Scan and Recording metadata/upload/replace/trash/restore workflows.
   - inspect actual file signatures/codecs rather than trusting extensions;
   - calculate SHA-256 before creation and reject duplicate content with a link to the existing record;
   - preserve recording originals and generate canonical playback derivatives;
   - make upload finalization atomic so failed validation or conversion cannot create orphan records;
4. Add actor/timestamp audit metadata.
5. Enforce no-orphan foreign keys and no-cascade Song deletion.
6. Refuse Song deletion while any Lyric text, Scan, or Recording exists and link the editor to those dependencies.
7. Retain replaced/deleted media long enough for recovery and add deliberate later cleanup.

Deliverable: safe online maintenance by the primary editor.

## Phase 4 — beta and cutover

1. Run staging with the primary editor and at least one viewer.
2. Collect feedback from normal tasks instead of attempting exhaustive up-front design.
3. Fix usability and playback issues, test restore/recovery, and verify usage alerts/quotas.
4. Freeze AppSheet writes briefly, run final reconciliation/import, and deploy production.
5. Retain AppSheet/Google Drive read-only as a migration fallback and independent backup.

## Phase 5 — later improvements

- further phonetic/transliteration tuning, language-specific alternatives, or a field-scope control only if tested real queries expose remaining gaps;
- replace long Person checkbox grids with compact repeatable credit rows: an Add contributor action, searchable Person combobox, controlled Role dropdown, and per-row remove control;
- one-tap system sharing for an individual scan or recording by sharing authenticated file bytes rather than exposing a public media URL, with capability-aware fallback behavior;
- copy for an individual typed-lyric block, plus system text sharing where supported;
- favorites, playlists, set lists, or recently viewed only if actual use calls for them;
- automated transcription/OCR only after the core library is trusted.

## Feedback loop

Each phase follows the same small loop:

1. implement the narrow workflow;
2. test automatically;
3. use it with real catalog data;
4. test on actual mobile devices;
5. collect concrete friction/requests;
6. adjust before expanding scope.

The product plan is a strong starting hypothesis, not a frozen screen specification.

## Owner actions before first staging deployment

1. Create or identify a Cloudflare Free account.
2. Enable two-factor authentication and save recovery codes securely.
3. Do not share the password, recovery codes, global API key, or long-lived API tokens with Codex.
4. Do not change `abheekghosh.com` nameservers or DNS yet. Initial staging uses a Cloudflare-provided URL.
5. When requested, authorize Wrangler through its browser login on this Mac; this grants scoped CLI access without placing account credentials in the repository.
6. Later provide the allowlisted email addresses and desired viewer/editor roles through a private local configuration—not chat or tracked files if privacy is preferred.
7. Test the staging PWA on at least one Apple mobile device and one Android device when a URL is ready.

Cloud resources (D1, R2, Access policy, and deployment) should be created from checked-in configuration/commands after the local vertical slice exists, rather than manually creating loosely documented resources in advance.
