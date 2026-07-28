# Scan integrity and readability

Status: the selective representation policy is implemented by migrations
`0023_scan_readability_selection.sql` and
`0024_scan_readability_v2_keys.sql`. Migration 0023 and the first Worker
checkpoint are deployed to protected staging; the corrective v2-key migration,
Worker deployment, and one-time AppSheet reconciliation are recorded as
complete only after their guarded postflight succeeds. O-1 material is outside
this operation.

## Retained source and selected representation

Every interactive create or replacement keeps the exact private JPEG, PNG, or
WebP upload as the Scan original. D1 records one immutable readability selection
for that source using policy `scan-readability-selection-v2`:

- `source / direct_safe_source` means the authenticated viewer serves the exact
  original and no readability object exists;
- `derivative / required_normalization` means a distinct JPEG is necessary for
  safe, predictable viewing; or
- `derivative / optional_material_savings` means an already safe source had a
  distinct candidate that met both storage-saving thresholds.

A direct source must be a genuinely decoded JPEG with at most 2400 pixels on
each edge and at most 100 million decoded pixels. The encoded file must be
conventional 8-bit baseline or progressive grayscale/RGB, with no EXIF, XMP,
IPTC, ICC, Adobe, comment, embedded thumbnail, orientation, or unknown
application segment. A minimal thumbnail-free JFIF header is allowed. This
deliberately narrow lane makes the exact source a browser-portable, metadata-free
readability representation.

Safe sources smaller than 1 MiB are selected directly without invoking the
lossy encoder. For a safe source of at least 1 MiB, the Worker may generate the
normal JPEG candidate, but retains it only when it saves both at least 20% and
at least 256 KiB. A larger or immaterial candidate is discarded and never
uploaded. Failure of this optional attempt does not fail the Scan.

PNG, WebP, an over-2400 source, or a JPEG outside the direct-safe encoding rules
requires normalization. The required candidate uses the existing immutable
`scan-jpeg-v1-2400-q85` contract: applied source orientation, longest edge at
most 2400 without enlargement, quality 85, white transparency background,
animation disabled, and metadata omitted. Any metadata block emitted by the
image service is stripped before hashing or storage. Its type, dimensions, exact byte
size, SHA-256, and conventional JPEG structure are reverified. Required
generation failure fails safely before a Scan record is committed.

The source object and any distinct derivative remain private. The normal image
route resolves the recorded selection transparently; `Open original` always
returns the exact retained source. Manual quarter-turn correction remains
presentation metadata and never rewrites either representation. See
[the Scan orientation policy](scan-orientation.md).

## Storage, duplicates, and failures

A direct Scan stores one R2 object plus its small D1 selection row. A required
or materially smaller Scan stores the original and one distinct derivative.
There is no placeholder or same-bytes derivative.

D1 owns the race-safe original fingerprint registry. Exact duplicate detection
covers every retained Scan original and every derivative that was actually
kept. Discarding a derivative removes its hash from the duplicate surface; no
retired-hash tombstone is kept for the pre-user test catalog.

Create and replacement upload their necessary objects before one atomic D1
batch records media, optional derivative, selection, Scan/history, and audit
state. Cleanup deletes D1 rows only after a failed commit is disproved, then
removes the unreferenced R2 objects. An ambiguous database response retains
objects until exact D1 reconciliation shows whether the batch committed.
Required normalization errors never replace or delete an existing Scan.

Historical maintenance uses the same selector after independently hashing and
fully decoding the retained source. Leases, bounded retry records, and
privacy-safe error codes remain unchanged. Operational monitoring reports a
missing selection only for a current Scan, so the one preserved synthetic
legacy replacement history is not misreported as unfinished current work.

## One-time AppSheet reconciliation

The cleanup is intentionally narrower than a general test-data purge:

- preserve all 499 current Scan source objects and all Scan rows;
- classify every current source with the same policy and record 499 selections;
- prepare every required/material current derivative as metadata-free bytes,
  prove that metadata removal did not change its displayed pixels, and upload
  it under a new `scans/readability-v2/<media-id>.jpg` key before D1 changes;
- delete every old current derivative object after D1 commits: direct
  selections have no replacement, while required/material selections point to
  their verified v2 replacement;
- delete exactly the 446 accepted
  `migration:scan-original-recovery-v1` superseded history rows, their former
  media/provenance/fingerprint rows, and—only after D1 commits—their former
  source and derivative R2 objects;
- preserve the one unrelated synthetic replacement history and all other
  synthetic staging entities; and
- preserve without substitution all unresolved current AppSheet-derived
  sources, applying only the representation-selection policy to them.

`scripts/scan-readability-reconciliation.ts` defaults to no mode and exposes
five explicit phases: `plan`, `upload-r2`, `apply-d1`, `delete-r2`, and
`postflight`. Planning
freshly reads and hashes every current source/derivative and every object
proposed for recovery-history deletion, binds the accepted private recovery
plan, and writes only an ignored private plan and prepared candidates. The
upload phase refuses a conflicting v2 key, verifies every uploaded object by
size and SHA-256, and checkpoints the exact set. D1 application requires that
plan's SHA-256 and complete upload checkpoint, re-verifies the v2 objects,
repeats the full live inventory, and runs one guarded transaction. It
temporarily removes and recreates the history-retention trigger inside that
transaction. The generated SQL deliberately omits nested `BEGIN`/`COMMIT`
statements because Wrangler's remote file importer owns the rollback-safe
transaction; local replay wraps the same statements explicitly and proves a
late provenance failure rolls every earlier delete back. R2 deletion is a
separate idempotent phase that cannot start until
the exact D1 post-state is confirmed. Failure after D1 can therefore leak
unreferenced private objects but cannot leave D1 pointing to a deleted object.

The expected post-state is 499 current Scans, 500 retained Scan media rows and
fingerprint members (499 current plus the one preserved synthetic history), one
history row, 499 selections, and zero foreign-key errors. The derivative count
and R2 object count depend on the freshly measured number of direct selections.
The R2 deletion scope is always 1,391 old objects: 499 old current derivatives
plus 446 recovery source/derivative pairs. The number of prior v2 uploads and
retained current derivatives is the freshly measured number of
required/material selections. Any count, ID, hash, byte-size, policy, or object
mismatch aborts before a destructive phase.

## Portable archives and acceptance

Source schema `0023` snapshots selection provenance. A direct current Scan has
one original payload with readability mode `direct` and the same original/read
path. A selected derivative has distinct original and optimized payloads.
Replacement history records its own selection when present; the preserved
pre-policy synthetic history remains explicitly `optimized_legacy` rather than
being rewritten. Preparing a new archive fails if any current Scan lacks a
selection.

Automated coverage includes strict JPEG marker handling, no-encoder safe inputs,
both savings thresholds, required-versus-optional failure, create/replacement
atomicity, maintenance ambiguity, authenticated view/share behavior, schema
constraints, guarded reconciliation ordering/scope, duplicate behavior, and
portable TypeScript/Python round trips. Real-device review should still sample
portrait/landscape pages, fine handwriting, contrast, color annotation,
transparency, and phone-camera orientation on Safari/iOS and Chrome/Android
before production cutover.
