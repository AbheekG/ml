# Connectivity and online-only media

Status: connectivity and Scan-viewer behavior are deployed and owner-accepted on
Android Chrome/Brave and macOS Safari. Current protected staging is Worker
version `f2b7fea4-ddef-4d8e-979e-d761be914273`, client/service-worker build
`33993fc5514d`; direct optimized-Scan sharing, responsive row actions, and
Recording sharing are owner-accepted without a recorded device/browser for
those later checks. Broader iPadOS compatibility remains deferred.

## Boundary

The global `Online` / `Offline · read only` state follows the browser's
`navigator.onLine` value and its `online` and `offline` events. A restored page
resynchronizes from the same browser value.

The `/api/health` endpoint remains useful for deployment and operational checks,
but an application health request does not control the global offline state. One
slow or failed HTTP request cannot establish that every other request is
unavailable, especially on mobile browsers that may replace a stale HTTP/2 or
HTTP/3 connection in the background.

Individual features own their request outcomes:

- protected catalog refresh waits for a validated authenticated session, keeps
  the saved offline copy on transient failure, and routes a definitive 401/403
  to one explicit session-renewal boundary instead of reporting an empty catalog;
- writes and uploads remain disabled when the browser reports offline, with no
  offline mutation queue;
- private Scan and Recording requests remain authenticated and `private,
  no-store`;
- a Scan or Recording request failure is presented by that viewer or player and
  does not relabel or unmount the whole application.

The authenticated offline-library snapshot carries the same media presentation
state needed by the saved Song detail: Scan quarter-turn orientation and
readability-derivative availability, plus the selected Recording playback byte
size. Going offline therefore does not silently reset Scan orientation, offer a
share path for an unavailable derivative, or lose the size guard used by
Recording sharing.

## Scan-viewer behavior

Opening a Scan mounts the viewer immediately and shows a loading state while the
private image request is pending. The current image request is eager and high
priority because it follows an explicit user action.

An already-open viewer is not closed by a later connectivity transition. A
loaded image may remain visible in memory, while a request still in progress may
either finish or show the existing bounded load error. Once the browser reports
offline, opening another online-only Scan remains disabled.

A newly loaded Scan starts fitted to the viewer at 100%. Later visual-viewport
changes—including mobile browser chrome changing when connectivity changes—keep
the current zoom and clamp only the pan position needed to keep the image
reachable. Layout changes do not silently reset the user's view.

This separation keeps gesture state local: pinch, pan, reset, navigation, and
image-only mode do not start connectivity checks or change application session
state.

## Safety invariants

- No private media is added to the service-worker or application cache.
- No unauthenticated or permanent media URL is introduced.
- Optimized-Scan sharing reads authenticated `private, no-store` bytes for the
  immediate native share action; it does not share an original fallback or add
  media to browser or service-worker storage.
- Logout still clears and blocks private local data first. An explicit browser
  reconnection still triggers the one automatic completion of a pending
  Cloudflare Access logout; no direct UI navigation races it.
- Session revalidation after a real browser connectivity transition keeps an
  already-resolved route tree mounted.

## Manual acceptance

On Android Brave and Chrome:

1. Open a Scan and confirm the viewer/loading state appears immediately.
2. Pinch to several zoom levels, pan, and leave the viewer open for at least one
   minute. It must not close or falsely report offline.
3. Close and reopen the Scan, then test navigation and reset.
4. With the viewer open, enable airplane mode. The app should report offline
   without forcibly closing a loaded image; after closing it, new Scan opens and
   all writes must remain disabled.
5. Reconnect and confirm the app returns online and normal authenticated reads
   work without a refresh.

Repeat the core open/zoom/wait/close flow in macOS Safari. The connectivity and
viewer behavior are accepted there and on Android. Optimized-Scan sharing is
also accepted, while broader iPadOS compatibility remains a later non-blocking
gate.
