# Media filename presentation

Status: approved product decision; implementation is deliberately deferred until
the current legacy Lyrics/Scan/Recording reconciliation work is complete.

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

## Deferred implementation scope

After the owner finishes the current legacy file reconciliation:

1. remove filename text from the ordinary Recording rows, Scan rows, Scan viewer,
   and Trash rows;
2. adjust nearby responsive-layout documentation and tests that currently expect
   filename text;
3. preserve editor file-selection and upload-recovery feedback;
4. review duplicate panels and media response headers against the boundary above;
5. verify reader, editor, mobile, desktop, offline, viewer, Trash, and accessible-
   name behavior; and
6. deploy only after the normal protected-staging gate and explicit owner
   authorization.

This is a presentation/API-minimization follow-up, not a schema migration or a
request to erase existing provenance. It must not rename, rewrite, move, or
delete any legacy file, D1 media row, R2 object, original, or derivative.
