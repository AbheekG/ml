# Connectivity and online-only media

Status: deployed to protected staging on 2026-07-17 as Worker version
`b9b5dd74-b052-4a0d-906c-638e008418e7`, client/service-worker build
`c743da499d77`; real-device acceptance remains pending.

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

- catalog refresh keeps the saved offline copy and reports its bounded error;
- writes and uploads remain disabled when the browser reports offline, with no
  offline mutation queue;
- private Scan and Recording requests remain authenticated and `private,
  no-store`;
- a Scan or Recording request failure is presented by that viewer or player and
  does not relabel or unmount the whole application.

## Scan-viewer behavior

Opening a Scan mounts the viewer immediately and shows a loading state while the
private image request is pending. The current image request is eager and high
priority because it follows an explicit user action.

An already-open viewer is not closed by a later connectivity transition. A
loaded image may remain visible in memory, while a request still in progress may
either finish or show the existing bounded load error. Once the browser reports
offline, opening another online-only Scan remains disabled.

This separation keeps gesture state local: pinch, pan, reset, navigation, and
image-only mode do not start connectivity checks or change application session
state.

## Safety invariants

- No private media is added to the service-worker or application cache.
- No unauthenticated or permanent media URL is introduced.
- Logout still clears and blocks private local data first. An explicit browser
  reconnection still triggers completion of a pending Cloudflare Access logout.
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

Repeat the core open/zoom/wait/close flow in macOS Safari. iOS/iPadOS remains a
separate deferred compatibility gate.
