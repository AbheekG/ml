# Scan original recovery

Status: guarded staging recovery completed on 2026-07-17 for the exact
owner-reviewed set. Production remains absent and unapproved; unresolved cases
remain separately owner-gated.

## Purpose and stop boundary

Some imported Scan sources passed through AppSheet image compression. The older
read-only Drive collection may contain the genuine uploaded bytes. Recovery must
identify those originals without trusting filenames, folder placement, file
size, or resolution alone.

The local command is:

```bash
npm run media:recover-scan-originals
```

It is aggregate-only and dry-run by default. `--write-report` writes the detailed
deterministic result only below an ignored private root. `--write-review` also
creates private current/candidate/difference aids, contact sheets, and a local
scrollable HTML gallery. The gallery has status/checklist filters, large and
compact layouts, and bulk decisions. Direct `file:` preview is deliberately
view-only because browser storage for local files is not reliable. Run
`npm run media:review-scan-originals` and open its capability-bearing loopback
URL for review: every change is atomically autosaved to an ignored private JSON
file bound to the report digest and complete gallery scope. The server listens
only on `127.0.0.1`, requires its random session cookie, serves only the selected
opaque-token gallery/images, and makes no external request. Its export endpoint
returns the already persisted state. Neither command has a D1, R2, Wrangler,
deployment, or external-network client, and neither writes to `legacy/`.

An owner-supplied state export is imported with
`npm run media:import-scan-review`. Import is dry-run by default and requires
explicit expected correct/issue/unreviewed counts. `--write-confirmation`
normalizes the durable private review state and writes a report- and export-
digest-bound `owner-confirmed-matches.json`. It records visual match approval
separately from activation eligibility: no-change, quality regression, duplicate
candidate hash, issue, and unreviewed safeguards remain explicit, and import
never authorizes or performs activation.

`npm run media:pdf-scan-review` creates a final-check PDF from the private
combined confirmation ledger. It revalidates every opaque current/candidate
mapping against the authoritative report, requires activation to remain
unauthorized, and embeds the already generated comparison JPEGs directly—two
per A4 landscape page—without re-encoding or contacting an external service.
The aggregate output reports the mapping/page/byte counts and PDF/report hashes.

`npm run media:review-unassigned-drive` derives the still-unassigned genuine
image set from the exact and owner-confirmed mappings. It re-hashes each legacy
source read-only, then writes an ignored private inspection page with a bounded
preview, real filename, path within `drive/Final`, dimensions/size, original-file
link, and any issue/unreviewed/deferred primary relationship. Stdout remains
aggregate-only; private names and paths appear only in the ignored report.

After the owner decides every item in that exact seven-candidate snapshot,
`npm run media:apply-unassigned-drive-feedback` revalidates all seven hashes and
relationships before writing a deterministic private disposition record. For an
upside-down confirmed match, it preserves the genuine source bytes and records
a required 180° display/readability transform; it rotates only the private
inspection preview. Ignored and later-manual-upload files remain unassigned.
The update is idempotent and never mutates legacy files or authorizes activation.

After the owner explicitly approves every `confirmed_replacement` in a specific
report, rerun report mode with `--owner-approve-confirmed-replacements`. This
writes a private deterministic approval record bound to the exact report digest
and opaque mapping set. The full gallery then locks those cards as owner
confirmed, `remaining.html` contains the still-actionable non-unmatched cases,
and `deferred-unmatched.html` keeps unmatched cases separate for later. The flag
records review only; it does not upload, activate, deploy, or contact cloud
services. A later report mismatch blocks reuse of the approval record.

Report mode checkpoints opaque per-file feature caches under the same ignored
private root. Each cache entry is accepted only after re-hashing its source and
matching the extractor version, path, and byte size; missing, stale, or corrupt
entries are regenerated. This makes long analysis resumable without making the
report depend on cache state.

## Deterministic matching method

The planner validates that every imported Scan has exactly one catalog media row
and one unchanged local AppSheet file. It inventories the complete older tree,
classifies image and non-image files, fully decodes image candidates with bounded
pixels, applies encoded orientation, and records exact SHA-256, dimensions,
format, byte size, sharpness, entropy, edge density, page coverage, and border
clipping indicators.

Matching proceeds in auditable stages:

1. Unique exact SHA-256 pairs are locked first and classified as current files
   that are already genuine originals. Duplicate hash groups remain conflicts.
2. Remaining images receive rotation-aware perceptual and difference evidence
   from full-page, contained, border-trimmed, and small-crop representations.
   Independent measures include perceptual/difference hashes, normalized pixel
   correlation, edge correlation, and structural similarity.
3. Folder-to-Song title/alias association, filename evidence, page numbers, and
   within-folder/page order corroborate content evidence but never establish a
   match by themselves.
4. Only mutual-best, sufficiently separated, non-conflicting one-to-one pairs
   with strong content and association evidence are locked. Locked pairs leave
   the candidate pool before another pass. A final automatic tier requires
   ultra-strong content plus independent metadata.
5. Candidate hashes already registered to another current Scan, duplicated
   candidates, small score margins, possible one-to-many/many-to-one mappings,
   and quality regressions are withheld for owner review.

