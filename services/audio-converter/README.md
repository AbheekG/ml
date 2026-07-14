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
directory before reporting success. Routine outcomes and errors contain no job
ID, signed URL, token, or filesystem path.

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
