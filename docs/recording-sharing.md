# Recording playback sharing

Status: implemented and deployed to protected staging on 2026-07-18 as Worker
`c9db96fd-3028-457b-867a-482143732672`, client/service-worker build
`9f78a8f53da9`. The owner accepted the principal device behavior after checking
several Recordings: the native sheet opens, cancellation is quiet, Share is
disabled offline, and different Recordings on one Song share the correct audio.
The specific device/browser was not recorded. Verification passes at 51
Vitest files / 354 tests,
all 90 Python audio tests, all three TypeScript projects, production build,
production/service-worker build, whitespace checks, and a zero-result,
zero-write query-contract probe against the real staging D1 engine.
The semantic export-filename follow-up is implemented locally and awaits
deployment; the route and stored media are unchanged.

## Playback inventory and bound

The pre-implementation protected-staging inventory was aggregate-only and wrote
zero rows. All 829 active Recordings are ready and resolve to active
`audio/mpeg` playback media:

- 193 use private MP3 derivatives, from 137,987 to 14,948,685 bytes;
- 636 use originals that are already the canonical MP3 playback source, from
  125,021 to 24,420,114 bytes;
- 696 playback files are at most 10 MiB and the remaining 133 are between 10 and
  25 MiB; none exceed 25 MiB; and
- no ready Recording is missing playback or points to an inactive/non-MP3
  playback object.

The owner selected a 50 MiB (52,428,800-byte) sharing bound: more than twice the
current maximum while still preventing an unusually large future upload from
becoming an unbounded browser-memory or native-share operation. A future limit
change must be based on a fresh aggregate inventory and real-device evidence.

## Private playback contract

Song detail includes the selected playback byte size so known files above the
bound show a disabled Share action with a nearby explanation. Older cached Song
details without that added field remain safe: the route and download validation
still enforce the bound after refresh-independent user action.

`GET /api/recordings/:recordingId/playback` is authenticated for every reader and
resolves the Recording's current playback relationship on the server. It returns
only an active, untrashed, ready `audio/mpeg` source: the derivative when one is
current, or the original only when that original is itself the canonical playback
source. It never accepts a client-selected media or storage identifier.

Before streaming, the route rejects an oversized database record, then requires
the private R2 object's exact size to match D1. A successful response is
`private, no-store`, identifies itself as the `playback` representation, and
retains the generic response-header name `recording.mp3`; it exposes no original
filename or public URL.

The client independently requires the playback marker, `audio/mpeg`, a positive
exact `Content-Length`, and the same 50 MiB bound before constructing a file named
`Song title — Recording description.mp3`. Invalid filesystem characters are
removed, whitespace is normalized, Unicode is preserved, and excessive UTF-8
length is bounded. The native share payload contains only that file—no separate
share text, title, original filename, or URL. Capability gating, offline
disabling, quiet cancellation, abort/reset behavior, local bounded feedback, and
the optional prepared-file second tap match accepted Scan sharing. Share is
available to readers for ready Recordings; Edit remains editor-only.

## Acceptance gates

Automated verification must cover capability probing, exact private request and
bytes, MIME/representation/length/size rejection, file-only native payload,
cancellation and second-tap behavior, server playback relationship selection,
viewer authorization, storage-size verification, private response headers, and
pre-storage oversized rejection.

On Android and iPadOS, share at least one derivative-backed and one
canonical-original-backed Recording, plus a larger file. Confirm the resulting
semantic filename identifies the Song and Recording, the MP3 is the same playable
audio, native cancellation is quiet, offline Share is disabled, the correct row
is shared, and a second tap works if a slow download consumes user activation.
Processing or failed Recordings must not offer Share.

The accepted manual checks cover the main interaction and correct-row behavior.
No deliberately oversized playback file was identified and the tested downloads
were too fast to require the second tap. Those conditional paths are covered by
the aggregate size inventory and automated tests and are not release blockers;
do not create retained media solely to force them. Named Android/iPadOS coverage
can be recorded during normal future use rather than inferred from the current
device-unspecified acceptance report.
