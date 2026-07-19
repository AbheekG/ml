# Legacy file reconciliation

Status: the individual typed-lyric document pass is complete in protected
staging. Remaining private file work covers deferred visual/OCR material,
multi-item compilations, and Scan/Recording candidates outside the completed
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

## Current protected-staging catalog

The verified aggregate snapshot after the completed Lyrics imports on
2026-07-19 is:

- 580 Songs;
- 335 lyric rows;
- 10 Languages, 5 Tags, 19 People, 2 aliases, and 136 Song credits;
- 499 Scans;
- 834 Recordings, 833 active;
- 1,978 media rows; and
- zero foreign-key errors.

The protected application deployment remains Worker
`c06947b2-95ce-43e8-82b0-d9411746c103` with client/service-worker build
`193893b3833a`. The Lyrics imports were catalog-only operations and did not
deploy another build.

## Remaining private file work

The next continuation must begin with read-only orientation and inventory. It
should not infer an import, file move, OCR run, or deletion from this list.

1. Account for the 48 image files deferred from the `Others/Lyrics` text pass.
2. Review the 15 PDFs explicitly deferred to rendered-page visual/OCR work.
3. Reconcile remaining compilations and indexes as multi-item sources rather
   than treating each file as one Song. One twelve-page collection has a corrupt
   selectable-text layer and must never be imported from that extraction.
4. Inventory and reconcile Scan/image and audio/Recording candidates under
   `legacy/drive` but outside the already completed `Final` boundary. Establish
   exact-content overlap and current-catalog relationships before proposing any
   write.
5. Keep source movement, any catalog import, and any cloud/media operation as
   later, separately reviewed and explicitly authorized actions.

After this remaining private legacy work is complete, the approved filename-
presentation refinement may be selected as a separate app change. It remains a
presentation change only and does not authorize removal of filename provenance.
