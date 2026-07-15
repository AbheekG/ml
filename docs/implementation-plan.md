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

Audio decode validation and conversion are deliberately outside the 128 MB Worker runtime. Use the provider-neutral Python/FFmpeg core described in [audio-processing.md](audio-processing.md): run existing-media preparation locally, and later execute the same core once per single-task scheduled Cloud Run Job for rare new uploads, as defined in the accepted local design in [audio-processing-invocation.md](audio-processing-invocation.md). Do not add an HTTP server for this boundary. Keep Cloudflare and Google Cloud within their free allowances when practical. The owner completed the isolated Google Cloud staging project, billing, budget-alert, and local CLI setup; every runtime resource remains separately approval-gated.

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
readiness, and job success. Safe failures are durable and editor-retryable. The
versioned processor token and exact transfer origin are now configured across
the least-privilege Google secret and protected Worker boundary. The control
plane is deployed to protected staging with migrations `0005`–`0008`, but
remains fail-closed after its first processor execution rejected the Access
login redirect before reaching the Worker. It has not processed a real upload.

The provider-neutral processor-side HTTP adapter is also implemented locally as
a one-job library boundary around the existing Python/FFmpeg `prepare()` core.
It does not retry claim, validates the strict lease/capability envelope and exact
Worker routes, disables redirects, streams the source into a private temporary
directory with exact length/hash enforcement, uploads only a reverified selected
derivative, and sends bounded idempotent result/failure callbacks. A result
delivery that may already have committed never becomes a contradictory failure
callback. No HTTP server is added. The credential boundary and dormant Cloud Run
Job now exist in protected staging, but the first no-work smoke proved the
deployed adapter still needs Cloudflare Access Service Auth credentials. The
local source now strictly loads one file-only Access client ID/secret pair,
sends the standard two Access headers on claim and every same-origin capability
request, retains the separate Worker bearer token, and rejects any additional
transfer origin to prevent credential disclosure. The accepted design remains
a scheduled single-task Cloud Run Job. Its database-enforced
global running-job gate, three-attempt bounded lease-loss recovery, 45-minute
monotonic processor deadline, 55-minute lease-remaining floor, and streaming
generated-output ceiling are now implemented and tested locally. A minimal
run-once entrypoint also loads strict file-secret configuration, emits one
aggregate-only outcome, and maps success, durable failure, and ambiguous
reconciliation to tested exit codes. The digest- and FFmpeg-version-pinned
non-root image plus a generated worst-case storage/real conversion fixture are
implemented. Static policy tests, the full host fixture, both pinned
`linux/amd64` image builds, the full non-root 2 GiB cgroup/tmpfs fixture, the
in-image FFmpeg/libmp3lame checks, and the read-only dummy-secret smoke pass.
Exact paused-first cloud commands, cost assumptions, rotation, rollback, and
staging checks are separately reviewed in
[audio-processing-cloud-runbook.md](audio-processing-cloud-runbook.md). Every
remaining processor cloud action remains separately owner-approved and unexecuted.

The local Service Auth checkpoint passes all 90 audio tests, 31 application
test files / 250 tests, all three TypeScript projects, production build ID
`e74405e5e982`, the full bounded `linux/amd64` verification fixture, and the
non-root dual-file runtime configuration/redaction smoke. No cloud state changed.

The imported-Scan fingerprint inventory and deterministic local planner are now
implemented. The planner streams and hashes all catalog-linked Scan sources,
requires one-to-one catalog relationships and unchanged byte sizes, verifies
pre-existing hashes, reports duplicate-content groups without merging them, and
keeps detailed identifiers under ignored private output only. The guarded local
database executor is also implemented: it requires exact plan confirmation for
application, re-runs the complete source/catalog reconciliation, checks live
Scan/media state, updates only null hashes in one immediate transaction, and
accepts only exact already-applied state on rerun. Focused rollback/idempotency
tests plus fresh and existing-catalog isolated verification pass. Owner-reviewed
remote application remains a later separately authorized step; neither tool can
change legacy, D1, R2, or staging state.

Proposed application tooling:

- React + TypeScript + Vite for the interface;
- a small Worker API, preferably Hono or similarly minimal routing;
- IndexedDB for the offline catalog;
- a service worker for install/offline startup;
- SQL migration files as the authoritative D1 schema;
- runtime input validation;
- Vitest for unit/import tests and Playwright for key browser flows.

