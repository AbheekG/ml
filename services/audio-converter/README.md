# Audio converter

This service contains the provider-neutral Python/FFmpeg core for the playback policy in [`docs/audio-processing.md`](../../docs/audio-processing.md).

The first adapter is a local, single-file CLI. It is dry-run by default, never changes its input, refuses output inside the protected legacy `appsheet/` and `woodchime/` folders, and emits no filename unless the caller deliberately supplies one as the opaque label.

```sh
cd services/audio-converter
python3 -m audio_converter.cli /private/input/file \
  --label opaque-recording-id \
  --output /private/new-derivatives/opaque-recording-id.mp3
```

Add `--execute` only after reviewing the dry-run decision. Execute mode writes through a temporary file and publishes a verified derivative plus an adjacent `.mp3.json` provenance manifest. The manifest binds the derivative to the original SHA-256 and conversion-policy version. An existing output is reused only when its manifest, hashes, sizes, and media validation all agree; an unproven or mismatched output is never overwritten automatically.

The CLI requires `ffmpeg` and `ffprobe` on `PATH`. Run its dependency-free tests from the repository root with:

```sh
npm run test:audio
```

## Batch adapter

The batch adapter consumes an ignored JSON manifest with unique opaque labels and separate input/output paths. Relative paths are resolved from the manifest directory. Every output must be an MP3 inside the declared output root and outside the protected legacy folders. Duplicate labels, inputs, outputs, unproven existing derivatives, stale outputs for canonical originals, and unexpected files in the output root stop or fail reconciliation.

```json
{
  "schemaVersion": 1,
  "outputRoot": "audio-migration-output",
  "jobs": [
    {
      "label": "opaque-media-id",
      "input": "../../appsheet/recordings/private-source",
      "output": "audio-migration-output/opaque-media-id.mp3"
    }
  ]
}
```

Run a read-only batch inspection by omitting `--execute`. Inspection completely decodes and hashes every source, so a large catalog can take time even though it writes no derivative:

```sh
cd services/audio-converter
python3 -m audio_converter.batch_cli /private/batch-manifest.json \
  --workers 4 \
  --details /private/ignored-batch-details.json
```

Standard output contains aggregate counts only. The optional detail report contains opaque labels and hashes but no source/output paths. Execute mode uses the same manifest and produces only individually verified, provenance-bound derivatives.

Do not put private filenames, titles, or personal information in tracked fixtures or captured logs. A catalog-specific manifest must use stable opaque IDs, deterministic output keys, aggregate reconciliation, and a separate ignored output area.

## Hosted-processing boundary

`audio_converter.hosted_contract` defines the versioned boundary for the local
provider-neutral HTTP adapter. The Worker supplies only an opaque job ID, the exact
policy ID, the expected original hash/size, and short-lived job-scoped HTTPS
transfer URLs. The converter result repeats the job/policy identity and contains
only verified media facts; it never echoes transfer URLs.

`audio_converter.hosted_adapter.run_hosted_job_once()` implements one bounded
processor pass without selecting an HTTP server or deployment platform. Its
configuration requires the exact Worker origin, a separately provisioned random
32-or-more-character printable processor token, a nonempty HTTPS transfer-origin
allowlist, an existing temporary root, and bounded request/body/retry limits. It
creates a private `0700` per-job directory and `0600` source, disables redirects,
streams and verifies the exact source, runs `prepare()`, rechecks and streams only
a selected derivative, sends exact-length callbacks, and removes the temporary
directory before reporting success. A monotonic 45-minute soft deadline covers
streaming, FFmpeg, hashing, upload, cleanup, and result delivery; claims require
at least 55 minutes of lease remaining. The default FFmpeg runner is killed while
writing if its output exceeds the configured ceiling. Routine outcomes and errors
contain no job ID, signed URL, token, or filesystem path.

Claim is intentionally attempted once: retrying a response-lost claim could
lease a second job during the same invocation. Create-only derivative upload and
result/failure callbacks have bounded retries because their Worker operations are
idempotent. An exhausted or redirected result callback is surfaced for
reconciliation and is never followed by a failure callback, because success may
already have committed. The Worker remains responsible for authorization, job
state, independent R2 verification, D1 finalization, retries, and expiry.
This contract does not create a hosted service, credentials, or cloud resources.
The HTTP adapter must pass an explicit nonempty allowlist of application transfer
origins to the contract parser; arbitrary HTTPS download/upload hosts are rejected
to keep job payloads from becoming an SSRF mechanism. Source and destination
paths must differ. The implemented client rejects redirects for every operation.

