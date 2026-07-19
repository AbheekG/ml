# Music Library implementation plan

Status: the necessary private-beta feature set is implemented and accepted in
protected staging. The Scan-orientation refinement is deployed and
owner-accepted. The credentialed PWA-manifest request is deployed and
owner-accepted on Android Chrome. Continue the remaining private legacy file
reconciliation first; other optional UX refinement, audit/cleanup, and
production readiness remain separately prioritized and approved.

Application/deployment checkpoint (2026-07-18): protected staging runs Worker
`c06947b2-95ce-43e8-82b0-d9411746c103`, client/service-worker build
`193893b3833a`. Chrome on Android offered only its browser-shortcut fallback for
the protected app. The manifest itself meets the install fields, but its HTML
link omitted the explicit `use-credentials` mode required for an authenticated
manifest. The deployed one-line correction includes the Access session when the
browser fetches the manifest; all three TypeScript projects, production build,
and service-worker build pass, Access protection still returns the expected
unauthenticated redirect, no migration is pending, and no D1 or R2 operation was
performed. The owner confirms that Android Chrome now completes the intended
standalone installation instead of creating a browser shortcut. The Scan-
orientation verification passed 56 Vitest files / 379 tests,
all 90 Python audio tests, all three TypeScript projects, production and service-
worker builds, whitespace checks, an exact dependency tree with zero reported
npm vulnerabilities, and zero-write staging-D1 postflight. Scan orientation is
stored as a revision-guarded absolute quarter-turn value; every reader can
rotate locally, editors persist online after a debounce, and browser display and
current-view sharing transform only the loaded readability image. Exact
originals and stored readability JPEGs remain unchanged. Migration `0014` is
fully applied; all 499 existing Scans retain the zero default and there are zero
invalid values or foreign-key errors. The in-app browser runtime was unavailable,
but the owner subsequently reported that the deployed behavior works well and
accepted the slice; the device/browser was not recorded. The earlier audit follow-up
adds accessible control contrast and complete Lists-tab semantics, dirty-form
navigation/reconnect protection, accurate active-versus-historical upload alert
classification, and Recording-date validation. Its deployed behavior passed the
owner's macOS keyboard, unsaved-work, offline/reconnect, and date-input checks.
The approved `Asia/Kolkata` shared-calendar refinement is included in protected
staging; its deployment postflight retained Access protection, found no pending
migration or integrity error, and wrote zero D1 rows. The owner confirmed the
ordinary date selector remains normal; the conditional differing-date note is
accepted through automated India/device boundary coverage because both locations
showed the same date during the manual check. The bounded 2026-07-18 audit-
improvement slice and the Scan-orientation refinement are complete, deployed,
and accepted. No new implementation task is selected at this checkpoint.
Production remains absent and separately approval-gated.

Data-reconciliation checkpoint (2026-07-19): the individual typed-lyric
document pass is complete in protected staging. Two exact private imports
processed all 168 active document decisions, adding 124 Songs and 151 lyric rows
without changing Scans, Recordings, media objects, R2, migrations, or the
deployed application. Exact aggregate postflight is 580 Songs, 335 lyric rows,
499 Scans, 834 Recordings, 1,978 media rows, and zero foreign-key errors. The
remaining owner-selected private work is the deferred visual/OCR and compilation
material plus Scan/image and audio/Recording candidates outside the completed
Drive `Final` boundary. See
[legacy-file-reconciliation.md](legacy-file-reconciliation.md).

