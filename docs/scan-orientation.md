# Scan display orientation

Status: implemented and deployed to protected staging as Worker
`97a66e8f-0209-4ce6-920c-12165d61a451`, client/service-worker build
`51d4d6e88633`; the owner reports that the deployed behavior works well and
accepts this slice. The device/browser was not recorded. Semantic export names
for shared current-view files are deployed as Worker
`44168581-3e07-443b-b7b9-0690596fd87b`, client/service-worker build
`1eb9c1f2e950` and are owner-accepted after a successful real-device check.

## Stored state and media preservation

Each Scan stores `rotation_quarter_turns` as an absolute clockwise value from
`0` through `3`. Existing and newly created Scans default to `0`; replacing a
Scan's source media resets the value to `0` because the prior correction does
not necessarily apply to the replacement.

The value is presentation metadata only. Neither the exact private original nor
the stored readability JPEG is rotated, replaced, or deleted. The browser
applies the saved value after the readability pipeline's encoded-orientation
normalization. `Open original` continues to expose the authenticated untouched
source and therefore does not promise the saved display orientation.

## Viewer and editor behavior

One clockwise control cycles `0 → 90 → 180 → 270 → 0` and refits the complete
page after each turn. Every authenticated user may rotate locally. The local
choice remains per Scan for the current mounted viewer session and carries into
Image-only mode.

An online editor/admin sends the final absolute value after a short debounce.
The editor-only API validates `0` through `3`, requires the current Scan
revision, records actor/timestamps, increments the Scan revision, and updates
the parent Song. Rapid turns coalesce into one request; returning to the saved
orientation writes nothing. A failed or offline save leaves the current view
rotated but reports that future views will not retain it. There is no offline
mutation queue and viewers never issue the write.

## Sharing

Viewer sharing uses the complete currently displayed orientation, independent
of whether an editor save has completed. The browser draws the already loaded,
authenticated readability image into a dimension-swapped canvas when needed
and creates a temporary semantic JPEG filename from the Song title plus Scan
Notebook/Page metadata and multi-Scan list position; zoom and pan do not crop
the shared page. The temporary file is bounded to 20 MiB, contains no separate
share text or public URL, and is discarded after the action. A zero-turn direct Song-row
share may reuse the verified readability bytes; a saved nonzero row orientation
is applied in the browser before sharing.

The existing second-tap behavior remains when preparation outlasts native user
activation. Sharing remains unavailable for an original fallback, failed load,
unsupported browser, or offline device.

## Acceptance gate

Automated coverage includes schema default/check behavior, viewer write
denial, editor revision conflicts, all four display transforms, dimension
swapping, rapid-turn coalescing, current-view sharing without a viewer write,
semantic bounded files, and replacement reset. Real-device acceptance should
check portrait and landscape pages on Safari/iOS and Chrome/Android, all four
turns, zoom/pan after rotation, Image-only mode, viewer-local behavior,
editor persistence after reopening, immediate Share while a save is pending,
the native second-tap path when it occurs naturally, and readability of the
shared JPEG. Mirror reversal is deliberately outside this feature.

## Deployment verification

The automated gate passes 56 Vitest files / 379 tests, all 90 Python audio
tests, all three TypeScript projects, the production and service-worker builds,
the exact npm dependency tree, and an npm audit with zero reported
vulnerabilities. The in-app browser runtime was unavailable before it could
open the local page, so rendered interaction evidence comes from jsdom and is
not treated as real-browser acceptance.

Migration `0014_scan_display_rotation.sql` is fully applied in protected
staging. Read-only postflight found 499 Scans, all with the default zero
orientation, zero invalid values, zero foreign-key errors, and zero query
writes. The new Worker receives 100% of staging traffic behind the expected
Cloudflare Access redirect. No original or readability object was changed or
deleted.

The owner subsequently reported that the deployed feature works well. Treat the
principal rotation, persistence, and current-view sharing behavior as accepted;
do not infer named-platform coverage beyond that report.