The application Worker implements the complementary local-only claim and
callback boundary. A claim wrapper contains `processingRequest` (the exact
payload parsed here), `resultUrl`, `failureUrl`, and the lease expiry. The local
adapter authenticates claim/result/failure with the separately supplied token and
uses only the strict operation-scoped URLs. No command-line secret interface,
HTTP server, container, cloud credentials, scheduling, or deployment is included.
The separately reviewable proposed run-once Job boundary and its required local
safeguards are documented in
[`docs/audio-processing-invocation.md`](../../docs/audio-processing-invocation.md).

## Run-once hosted entrypoint

`music-audio-hosted-run-once` calls the adapter exactly once and emits exactly
one aggregate JSON record. `no_work` and verified success exit zero; a durably
reported failure exits one; ambiguous delivery or an incomplete outcome exits
two for reconciliation. Exceptions, signed URLs, tokens, hashes, IDs, filenames,
and paths are never logged.

The entrypoint accepts no command-line secret. It requires these settings:

- `AUDIO_PROCESSOR_WORKER_ORIGIN`;
- `AUDIO_PROCESSOR_ALLOWED_TRANSFER_ORIGINS_JSON`, a nonempty JSON string array;
- `AUDIO_PROCESSOR_TOKEN_FILE`, an absolute path to a printable 32–512 byte
  secret file with no trailing newline; and
- `AUDIO_PROCESSOR_TEMPORARY_ROOT`, an existing absolute private directory.

Bounded timeout, retry, source/derivative/generated-byte, soft-deadline, and
minimum-lease settings may be overridden only through the documented
`AUDIO_PROCESSOR_` names enforced in `hosted_entrypoint.py`. An
`AUDIO_PROCESSOR_TOKEN` environment value and unknown prefixed names are rejected.

## Container and resource fixture

The final `runtime` image is based on the immutable multi-platform digest for
`python:3.13.14-slim-bookworm` and installs Debian bookworm-security FFmpeg
`7:5.1.9-0+deb12u1` exactly. It copies only the Python package, defines no secret,
runs the hosted entrypoint as fixed UID/GID `10001:10001`, and has a private
working directory. Updating either pin is a deliberate reviewed change; do not
silently substitute a moving tag or unversioned FFmpeg package.

Build and inspect the production target from this directory when a Docker-compatible
runtime is available:

```sh
docker build --target runtime --tag music-library-audio-converter:local .
docker image inspect \
  --format '{{.Config.User}} {{.Size}}' \
  music-library-audio-converter:local
docker run --rm \
  --entrypoint sh \
  music-library-audio-converter:local \
  -c 'test "$(id -u):$(id -g)" = "10001:10001" && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libmp3lame && ffprobe -version >/dev/null'
```

The separate `verification` target contains generated fixtures, not private
catalog media. It first writes dense 512 MiB source and output stand-ins together
to exercise the worst-case declared temporary footprint, then exercises the
complete decode/transcode/strict-decode path at the 512 MiB source ceiling. It
watches temporary bytes, measures a conservative process-RSS-plus-temporary peak
against 2 GiB, and verifies private directory cleanup. It prints one aggregate
JSON record with no paths, hashes, or catalog identifiers:

```sh
docker build --target verification --tag music-library-audio-converter:verify .
docker run --rm \
  --read-only \
  --cpus 1 \
  --memory 2g \
  --tmpfs /var/lib/music-audio:rw,noexec,nosuid,nodev,size=1207959552,uid=10001,gid=10001,mode=0700 \
  music-library-audio-converter:verify
```

On 2026-07-15 the full fixture passed on the local host's FFmpeg 8.1.2 in
10.329 seconds: 1,073,741,824 bytes in the simultaneous storage-ceiling phase,
536,870,912 bytes in the processed source, an 11,185,197-byte derivative, and a
conservative 1,123,958,784-byte peak after adding process RSS. Cleanup completed.
This is useful local resource evidence, but it
does not substitute for running the pinned Linux image: no Docker, Podman, or
Colima runtime was installed, so the image build, non-root process check,
pinned FFmpeg/libmp3lame check, mounted-secret readability check, and
container-cgroup measurement remain explicitly unavailable.
