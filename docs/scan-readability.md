# Scan integrity and readability

Status: implemented in protected staging, 2026-07-16; representative visual
quality remains an owner/device acceptance gate.

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

## Integrity and replacement

D1 owns a global SHA-256 registry. New media insertion requires a valid hash and
rejects an existing fingerprint inside the database, closing the race left by a
preflight-only duplicate check. Existing imported equal-content files remain
separate historical members and are never silently merged. Provenance binds each
derivative immutably to the exact source media ID, source hash/size, output
hash/size/dimensions, policy, time, and actor.

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