Keep dependencies modest and pin an LTS Node.js version. Develop locally before creating production cloud resources.

## Operating-cost objective

Target zero recurring cloud spend for the expected 3–4-person workload by
staying deliberately below the providers' currently published free allowances.
This is an optimization objective, not a guarantee or a reason to weaken
privacy, access control, verification, recoverability, preservation of
originals, transcoding quality, or the usability of the application. Free tiers
can change and some Google Cloud services require a billing account that can be
charged for overage.

Treat the allowances as separate measured budgets rather than one generic free
tier. In particular, Cloudflare R2 Standard currently includes 10 GB-month of
storage, which is a monthly storage measure rather than a hard 10 GB capacity
line; D1 storage and row operations, Worker requests/CPU, and R2 operations have
their own limits. Google Cloud Run compute, outbound network transfer, Artifact
Registry storage, Secret Manager access, Cloud Scheduler jobs, builds, and logs
also have separate limits, and some allowances are shared by billing account.

Before enabling any new recurring resource:

- recheck official pricing and calculate expected idle plus worst-reasonable
  processing use with headroom;
- configure usage visibility and a small billing budget with multiple alerts,
  while recognizing that a Google budget alert is not a spending cap;
- create schedules paused and require an approved manual no-work test plus one
  private end-to-end staging test before resuming them;
- keep images, logs, retained revisions, and schedules bounded without removing
  source media or security/verification safeguards; and
- if projected use approaches a free allowance, pause the affected optional
  recurring work where safe and ask the owner to choose between configuration
  tuning and a small paid allowance. Never silently degrade output or delete
  private originals to avoid a charge.

Current provider references are [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Cloud Run pricing](https://cloud.google.com/run/pricing), and
[Google Cloud budgets](https://docs.cloud.google.com/billing/docs/how-to/budgets).

## Environments

- **Local:** local D1/R2 emulation and a sanitized or private local import; no cloud dependency for routine development.
- **Staging:** real Cloudflare bindings, private access, and a copy of data for device testing.
- **Production:** separate D1 database and R2 bucket, created only after staging acceptance.

The Google audio-processing staging project is
`music-library-audio-staging`. Billing is linked, a monthly notification-only
budget is active with promotional credits excluded from its alert calculation,
and the isolated local CLI configuration defaults Cloud Run to `asia-south1`.
The reviewed runtime/scanning APIs, two keyless service accounts without
project-wide roles, and one regional scanning-enabled repository exist. The
first Bookworm image was pushed only for vulnerability review and is blocked
from deployment. Its hardened Debian 13/FFmpeg 7.1 replacement was pushed by
exact owner-reviewed commit tag, resolved to the proved local digest, scanned,
and passed the reviewed package/reachability gate for a future digest-pinned
Job. One automatically replicated processor secret has one enabled version and
only a secret-level runtime accessor; the matching token and exact transfer
origin are Worker secrets. The exact reviewed digest is configured as a dormant
Ready Cloud Run Job with the bounded resource and environment contract; it has
one failed execution and no invoker binding. The execution loaded configuration
and then failed closed on `claim_redirect_rejected` because Cloudflare Access
intercepted the request before the Worker. D1 remained unchanged. No Scheduler
trigger has been configured. A separate Google production project has not been
created.

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
   - current staging status: the online-only Add Recording form and resumable multipart
     orchestration are deployed, automated tests pass, and the protected screen is
     manually accepted without a real file/upload; real upload and device checks remain;
     the Song view also exposes the revision-guarded editor retry for failed audio
     preparation without disclosing its job ID or internal failure code;
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
- compact repeatable credit rows are now implemented locally for Song editing,
  Recording editing, and new Recording upload: an Add contributor action,
  searchable existing-Person input, controlled Role dropdown, duplicate-pair
  prevention, and per-row remove control; protected-staging interaction is
  manually accepted, while real-device accessibility remains;
- one-tap system sharing for an individual scan or recording by sharing authenticated file bytes rather than exposing a public media URL, with capability-aware fallback behavior;
- copy for an individual typed-lyric block plus capability-gated system text
  sharing are now implemented locally for all readers and remain available while
  offline; real Safari/iOS and Chrome/Android clipboard/share-sheet checks remain;
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
