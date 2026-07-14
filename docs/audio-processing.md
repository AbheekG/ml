# Audio processing and playback

Status: approved implementation decision, 2026-07-14.

## Goals

- Preserve every uploaded original byte-for-byte as private archival media.
- Prepare a reliable browser playback source once, never in response to Play.
- Keep mobile playback predictable without creating unnecessary lossy copies.
- Use the same provider-neutral conversion rules for local migration and hosted processing.

## Canonical playback policy

Content inspection, not the filename extension or supplied MIME type, determines the codec and container.

- A decodable MP3 original is normally its own playback source.
- A non-MP3 original receives a private MP3 playback derivative.
- A valid but unusually large MP3 becomes a derivative candidate only when it is at least 25 MiB and its measured or duration-derived bit rate is at least 256 kbit/s.
- Keep an oversized-MP3 candidate only when the verified result is at least 20% smaller than the original. Otherwise discard the candidate and use the original.
- Never re-encode a reasonable valid MP3 merely to make every file uniform.

The Recording's playback-media reference is the preferred browser source. It points to the original for a normal canonical MP3 and to the generated derivative when conversion is required or materially reduces an oversized MP3. The application does not probe a noncanonical original first and make the user wait for a decode failure. A later explicit original-file download or playback action may expose the retained original without changing this default.

## Derivative encoding

Generate `audio/mpeg` with FFmpeg's `libmp3lame` encoder in constant-quality VBR mode using `-q:a 2`.

- Select the first valid audio stream and omit video, attached pictures, subtitles, data streams, and inherited metadata.
- Preserve mono or stereo. Downmix a future source with more than two channels to stereo.
- Preserve a supported input sample rate. Resample unusually low or unsupported rates to a safe MP3 rate, with 16 kHz as the minimum output rate.
- Retain FFmpeg's default Xing/LAME seek information in the seekable output.
- Do not normalize loudness, change gain, trim silence, or apply other content-altering filters.

The derivative is a delivery copy, not the archive. Quality and compatibility take priority over forcing a fixed byte size.

## Verification

Before a derivative can become the playback source:

1. inspect the original with `ffprobe`, decode it completely, record recoverable legacy bitstream errors, and reject input without one usable audio stream or with gross reported-versus-decoded duration disagreement;
2. encode to a temporary output outside the legacy folders;
3. strictly decode-check the complete output with no recoverable conversion errors;
4. verify MP3 codec/container, positive duration, expected channel/sample-rate bounds, and duration agreement with the original;
5. calculate SHA-256 and byte size;
6. apply the 20% saving rule when the source was already a canonical oversized MP3;
7. publish the accepted derivative with provenance that binds its hash and byte size to the original hash/size and conversion-policy version, then mark the Recording ready. Local preparation uses the adjacent JSON sidecar; catalog integration records the same binding in `audio_derivatives`.

Failures retain the original and remain retryable. Partial or rejected outputs are not catalog media.

## Execution model

The conversion core is a small Python module that invokes FFmpeg without containing storage- or cloud-specific logic.

- A dry-run/idempotent local adapter prepares existing imported derivatives into a new output area and reports aggregate reconciliation without modifying `appsheet/`.
- A separate planner re-hashes the prepared set and proposes deterministic private object keys, original fingerprint backfills, derivative/provenance rows, and Recording playback references. It cannot upload or mutate D1/R2; those remain separately reviewed actions.
- A dry-run-by-default executor consumes only that exact plan. Its R2 phase compares any existing deterministic object by size and SHA-256, uploads only a missing object, verifies the stored bytes, and atomically checkpoints each completed object in ignored private state. A rerun reuses verified objects and refuses conflicting bytes.
- The separately authorized D1 phase requires the reviewed plan hash, complete upload state, a fresh verification of every planned R2 object, and the already-applied derivative-provenance migration. It submits one guarded import whose live row/revision preconditions and final relationship reconciliation fail the whole database transaction if the catalog has diverged. It never applies schema migrations automatically.
- R2 and D1 cannot share one cross-service transaction. If upload succeeds but D1 is rejected, the new objects remain private and unreferenced; the saved state and idempotent guards make review and retry safe without deleting or replacing source media.
- A provider-neutral local HTTP adapter now handles one claimed job per call around the same conversion core. The proposed invocation boundary uses a single-task scheduled Cloud Run Job with no HTTP server; its local prerequisites and still-unapproved cloud gates are defined in [audio-processing-invocation.md](audio-processing-invocation.md).
- The Cloudflare Worker now implements the local control-plane half: separate processor authentication, FIFO pending-job claim, a database-enforced global single-running-job gate, one-hour leases, automatic recovery of the first two expired attempts, a durable failure on the third expiry, operation-scoped transfer authorization, immutable derivative attempts, independent R2 byte verification, privacy-safe failure state, explicit editor retry, and atomic finalization.
- The hosted service receives no permanent public media URL and should not require broad R2 credentials.