The quality gate does not equate larger dimensions with a better source. It
checks native pixel area together with normalized sharpness, coverage, border
clipping, and byte evidence. A securely matched candidate with no material gain
is retained as a no-change result. A candidate that appears less sharp, more
cropped, or lower coverage cannot become an automatic replacement.

The report contains its catalog and inventory hashes, confidence tiers,
alternatives, conflicts, duplicate groups, byte estimates, and explicit
one-to-one/hash-collision invariants. Re-running against identical inputs
produces the same report hash.

## Deferred unmatched registration experiment

`--experimental-unmatched` is an optional, owner-review-only second pass for
cases left unmatched by the authoritative method. It tries bounded asymmetric
crop and shear registration, searches only unclaimed genuine candidates, and
cannot create an automatic replacement. Duplicate candidates, narrow margins,
many-to-one evidence, and quality regressions remain withheld.

Run this mode only into a separate ignored private output directory. Its results
must not be mixed into an activation plan without separate owner review. The
current experiment found one additional structurally plausible candidate but
withheld it for a quality regression; the other 30 cases remained unmatched.
The owner deferred all 31 authoritative unmatched cases, so the v1 report and
its 310 proposed replacements remain the review source of truth.

Derivative byte totals are planning estimates produced locally with the same
2400-pixel/quality-85 shape, not a claim that Sharp and Cloudflare Images emit
identical JPEG bytes. The approved executor must replace those estimates with
the actual generated and independently verified derivative facts before upload.

## Reviewed replacement plan

Cloud replacement must be implemented as a separate dry-run-first executor. Its
private plan must name the exact reviewed report hash and, for each approved
replacement, bind all of the following:

- Scan ID, Song ID, expected Scan revision, and current media ID;
- current object key, source hash/size, and readability-provenance row;
- genuine local relative path, source hash/size/type/dimensions;
- proposed new media/history IDs and new private object keys;
- approved derivative policy, output hash/size/dimensions, and actor; and
- expected current database/R2 state plus complete rollback facts.

Before uploading, the executor must re-hash every local input, re-read current D1
rows, download and verify the current private source and derivative, check Scan–
Song association and revision, confirm the new source hash does not collide with
the fingerprint registry, and verify that no plan pair violates one-to-one or
one-hash constraints. Preview mode performs all feasible checks without writing.

For an approved write:

1. Generate a new opaque media ID and new create-only private keys. A suitable
   source namespace is `scans/recovered/<operation>/<media-id>.<ext>`; the current
   immutable derivative schema uses `scans/readability/<media-id>.jpg`. Never
   overwrite an existing key.
2. Fully decode and validate the genuine source, generate a correctly oriented
   JPEG derivative with `scan-jpeg-v1-2400-q85`, and independently verify source
   and derivative hashes, sizes, MIME types, and dimensions.
3. Upload both objects create-only, read them back, and byte/hash-verify them.
   R2 success is checkpointed privately. A crash leaves at most verified private
   unreferenced objects, which are safe to reconcile and retry.
4. In one D1 transaction, insert the new fingerprinted `media_objects` row and
   immutable derivative provenance, insert the former active media in
   `scan_media_history`, revision-guard the Scan update to the new media ID, and
   update the parent Song audit timestamp. The transaction must prove every
   expected row change and final foreign-key relationship or roll back entirely.
5. Re-read D1 and R2 independently. Verify the Scan/Song/current-media
   association, revision increment, new source and derivative provenance, viewer
   representation, private access headers, former history row, and zero foreign-
   key errors. No old source or derivative becomes public or unreferenced history.

R2 and D1 cannot share a transaction. If uploads succeed but the D1 guard fails,
the new objects remain private and unreferenced for retry; current service remains
unchanged. If D1 succeeds but a postflight fails, rollback is another guarded D1
transaction that first records the newly activated media as history and restores
the prior media reference at the expected new revision. It never deletes either
pair.

## Retention and later cleanup

Activation removes the AppSheet-derived pair only from current use. The former
source remains referenced by immutable Scan history, and its readability object
remains private and recoverable. No physical garbage collection is part of
recovery. A later cleanup procedure requires accepted migration results, a
separate verified backup, explicit owner approval, a fresh reference/history
inventory, and its own dry run and rollback plan.

## Completed staging activation

The first owner-approved staging operation used the separate resumable executor
`scripts/scan-original-swap-executor.ts`. Its immutable private plan bound 446
replacements plus one recoverable Scan Trash action to the authoritative report,
owner correction records, current live revisions, old and new object hashes,
actual generated readability outputs, and deterministic new media/history IDs.

Before activation, the executor downloaded and verified every affected current
source and derivative. It uploaded 892 new private objects under new keys with
create-only enforcement, in-storage verification, and a second independent API
download/hash pass. Each replacement then ran as an idempotent guarded D1
transaction that inserted the fingerprinted media and readability provenance,
retained the former media in immutable history, revision-advanced the Scan, and
verified foreign keys. The rejected wrong-parent Scan used the normal recoverable
Trash semantics; no source or derivative was permanently deleted.

Postflight independently re-read D1 and downloaded all activated R2 objects
again. It confirmed all 446 live replacements, the single Trash action, 446
history rows, zero foreign-key errors, and the required display rotation. The
ignored private postflight PDF contains former-current versus activated-source
comparisons derived only from hash-verified live bytes. No garbage collection,
application deployment, legacy write, or production change was part of the
operation.
