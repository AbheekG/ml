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
- A later HTTP adapter handles rare new uploads on a scale-to-zero Google Cloud Run service.
- The Cloudflare Worker remains responsible for authorization, D1/R2 state, expiring job-scoped transfer authorization, retry orchestration, and atomic finalization.
- The hosted service receives no permanent public media URL and should not require broad R2 credentials.

Cloud Run project creation, billing activation, secrets, and deployment remain separate owner-approved external actions after local conversion behavior is tested.