The hosted boundary is schema-versioned and binds each request to an opaque job,
the exact conversion-policy ID, and the expected original SHA-256/byte size. Only
short-lived job-scoped HTTPS download/upload capabilities cross the boundary; they
must not be logged or returned in the result. The service returns verified media
facts from the same `prepare()` core, while the Worker independently verifies
stored bytes before it changes Recording or playback state. A stale policy,
changed source, unverified derivative, or non-final processing result is rejected.
The hosted adapter also uses an explicit application-transfer-origin allowlist;
`https` alone is insufficient because an otherwise valid job body must not turn
the converter into an arbitrary network fetcher. Source and derivative
capabilities must name different paths, and the eventual HTTP transfer client
must reject or revalidate every redirect against the same allowlist rather than
following an allowlisted URL to an arbitrary host.

Cloud Run project creation, billing activation, secrets, scheduling, and deployment remain separate owner-approved external actions after the remaining local container/resource behavior is tested.

## Worker processing control plane

The processor routes deliberately bypass end-user Cloudflare Access handling but
do not become public application APIs. Claim, result, and failure requests
require a high-entropy `AUDIO_PROCESSOR_TOKEN` secret; transfer routes require an
opaque job/attempt/operation-scoped capability. The public application origin is
an explicit HTTPS-only `AUDIO_PROCESSOR_TRANSFER_ORIGIN`. Neither value belongs
in `wrangler.jsonc`, tracked logs, browser state, or result bodies.

A successful claim returns the already-approved hosted request nested with a
result URL and failure URL. The four URL tokens contain the random lease plus an
HMAC over job, attempt, and operation. D1 stores only the lease hash. The source
and derivative resources therefore differ both by path and cryptographic scope;
editing one path cannot grant another operation. A claim response contains no
filename, object key, Song/Recording/media ID, or long-lived processor secret.

Derivative upload is streaming, bounded to the original upload ceiling, and
create-only at `recordings/playback/pending/{job}/attempt-{n}.mp3`. Repeating a
completed PUT is harmless and cannot overwrite the first attempt. Before result
finalization, the Worker streams and hashes the exact original again and hashes
the derivative when one is selected. A derivative that is not yet readable
leaves the lease running for result retry; wrong bytes fail the Recording/job and
remain private and unreferenced. Direct-original and derivative success each use
one D1 batch whose final job guard rolls every catalog change back unless the
Recording, playback media, and provenance graph is complete. A response lost
after commit is reconciled from the succeeded job and returns idempotently.

The local processor adapter remains independent of the proposed scale-to-zero
Job invocation. It never retries claim, so one invocation cannot strand one
lease and then claim a second job after an ambiguous response. Source and
derivative transfers plus result/failure callbacks reject redirects; exact
source length/hash and selected derivative length/hash are checked again before
use. Result and failure delivery retries are bounded and idempotent, and a result
delivery that may already have committed is never followed by a failure
callback. The Worker now globally prevents concurrent running jobs and bounds
repeated lease-expiry recovery. The adapter enforces a monotonic 45-minute soft
deadline across transfer, FFmpeg, hashing, upload, and result delivery, requires
at least 55 minutes of lease remaining, and kills FFmpeg if its generated output
exceeds the configured ceiling while it is writing. No
processor token/origin is configured in staging. The run-once entrypoint reads
the token only from a secret file, rejects unknown processor-prefixed settings,
emits one aggregate-only JSON record, and uses nonzero exits for durable failure
or reconciliation. No HTTP server, Cloud Run
Job, scheduler, credentials, infrastructure, or deployment is part of this
local design.
