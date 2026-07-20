# Legacy file reconciliation

Status: the individual typed-lyric document pass and the additional Drive
Recording triage are complete. Private file work is owner-paused. The deferred
boundary consists of an owner-review Recording set, visual/OCR material,
multi-item compilations/indexes, and one notation archive outside the completed
Drive `Final` boundary.

This tracked record contains aggregate status only. Source filenames, Song
titles, lyrics, People, detailed matches, review decisions, exports, backups,
and import plans remain under the ignored `notes/private/` and `legacy/` trees.

## Source-of-truth boundaries

- `legacy/` is immutable source evidence. Reconciliation never authorizes an
  in-place rename, edit, normalization, conversion, move, or deletion.
- The AppSheet workbook remains the original migration baseline. Its importer
  still reproducibly validates 454 workbook Songs and their original relations;
  later editor and reconciliation additions do not change that baseline.
- Live protected D1 plus the exact ignored import checkpoint are authoritative
  for the current staging catalog. Tracked aggregate counts are updated at
  accepted milestones but are not an import source.
- Saving, freezing, or exporting a review decision is not authority to import a
  catalog change or move a source into a processed tree. Those remain separate,
  explicitly approved actions.

## Completed boundaries

- The older Drive `Final` text, Scan/image, and audio reconciliation is closed.
  Its unique missing audio contents were added and byte-verified, processing was
  verified, and redundant archive copies were reconciled. Do not repeat that
  work unless the owner supplies new evidence.
- The `Others/Lyrics` text/document analysis accounted for 188 document
  candidates. All 168 active review decisions in its individual-document queue
  have been processed in protected staging through two exact, guarded,
  idempotent imports: the first 44-decision batch and the remaining 124-decision
  boundary. Skips and deferred material produced no unintended catalog row.
- Across those two Lyrics imports, protected staging gained 124 Songs and 151
  lyric rows. Existing-Song lyric, note, credit, Language, Tag, alias, and Person
  changes were applied only where explicitly reviewed. The imports made no Scan,
  Recording, media-object, R2, deployment, migration, production, or DNS change.
- No source involved in the Lyrics pass has been moved or altered.
- The additional `Others/Recordings` pass isolated 448 relevant audio files
  after excluding owner-confirmed non-song folders. It confirmed 110 whole-file
  app matches and three more exact decoded-audio matches; the owner accepted all
  113 catalog relationships as complete. Among the remaining 335 physical
  files, five two-file groups have different file hashes but identical decoded
  audio. A copy-only, hash-verified owner-review set therefore contains 330
  distinct audio contents, including the one retained file from the otherwise
  excluded Speeches folder. Every filename is preserved. No legacy source was
  moved, renamed, deleted, or altered.
- One accepted wrong-parent Recording repair created a new draft Song and
  reparented the existing Recording while preserving its Recording ID, both
  media references, fingerprint, byte size, and active media state. It created
  no Recording or media row and used no Trash/re-upload path.

## Current protected-staging catalog

The verified aggregate snapshot after the completed Lyrics and Drive Recording
reconciliation on 2026-07-20 is:

- 581 Songs;
- 335 lyric rows;
- 10 Languages, 5 Tags, 21 People, 5 aliases, 137 Song credits, and 6 Recording
  credits;
- 499 Scans;
- 834 Recordings, 833 active;
- 1,978 media rows; and
- zero foreign-key errors.

The protected application deployment remains Worker
`c06947b2-95ce-43e8-82b0-d9411746c103` with client/service-worker build
`193893b3833a`. The Lyrics and Recording reconciliation operations did not
deploy another build.

## Paused private file work

Do not resume this work until the owner explicitly selects it. A future
continuation must begin with read-only orientation and must not infer an import,
file move, transcription/OCR run, or deletion from this list.

1. Await owner decisions on the 330 distinct audio files in the verified local
   review copy. Do not transcribe or infer catalog assignments before that work
   is explicitly resumed.
2. Account for the 48 image files deferred from the `Others/Lyrics` text pass.
3. Review the 15 PDFs explicitly deferred to rendered-page visual/OCR work.
4. Reconcile remaining compilations and indexes as multi-item sources rather
   than treating each file as one Song. One twelve-page collection has a corrupt
   selectable-text layer and must never be imported from that extraction.
5. Review the notation archive with the other deferred Lyrics-area visual
   material. The archive contains five JPEG entries; treat them as individual
   visual sources, not as one Song, and do not alter or extract into `legacy/`.
6. Keep source movement, any catalog import, and any cloud/media operation as
   later, separately reviewed and explicitly authorized actions.

The owner separately selected the filename-presentation refinement while this
private legacy work remains paused. The app change does not resume any item
above and does not authorize removal of filename provenance.