Milestone history and operational detail: the vertical slice, online
catalog/child editing, private Scan create/replace, and Recording
create/replace are implemented. Audio finalization now records an immutable
dispatch attempt and starts the bounded Cloud Run Job through keyless
Cloudflare Access-to-Google Workload Identity Federation; the enabled
15-minute Scheduler is a reliable/cost-bounded fallback. The old Cloudflare-held Google
JSON key is deleted and the old trigger service account is disabled. Imported
Scan sources are reconciled in the global fingerprint registry and have private
2400-pixel JPEG readability derivatives; bounded, leased daily maintenance
remains enabled for later repair needs. Production remains absent. macOS Safari
and Android Chrome/Brave read-only, offline, Scan-viewer, playback, and unsaved
editor-form checks are owner-accepted. A separately bounded synthetic mutation
gate also passed Scan and Recording create/replace, multipart interruption and
resume, exact duplicate rejection/dismissal, audio processing/playback, metadata
editing, retained replacement history, and child/parent Trash/restore. Its exact
D1/R2 postflight matches every planned count and all nine retained objects.
iOS/iPadOS compatibility remains explicit later work. Browser-only per-Scan
orientation correction is deployed and owner-accepted, without a recorded
device/browser.
Scan-viewer gesture containment is owner-accepted:
the viewer modal suppresses browser-level touch zoom while open, and a native
non-passive wheel boundary converts trackpad pinch into bounded image zoom
without scaling the controls. Android Brave testing then exposed that a single
five-second application health timeout could falsely mark the whole app offline
and close the viewer even though the Scan request itself succeeded. The deployed
follow-up now applies the simpler boundary documented in
[`connectivity-and-online-media.md`](connectivity-and-online-media.md): global
offline/read-only state follows browser connectivity events, operational health
checks no longer drive UI state, individual request failures stay local, and an
open viewer remains mounted with immediate loading feedback. A subsequent
Android-only reset was traced to browser chrome resizing the visual viewport;
new images now fit once, while later layout changes preserve zoom and clamp pan.
Protected-staging Worker version `b896f7f5-c666-49b7-b138-2cc1b2621b47` and
client/service-worker build `fc7c39c255bc` contain both corrections; automated
and cloud postflight checks pass, and Android Chrome/Brave plus macOS Safari
acceptance is complete. The local logout hardening now places a persistent privacy barrier
before clearing, invalidates
other tabs, prevents
stale sync commits, verifies IndexedDB/CacheStorage removal, requests browser
HTTP-cache clearing, and keeps Cloudflare Access control paths outside the
service worker. Protected-staging Worker version
`2e889cf3-f246-4651-ac09-20ee13b7936d` contains that hardening and durable
offline-pending fix with build `0ad3cf28a474`; Access, migrations, and aggregate
D1 postflight are clean. Online
logout passed owner testing in macOS Safari and Android. Offline testing showed
that local clearing worked but a later online visit could reuse the still-valid
Access session. The local follow-up now persists a distinct pending Access
logout, blocks session reconciliation while pending, reports the offline state
accurately, and completes remote logout automatically on reconnect. Normal
online logout and offline clearing followed by reconnect completion are now
owner-accepted in macOS Safari and Android. A local read-only
planner now inventories terminal unreferenced Recording-upload objects with a
30-day default grace period, exact D1/R2 reference/hash/size guards,
aggregate-only stdout, and a private digest-bound report; it has no deletion
mode. Its first protected-staging dry run inspected seven terminal objects and
classified all seven for manual review, with zero eligible for deletion: all
seven were younger than the grace cutoff and six also predated immutable upload
intents. The owner accepted reviewing this again no earlier than 2026-08-16;
the current report is not deletion authorization. One create
upload's immediate Google identity exchange failed safely and the Scheduler
fallback completed it; the subsequent replacement fast dispatch succeeded.
Deployed diagnostic hardening now checks the verified assertion's Google-compatible
temporal bounds and retains bounded STS status categories without recording a
token, identity claim, or response body. Read-only inspection confirmed that
the application and inheriting human Allow policy
permitted one-month application tokens, while the global session also inherited
that duration. With owner approval, staging now has an explicit one-month global
duration and a 24-hour application duration; the human policy still inherits the
application, and existing application tokens were revoked. Protected-staging
access then passed without a new identity-provider prompt. Protected-staging
version `c2ea5df7-e011-4429-b07f-9f75a691b098` contains the hardening. Four
later genuine Recording upload finalizations each exercised immediate dispatch:
the owner observed on-demand processing, and read-only postflight found an
accepted `upload_finalize` dispatch plus a first-attempt successful job for all
four. This closes the deferred live recheck. Do not weaken or remove the
Scheduler fallback. Separately, the owner
reviewed all six recoverable historical pre-intent Recording upload
sessions, confirmed they were test uploads, and discarded them recoverably in
protected staging without deleting the six retained private objects. The two
already-finalized historical rows were unchanged; no recoverable pre-intent
sessions remain.

