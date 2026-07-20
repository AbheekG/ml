# Recording original upload

Status: implemented, deployed to protected staging, and manually accepted with
exact D1/R2 postflight; production remains separately approval-gated.

## Decision

New Recording originals use an authenticated, resumable multipart upload through
the existing application Worker and its private R2 binding. The browser never
receives R2 credentials, a public bucket URL, or a permanent unauthenticated URL.

The browser slices the selected file into sequential 8 MiB parts and sends each
part as a raw request body. The Worker authorizes the editor, validates the
upload session and exact expected part length, and streams that request body into
an R2 multipart upload. Completed parts can be retried idempotently and the
browser can resume from server-reported state.

The Worker persists each returned R2 part ETag in D1. Completion accepts no
client-supplied ETags and uses only that server-owned set. Session creation uses
a client mutation ID plus a canonical request fingerprint, so a lost response can
be retried without starting two intentional uploads or reusing one mutation ID
for different metadata.

The initial application limit is 512 MiB per original. This is deliberately far
above the current private maximum while keeping the bounded workflow small. It
can be raised later without changing the stored model. Empty files are rejected.

## Why this transport

- Cloudflare Free/Pro inbound requests are limited to 100 MB and Worker isolates
  have 128 MB memory, so a whole-file application request is not the general path.
- R2 multipart uploads accept 5 MiB to 5 GiB parts (except the final part) and
  are resumable. An 8 MiB application part leaves ample request-limit headroom.
- Worker Streams allow request bodies to reach R2 without whole-part buffering.
- The R2 binding carries authorization without adding long-lived S3 credentials,
  presigned-URL generation, or bucket CORS to the application.

## Storage-completion and finalization boundary

Completing R2 multipart storage does not create a Recording. The implemented
completion endpoint uses only server-held part ETags, recovers a lost R2
completion response by checking the opaque private object, verifies its exact
size, and streams it through Cloudflare's native SHA-256 `DigestStream`. It then
stops durably at `stored`, or at `duplicate` with the existing private Recording
identity when the exact bytes already exist as either its retained original or
its generated playback representation. This covers reuploading an MP3 obtained
through the app's Recording share/download path. It never creates a media row,
Recording, or processing job in either state.

The implemented finalization endpoint rechecks duplicate content inside the same
D1 transaction that creates the fingerprinted `original_audio` media row,
processing Recording, copied credits, and pending audio-processing job. The job
snapshots the original media ID, hash, size, and policy. This second duplicate
check is required even after completion because another upload could finalize
concurrently. A successful transaction moves the session to `finalized`; a
concurrent exact-content match against an original or generated playback object
moves only the session to `duplicate`. This is intentionally byte-exact
deduplication; an independently re-encoded version of the same performance is
not inferred to be identical.

A supplied description must remain normalized-unique within its Song. A conflict
leaves the verified object and session safely at `stored`, identifies the
existing Recording, and accepts an explicit description override on retry. When
no description was supplied, finalization chooses the first available stable
`Recording N` fallback inside the transaction.

If D1 finalization fails, the completed opaque R2 object stays private and
unreferenced for explicit retry/reconciliation; it is never silently deleted.
An incomplete multipart upload remains abortable and is also covered by R2's
incomplete-upload lifecycle. The separate
[upload-object cleanup policy](recording-upload-cleanup.md) now provides a
read-only dry-run planner for exact terminal unreferenced objects. It has no
delete capability; permanent deletion remains a later owner-approved operation.

The hosted converter receives only the job-scoped transfer capabilities defined
in [audio-processing.md](audio-processing.md). It prepares and verifies playback
media before the Worker independently verifies stored bytes and atomically marks
the Recording ready. Play never starts conversion.

The Worker half of that control plane is implemented and deployed in protected
staging. Processor claim authentication is separate from end-user Access roles.
One claim creates a
one-hour opaque lease and four HMAC-bound operation capabilities, so changing a
source URL into a derivative/result URL fails authentication. Only the lease
hash is retained in D1. Derivative upload uses a deterministic attempt-specific
private key with create-only semantics: a lost response can be retried without
overwriting the first stored bytes, and a new lease receives a new attempt key.
The hosted HTTP adapter, browser orchestration, keyless runtime resources, and
fallback scheduling are deployed in protected staging. Manual acceptance passed
create and replace uploads, processing, playback, interruption/resume, duplicate
rejection/dismissal, and retained former history. Production resources remain
separately owner-gated.

