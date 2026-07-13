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

Do not put private filenames, titles, or personal information in tracked fixtures or captured logs. The later catalog migration adapter will use stable opaque IDs, deterministic output keys, aggregate reconciliation, and a separate ignored output area.
