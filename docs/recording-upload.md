# Recording original upload

Status: approved implementation boundary; cloud configuration remains separately approved.

## Decision

New Recording originals use an authenticated, resumable multipart upload through
the existing application Worker and its private R2 binding. The browser never
receives R2 credentials, a public bucket URL, or a permanent unauthenticated URL.

The browser slices the selected file into sequential 8 MiB parts and sends each
part as a raw request body. The Worker authorizes the editor, validates the
upload session and exact expected part length, and streams that request body into
an R2 multipart upload. Completed parts can be retried idempotently and the
browser can resume from server-reported state.

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

## Finalization boundary

Completing R2 multipart storage does not create a ready Recording. The Worker
must retrieve the completed private object and stream it through Cloudflare's
native SHA-256 `DigestStream`, verify the exact expected byte size, then create
the fingerprinted `original_audio` media row, processing Recording, and pending
audio-processing job atomically in D1. The job snapshots the original media ID,
hash, size, and policy.

If D1 finalization fails, the completed opaque R2 object stays private and
unreferenced for explicit retry/reconciliation; it is never silently deleted.
An incomplete multipart upload remains abortable and is also covered by R2's
incomplete-upload lifecycle. Cleanup is a later deliberate administrator task.

The hosted converter receives only the job-scoped transfer capabilities defined
in [audio-processing.md](audio-processing.md). It prepares and verifies playback
media before the Worker independently verifies stored bytes and atomically marks
the Recording ready. Play never starts conversion.

## Upload-session API shape

The later endpoint slice will expose editor-only, online-only operations to:

1. create an opaque upload session from metadata, filename, MIME hint, and exact
   byte size;
2. upload or retry one numbered raw part with the exact expected length;
3. inspect completed part numbers for resume;
4. complete and fingerprint the private object, then atomically create the
   Recording and processing job;
5. abort an incomplete session without deleting any finalized media.

Filenames, titles, signed capabilities, hashes, and private object keys must not
enter routine logs. The client cannot select the parent Song or object key after
the session is created.