The deployed navigation and feedback follow-up now retains catalog query, filters,
sort, and scroll only in mounted App memory across Song navigation. It resets on
reload, logout, or private-data invalidation and never places private queries in
URLs or browser storage. Direct action-wide feedback and duplicate panels reveal
themselves with nearest-position scrolling, while field and background-refresh
messages stay in context. The boundary and manual gate are recorded in
[navigation-and-feedback.md](navigation-and-feedback.md).

The owner-directed genuine Scan-source recovery is complete for the exact
reviewed staging set. The local matcher inventoried both read-only trees, checked
exact hashes first, combined transformation-tolerant content evidence with
independent association evidence, and enforced one-to-one, quality, and
hash-collision gates. The separately guarded executor activated new private
source/readability pairs, retained every former pair through immutable Scan
history, and used recoverable Trash for the rejected wrong-parent Scan. The
owner accepted the final post-activation comparison PDF. Do not rerun the swap,
regenerate its mappings, or garbage-collect the retained history. Production and
the unresolved cases remain separately owner-gated; see
[scan-original-recovery.md](scan-original-recovery.md).

Protected-staging Worker version `3e6ac24e-93d3-4704-9fd8-a6bbb0b75efc`
contains the accepted Scan-viewer refinements and the catalog-navigation/action-
feedback follow-up with client/service-worker build `0a1a445e3ce3`. Android's
provisional native Back scroll is ignored until the cached catalog completes its
explicit restoration, so it cannot replace the saved position with page top.
Forward navigation to a Song detail starts at the top without altering the
catalog's separately remembered position.
Verification passes at 47 Vitest files / 327 tests, all 90 Python audio tests,
all three TypeScript projects, production bundles, and whitespace checks. Access
still returns the expected unauthenticated redirect, no migration is pending,
and aggregate D1/foreign-key postflight is unchanged with zero rows written.
Catalog restoration, Android native-Back behavior, and Song-detail top position
are owner-accepted. macOS Safari's interactive Back gesture has a non-blocking
temporary scroll-input lock after returning to the correct position; do not add
timing workarounds without stronger application evidence. Feedback visibility
may be observed during the next natural error or duplicate operation;
iOS/iPadOS remains deferred.

The completed Scan-sharing slice adds capability-gated native sharing from the
Scan viewer and its Song row of only an authenticated Scan readability JPEG.
Both actions and responsive accessible row icons are deployed as protected-staging Worker version
`b3ccdca7-683b-4881-b4aa-1a85dd4d892a`, client/service-worker build
`b4de0994f09e`. The client verifies the private representation, JPEG type, exact
length, and 20 MiB bound before sharing a generic file-only payload; it never
shares the original fallback or a public URL. Verification passes at 49 Vitest
files / 338 tests, all 90 Python audio tests, all three TypeScript projects,
production build, and whitespace checks. Access still returns the expected
unauthenticated redirect, no migration is pending, and aggregate D1/foreign-key
postflight is unchanged with zero rows written. Android and iPadOS native-share
acceptance of the direct row action and responsive icons was subsequently
reported successful by the owner, without a named device/browser. The in-app
browser runtime failed during setup before opening the local page, so automated
checks are not treated as rendered-browser acceptance. The follow-up extending
the accessible icon/text pattern to compact Song, typed-lyric, and Recording
actions plus text-retaining Add and Replace actions is deployed as Worker
version `aa9630a7-0d56-4f21-b06e-873c80ef79d0`, client/service-worker build
`d0f72594ac8b`. Verification passes at 50 Vitest files / 343 tests, all 90 Python
audio tests, all three TypeScript projects, production build, and whitespace
checks. Access, migrations, aggregate D1, and foreign-key postflight are clean
with zero rows written.