## Upload-session API shape

The server-side transport exposes editor-only, online-only operations to:

1. create an opaque upload session from metadata, filename, MIME hint, and exact
   byte size;
2. upload or retry one numbered raw part with the exact expected length;
3. inspect completed part numbers for resume;
4. complete, size-check, and fingerprint the private object, stopping for an
   exact-content duplicate;
5. atomically finalize a nonduplicate stored object into its original media,
   processing Recording, credits, and pending processing job;
6. abort an incomplete session without deleting any finalized media.

The local online-only browser form validates the 512 MiB file boundary, locks the
selected file and metadata after the first intentional attempt, uploads sequential
8 MiB `Blob` slices, and reconciles lost responses from server-held completed-part
state while the original `File` remains selected. It shows aggregate progress,
stops on duplicate content, preserves a verified `stored` session for an explicit
description override, and offers revision-bound abort only before storage
completion. It has no offline queue and is deployed and manually accepted in
protected staging on macOS Safari and Android Chrome. Recoverable sessions are
scoped to their creating account, so the same account may resume from another
device while a different editor account cannot see or take over the upload.
A client retry supplies only the current session revision and, when resolving a
description conflict, an explicit replacement description. It never supplies an
ETag, object key, multipart ID, claimed fingerprint, media ID, Recording ID, or
job ID.

Filenames, titles, signed capabilities, hashes, and private object keys must not
enter routine logs. The client cannot select the parent Song or object key after
the session is created.

## Failure and concurrency rules

- Durable session states are `creating`, `open`, `completing`, `stored`, and the
  terminal `duplicate`, `finalized`, `aborted`, or `failed` states.
- A crash after R2 multipart creation but before D1 records the upload ID may
  leave an incomplete R2 upload; retry creates a replacement and R2 lifecycle
  cleanup handles the unreachable incomplete upload.
- A part stored in R2 but not checkpointed in D1 is retried at the same part
  number. The replacement ETag becomes the only completion input.
- A completion retry in `completing` first checks whether the opaque object now
  exists with the exact expected size before attempting another completion.
- If R2 completion fails and no object exists, the D1 session returns to `open`
  with all server-held part checkpoints retained for safe retry. A completed
  object whose metadata or streamed byte count disagrees with the request moves
  the session to `failed` and is preserved privately for explicit review.
- Song Trash is blocked while a nonterminal upload or unresolved duplicate is
  attached to it. Recording Trash is blocked while audio processing is pending
  or running.
- Expired sessions accept no new parts but may complete if every part was already
  checkpointed. An expired session that never acquired an R2 multipart ID is
  automatically aborted so it cannot strand its Song. Abort changes D1 first;
  an R2 abort failure leaves only a private incomplete upload for lifecycle
  cleanup.
- A streaming hash duplicate stops before Recording creation and identifies the
  existing private record. If that Recording is trashed, the duplicate panel can
  atomically restore/move the existing Recording to the upload's active Song and
  dismiss the duplicate session without deleting its retained upload object.
  This preserves one Recording and one referenced original media row. Reusing
  identical media for two simultaneously active, genuinely distinct Recordings
  remains unsupported and would require a separate schema/product decision;
  finalization must not imply or bypass it.
- Finalization is one D1 transaction: media, Recording, copied credits, job, Song
  timestamp, and session outcome either all commit or all roll back. A response
  lost after commit is retried idempotently from the terminal session. The
  processing original is not served by the media endpoint until a verified job
  makes a ready playback source available.
- A processor result cannot make media playable by assertion alone. The Worker
  re-hashes the stored original and, when selected, the attempt-specific
  derivative; a missing derivative is retryable, a byte mismatch durably fails
  the job without cataloging the object, and the ready/provenance/job graph is a
  single guarded D1 batch. A lost success response is idempotent. Failed jobs
  retain privacy-safe codes and require an explicit editor retry before another
  lease can be claimed.
- Multipart IDs, ETags, object keys, hashes, filenames, and transfer capabilities
  are excluded from routine logs. Authenticated status responses return only the
  minimum editor-facing filename and completed part numbers.
