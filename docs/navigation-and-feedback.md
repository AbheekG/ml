# Catalog navigation and action feedback

Status: deployed and owner-accepted on 2026-07-17.
Worker version `3e6ac24e-93d3-4704-9fd8-a6bbb0b75efc`; client/service-worker
build `0a1a445e3ce3`.

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