The completed Recording-sharing slice adds reader-facing Recording playback
sharing. A read-only staging inventory found all 829 active Recordings ready with valid private MP3
playback: 193 derivative-backed and 636 already-canonical-original-backed, with a
24,420,114-byte maximum. The owner selected a 50 MiB Recording-sharing safety
bound for future headroom. The Recording-scoped route resolves the
current playback relationship server-side, verifies exact D1/R2 size, returns a
generic private no-store MP3, and never accepts a media/storage identifier from
the client. Capability-gated row sharing independently validates representation,
MIME, exact length, and size, with accepted cancellation/second-tap semantics.
It is committed and deployed as Worker
`c9db96fd-3028-457b-867a-482143732672`, client/service-worker build
`9f78a8f53da9`. The owner accepted the principal behavior after checking several
Recordings, correct selection among multiple rows, quiet cancellation, and
offline disabling; the device/browser was not recorded. Deliberately oversized
and slow-download second-tap paths remain automatically covered and need not be
forced with retained test media. See [recording-sharing.md](recording-sharing.md).
Automated verification passes at 51 Vitest files / 354 tests, all 90 Python
audio tests, all three TypeScript projects, production build, service-worker
build `9f78a8f53da9`, whitespace checks, and a zero-result/zero-write query probe
against the real staging D1 engine.

## Current execution order

The core read/edit/recovery/search/sharing flows and safe Scan/Recording create/
replace pipelines now work in staging. Scan orientation is deployed and
accepted. The credentialed-manifest deployment is also accepted on Android
Chrome. The owner is currently prioritizing private legacy file reconciliation;
no app implementation is selected during that work. Continue in this order:

1. continue only the owner-selected remaining private legacy file review. The
   individual typed-lyric documents and Drive `Final` are complete and must not
   be reopened without new evidence. Begin the next session with a read-only
   inventory of deferred visual/OCR and compilation material and Scan/Recording
   candidates outside `Final`; preserve the no-import/no-move boundary until
   separately authorized;
2. after that reconciliation is complete, implement the approved removal of
   source filenames from ordinary media presentation while retaining private
   provenance and recovery metadata, as defined in
   [media-filename-presentation.md](media-filename-presentation.md);
3. implement any other approved optional improvements as separate small commits
   with the existing automated and protected-staging device gates;
4. rerun the terminal unreferenced-upload inventory no earlier than 2026-08-16;
   any deletion executor and every physical delete remain separately designed
   and owner-approved;
5. investigate the two issue-marked Scan mappings, deferred unmatched cases, or
   reserved manual uploads only when prioritized; and
6. begin production readiness and cutover only after reconciliation, backup,
   quota, broader device-coverage, and explicit owner-approval gates pass.

This is a delivery order rather than a schema dependency. The accepted search and filter work remains independently testable while media workflows are added.

## Technical shape

Use one TypeScript Cloudflare Worker project that serves both the PWA static assets and the authenticated API from one origin. Bind the Worker to:

- D1 for relational catalog data and audit history;
- private R2 for scans, original audio, and playback derivatives;
- Cloudflare Access for allowlisted identity at the deployed boundary.

Audio decode validation and conversion are deliberately outside the 128 MB Worker runtime. Use the provider-neutral Python/FFmpeg core described in [audio-processing.md](audio-processing.md): run existing-media preparation locally and execute the same core once per single-task Cloud Run Job for rare new uploads, as defined in [audio-processing-invocation.md](audio-processing-invocation.md). Do not add an HTTP server for this boundary. Keep Cloudflare and Google Cloud within their free allowances when practical. The isolated Google Cloud staging Job and its keyless invocation boundaries are deployed; production resources remain separately approval-gated.

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

The Worker-side processing control plane is implemented and deployed.
A separately configured processor can claim one pending job, receive an expiring
lease plus operation-bound same-origin transfer capabilities, stream the exact
private source, and immutably upload one derivative attempt. The Worker accepts
only a strict policy/job/source-bound result, independently re-hashes stored
source and derivative bytes, and atomically records provenance, playback
readiness, and job success. Safe failures are durable and editor-retryable. The
versioned processor token and exact transfer origin are now configured across
the least-privilege Google secret and protected Worker boundary. The control
plane is deployed to protected staging with its schema guards. A real uploaded
Recording and the Scheduler/on-demand no-work paths have completed successfully.

The provider-neutral processor-side HTTP adapter is also implemented locally as
a one-job library boundary around the existing Python/FFmpeg `prepare()` core.
It does not retry claim, validates the strict lease/capability envelope and exact
Worker routes, disables redirects, streams the source into a private temporary
directory with exact length/hash enforcement, uploads only a reverified selected
derivative, and sends bounded idempotent result/failure callbacks. A result
delivery that may already have committed never becomes a contradictory failure
callback. No HTTP server is added. The Cloud Run Job and both credential
boundaries exist in protected staging. The runtime strictly loads one file-only
Access client ID/secret pair, sends the standard two Access headers on claim and
every same-origin capability request, retains the separate Worker bearer token,
and rejects any additional transfer origin. The accepted design remains a
scheduled single-task Cloud Run Job. Its database-enforced
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
Exact cloud commands, cost assumptions, rotation, rollback, and staging checks
are reviewed in [audio-processing-cloud-runbook.md](audio-processing-cloud-runbook.md).
Production remains separately owner-approved and uncreated.

