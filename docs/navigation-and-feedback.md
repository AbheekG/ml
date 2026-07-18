# Catalog navigation and action feedback

Status: navigation behavior is deployed and owner-accepted. Current protected
staging is Worker version `6f49167f-cd55-4981-8dbe-2245545e32df`;
client/service-worker build `258dec2ffcd1`. The owner reports that direct
Scan-row sharing, the responsive action presentation, the broader action-icon
consistency pass, and Recording sharing work well. The specific device/browser
was not recorded for the later UI/sharing acceptance, so no named-platform claim
is inferred. The owner subsequently accepted the unsaved-editor guard on macOS,
including navigation choices and preservation of a selected Recording file when
the offline route replaces the form until reconnect.

## Catalog Back behavior

Search text, filters, sort order, and the latest catalog scroll position live in
the mounted `App` only. Opening a Song may unmount the catalog route, but going
Back—or returning through an in-app Songs link—reuses that in-memory view and
restores the scroll position after cached catalog rows are available.

Some Android browsers emit their own Back-navigation scroll event while the
cached catalog is still temporarily empty. That provisional position is ignored
until the catalog has completed its one explicit restoration, so it cannot
replace the remembered position with the top of the page.

Opening a Song is a forward navigation and starts its detail page at the top.
The catalog listener is removed synchronously during that route transition, so
the top reset cannot replace the separately remembered catalog position.

The owner accepted search/filter/sort/scroll restoration through the in-app
`All songs` link and Android's native Back action, plus Song details opening at
the top. In macOS Safari, the two-finger interactive Back gesture returns to the
correct catalog state and position but may keep scrolling input-locked for about
4–5 seconds. The in-app link does not show the delay. This is a non-blocking,
Safari-specific observation; do not add timing workarounds without evidence that
application code causes it.

This state is deliberately absent from URLs, `localStorage`, and
`sessionStorage`. Search text may contain private catalog information; it should
not appear in browser history or survive a reload. Logout and the cross-tab
private-data barrier explicitly reset the in-memory catalog view as well.

Reloading the application still starts from the normal unfiltered catalog at the
top. This is an intentional boundary, not a durable preference system.

## Unsaved editor navigation

Song, typed-lyric, Scan, Recording-metadata, and Recording-upload/replacement
screens register dirty state with one router-level guard. An in-app navigation
attempt opens an accessible modal confirmation with trapped focus, Escape/Stay,
and explicit Discard-and-leave actions. Reload, tab close, and external
navigation retain the browser's native unsaved-change warning. Successful Save,
Trash, upload finalization, and explicitly confirmed discard bypass the guard.

Connectivity changes keep dirty fields and selected local files mounted. A
reconnect does not refetch over dirty values; a clean form may refresh normally,
and a different route identity always loads its own current server state. This
does not queue or submit an offline mutation.

## Feedback visibility

Feedback follows the scope of the operation:

- validation tied to one field remains beside that field;
- local actions such as Copy, Share, or Recording-processing retry retain their
  nearby inline feedback;
- form-wide save, upload, restore, and list-management errors remain concise
  summaries with `role="alert"` and scroll into the nearest visible position when
  they appear;
- non-error Recording-upload outcomes use `role="status"` and are revealed the
  same way;
- duplicate Scan and Recording panels reveal themselves directly and retain
  their relevant follow-up actions.

The reveal uses immediate `scrollIntoView({ block: "nearest" })`. It does not
force every message to the top, add animated scrolling, steal keyboard focus, or
create a separate toast lifecycle. The sticky application header is accounted
for with scroll margins.

Background catalog-refresh and Song-refresh errors do not move the reader's
viewport. They are not direct outcomes of the user's current action. Field-level
duplicate/similarity warnings also remain beside their inputs.

Scan sharing follows the same local rule: preparation and bounded errors remain
inside the viewer toolbar or individual Song-row action, native share-sheet
cancellation is quiet, and an expired activation asks for one explicit second
tap without moving the page.

Each Song-row Scan action pairs its text with an eye, connected-share, or pencil
symbol on wider layouts. Below 37 rem the visible text is removed to preserve the
semantic Scan label and metadata, while the 44-pixel icon button retains an
explicit accessible name and disabled state. View and Share remain reader
actions; Edit remains online and editor-only.

The deployed follow-up generalizes that same pattern to repeated compact actions:
Edit Song; typed-lyric Copy, Share, and Edit; and Recording Edit. Recording retry
adds a retry symbol but retains its descriptive text. Add Song/typed lyrics/
Recording/Scan actions use a plus symbol but retain their text at every width,
and Replace Image/Audio uses a bidirectional replacement symbol with text. Save,
Cancel, Trash, Restore, file selection, and unusual recovery actions deliberately
remain text-first because consequence and clarity matter more than compactness.
The deployed Recording-sharing slice reuses the existing share symbol beside Edit
for every reader with a ready playback source. It retains the same compact target,
nearby feedback, quiet cancellation, and second-tap behavior; Edit remains
online and editor-only.

## Acceptance reference

1. On Songs, enter a search, select several filters and a non-default sort, then
   scroll down and open a Song.
2. Return with browser Back and with the Song page's `All songs` link. Confirm
   the exact search/filter/sort state and approximate list position return.
3. Reload and confirm the catalog intentionally resets to its normal initial
   state.
4. Trigger a safe validation error near the bottom of each representative editor
   and confirm the summary becomes visible while field errors remain local.
5. During the next genuine duplicate Recording or Scan attempt, confirm the
   duplicate panel becomes visible without searching near the page top.
6. Recheck normal online and offline logout; no prior catalog query or filter may
   reappear after private-data clearing.

The navigation portion is accepted. Feedback visibility should be observed
during the next natural error or duplicate operation; do not manufacture a
retained upload solely for this check.
