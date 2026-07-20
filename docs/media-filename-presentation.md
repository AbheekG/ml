# Media filename presentation

Status: implemented and deployed to protected staging as Worker
`31242783-052d-4520-8313-ca1a2bce9531`, client/service-worker build
`b9c8a5f52641`. Legacy file work remains separately owner-paused and was not
resumed by this change. Owner device/browser acceptance remains pending.

## Decision

An uploaded file's original basename is provenance, not catalog display
metadata. Keep it privately in `media_objects.original_filename` and temporary
Recording-upload state, but do not show it in ordinary Song, Scan, Recording, or
Trash presentation.

This collection makes filenames particularly unreliable as labels: AppSheet and
other legacy tools generated opaque unique basenames, while new phone captures
and casual uploads commonly use generic names such as `scan.jpg`. A basename can
help an editor confirm a just-selected local file, resume an interrupted upload,
or diagnose storage, but it usually tells a reader nothing about the media.

## Ordinary presentation

- A Recording is identified by its required description. Optional recorded date
  and contributor credits remain useful secondary text. Do not append the source
  audio filename.
- A Scan is identified by Notebook and Page when present. Otherwise use the
  generic `Scanned page` label, with list/viewer position such as `2 of 4` when
  disambiguation is needed. Do not append the source image filename.
- Scan viewer headers use the same semantic Scan label and optional position.
- Trash uses Recording description and the semantic Scan label rather than
  source filenames.
- Reader-facing search, sorting, sharing, and accessible action names do not use
  source filenames.

The change should remove meaningless text, not replace it with internal UUIDs,
R2 object keys, media IDs, hashes, or generated storage names.

## Where a filename remains appropriate

- Show the local basename immediately after an editor chooses a new file, so the
  editor can confirm the intended selection before upload or replacement.
- Retain the basename in durable private metadata for provenance, authenticated
  original-media response headers, reconciliation, backup/restore, and bounded
  administrator diagnostics.
- Recording-upload recovery may show the editor-owned upload's basename when it
  helps identify which local file must be resumed.
- Duplicate and error UI should prefer the existing Song, Recording description,
  Notebook/Page, and status. Include a filename only in a clearly operational
  editor context where it materially helps resolve the problem.

Filenames remain private and must not enter routine logs, public URLs, tracked
fixtures, analytics, or unauthenticated output.

## Implemented scope

The selected presentation slice:

1. remove filename text from the ordinary Recording rows, Scan rows, Scan viewer,
   and Trash rows;
2. use semantic Scan labels plus list/viewer position where multiple Scans need
   disambiguation;
3. preserve editor file-selection and upload-recovery feedback;
4. preserve duplicate panels and authenticated original-media response headers
   as bounded operational contexts;
5. omit filenames from the editor-only Trash API response; and
6. cover semantic labels, positions, viewer filename absence, and the minimized
   Trash queries in automated tests.

This is a presentation/API-minimization change, not a schema migration or a
request to erase existing provenance. It does not rename, rewrite, move, or
delete any legacy file, D1 media row, R2 object, original, or derivative.

## Verification and deployment

The gate passed 56 Vitest files / 379 tests, all 90 Python audio tests, all three
TypeScript projects, the production/service-worker build, whitespace checks, an
exact dependency tree, and an npm audit with zero reported vulnerabilities.
The deployed build has seven precache entries; the existing greater-than-500-kB
client advisory remains non-blocking.

Read-only staging postflight confirms the new Worker receives 100% of traffic,
Cloudflare Access still returns the expected unauthenticated redirect, no D1
migration is pending, and the catalog remains at 581 Songs / 335 lyric rows /
499 Scans / 834 Recordings (833 active) / 1,978 media rows / zero foreign-key
errors. The queries wrote zero rows. No D1/R2/media, legacy, production, DNS, or
Git-remote mutation accompanied the deployment.