The deployed credential checkpoint uses a dedicated Cloudflare Service Auth
token/policy for processor requests and Workload Identity Federation for Worker
invocation of the fixed Job. Live no-work dispatch passes without a Cloudflare-
held Google key. The runtime identities retain no project-wide role, and routine
logs contain aggregate outcomes only.

The imported-Scan fingerprint inventory and deterministic local planner are now
implemented. The planner streams and hashes all catalog-linked Scan sources,
requires one-to-one catalog relationships and unchanged byte sizes, verifies
pre-existing hashes, reports duplicate-content groups without merging them, and
keeps detailed identifiers under ignored private output only. The guarded local
database executor is also implemented: it requires exact plan confirmation for
application, re-runs the complete source/catalog reconciliation, checks live
Scan/media state, updates only null hashes in one immediate transaction, and
accepts only exact already-applied state on rerun. Focused rollback/idempotency
tests plus fresh and existing-catalog isolated verification pass. The local tool
still cannot change legacy, D1, R2, or staging state. A separate bounded Worker
maintenance task now performs the authorized staging fingerprint/derivative
repair with leases, failure records, and aggregate reconciliation.

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
The reviewed runtime/scanning APIs, keyless service accounts without
project-wide roles, and one regional scanning-enabled repository exist. The
first Bookworm image was pushed only for vulnerability review and is blocked
from deployment. Its hardened Debian 13/FFmpeg 7.1 replacement was pushed by
exact owner-reviewed commit tag, resolved to the proved local digest, scanned,
and passed the reviewed package/reachability gate for a future digest-pinned
Job. The automatically replicated processor and Access credential secrets each
have one enabled version and only a secret-level runtime accessor; the matching
processor token and exact transfer origin are Worker secrets, while an attached
Cloudflare Service Auth policy selects only the dedicated service token. The
exact reviewed digest is configured as a Ready Cloud Run Job with the bounded
resource and environment contract. The runtime reads its two fixed-version
secrets, the Scheduler identity and the Cloudflare WIF principal set alone can
invoke the Job, and live no-work execution through the federated on-demand path
has passed. The existing Scheduler is enabled every 15 minutes as a fallback.
The former trigger service-account key has been removed from both providers and
the former identity is disabled. A separate Google production project has not
been created.

Never point development code at production data by default.

Cloud data placement uses the APAC location hint because normal users are primarily in India. This applies to both D1 primary databases and R2 media buckets; creation from the developer's current location in Europe must not determine automatic placement.

## Phase 1 — foundation and importer

1. Scaffold the TypeScript application, formatting, linting, tests, and local Worker configuration.
2. Define a maintainable schema using clear domain names rather than copying spreadsheet column names mechanically.
3. Build a read-only workbook/media importer with dry-run mode.
4. Preserve legacy IDs and lyric blocks while normalizing known case-only reference errors.
5. Produce reconciliation output for every table, relationship, and media object.
6. Add tests for duplicate keys, orphan prevention, lyric migration, and delete guards.

Deliverable: repeatable local database creation from `legacy/appsheet/data.xlsx` with no legacy modification.

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
   - current staging status: the online-only Add Recording form and resumable
     multipart orchestration are deployed and owner-accepted with real create,
     replacement, interruption/resume, duplicate handling, processing, playback,
     metadata edit, and recoverable Trash/restore checks on macOS Safari and
     Android Chrome; the Song view also exposes the revision-guarded editor retry
     for failed audio preparation without disclosing its job ID or internal
     failure code;
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
- one-tap system sharing of an individual Scan's authenticated readability JPEG
  is deployed with capability and representation checks and no public media URL;
  the owner reports that it works well without naming the tested device/browser;
  Recording playback sharing is deployed and similarly accepted for principal
  behavior with its separate bounded privacy contract;
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
