# Scan integrity and readability

Status: implemented in protected staging, 2026-07-18. The owner accepted the ten
highest-risk local visual candidates. Viewer and direct Song-row optimized-Scan
sharing are deployed as Worker version `b3ccdca7-683b-4881-b4aa-1a85dd4d892a`,
client/service-worker build `b4de0994f09e`; the owner reports that the deployed
sharing and responsive actions work well. The specific device/browser was not
recorded, and broader iPadOS compatibility remains a later non-blocking gate.

## Policy

Every new or replacement Scan keeps the exact private original. The Worker
accepts JPEG, PNG, and WebP inputs up to 20,000,000 bytes, verifies the byte
signature, fully decodes the image, applies encoded orientation, and prepares a
JPEG derivative using policy `scan-jpeg-v1-2400-q85`:

- longest edge at most 2400 pixels, without enlargement;
- quality 85 with a white background for transparency;
- animation disabled and metadata omitted; and
- output dimensions, byte size, MIME type, and SHA-256 independently verified.

The derivative and original stay in private R2. The authenticated Scan viewer
uses the derivative when provenance exists and otherwise falls back to the
original. “Open original” deliberately continues to request the retained source.
No public bucket, delivery URL, or unauthenticated cache is introduced.

Manual quarter-turn correction is deliberately separate from derivative
provenance: the browser applies one constrained Scan-level display value and
creates any rotated native-share file only in temporary browser memory. It does
not rewrite either stored representation. See
[the Scan orientation policy](scan-orientation.md).

## Optimized-Scan sharing

On capable online browsers, the Song row or viewer can fetch the authenticated
readability route and pass its exact bytes to the native system share sheet as a
generic `scan.jpg` file. The client accepts only a successful private response explicitly
marked `readability`, with JPEG type, a positive exact length, and a 20 MiB
maximum. An original fallback is rejected rather than shared.

The share payload contains only the file: it adds no title, catalog text, or
public URL. The bytes are held only for the immediate action. If the fetch makes
the browser's user-activation window expire, the prepared file remains in viewer
memory and a second tap completes the share without another download. Canceling
the native sheet is quiet; unsupported browsers do not show the action, and the
action is disabled while offline.

An upload of the exact stored readability JPEG is rejected as a duplicate and
resolves through immutable derivative provenance to the existing Scan, including
its normal Trash recovery option. Rotation applied for current-view sharing is
rendered and JPEG-encoded in the browser, so those bytes differ from the stored
readability object; the narrow exact-content rule does not attempt perceptual
matching of that rotated or otherwise re-encoded file.

## Integrity and replacement

D1 owns a global SHA-256 registry. New media insertion requires a valid hash and
rejects an existing original fingerprint or exact stored readability hash/size
inside the database, closing the race left by a preflight-only duplicate check.
Existing imported equal-content files remain separate historical members and
are never silently merged. Provenance binds each derivative immutably to the
exact source media ID, source hash/size, output hash/size/dimensions, policy,
time, and actor.

Replacement first prepares and stores both new objects, then atomically records
the previous current media in immutable history and advances the Scan revision.
Any storage, conflict, or database failure removes only the uncommitted new
objects/rows. Originals and historical media have no automatic deletion policy.

## Historical repair

The daily Worker schedule processes a small bounded batch. For each source it:

1. acquires an expiring D1 lease so overlapping invocations cannot race;
2. reads the retained R2 object and verifies type, byte size, and any existing
   hash;
3. commits the source fingerprint independently of derivative success;
4. creates, stores, and verifies derivative provenance; and
5. clears the lease/failure record on success.

Failures use bounded codes and a one-day retry delay; catalog identifiers and
filenames are not logged. A crash leaves the work eligible after lease expiry.
The operational snapshot reports missing hashes/derivatives, failures, and
expired leases. The repair never writes to `legacy/` or replaces an original.

Before production cutover, inspect representative portrait/landscape pages,
small handwriting, high-contrast ink, color annotations, transparency, and
phone-camera orientation on real Safari/iOS and Chrome/Android. Any policy change
creates a new policy/version; it must not rewrite immutable provenance in place.
