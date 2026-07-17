# Logout and private local data

Status: accepted in protected staging. The hardened logout boundary and durable
offline pending-logout fix are deployed as Worker version
`2e889cf3-f246-4651-ac09-20ee13b7936d` with client/service-worker build
`0ad3cf28a474`. The owner verified normal online logout and offline local clearing
followed by automatic Cloudflare logout on reconnect in macOS Safari and Android.
iOS/iPadOS remains a separately deferred compatibility check.

## Required behavior

`Sign out and clear this device` is one explicit user action. Before awaiting
any browser or network operation, the app stores a persistent privacy barrier,
removes the current opaque user cache namespace, hides the protected route tree,
and notifies other same-origin tabs. While that barrier exists, cached catalog
reads return no private rows and catalog/detail refreshes cannot commit to
IndexedDB. A stale session response or in-flight sync therefore cannot restore
data after logout starts.

If logout begins offline, the app must describe the result precisely: private
data is cleared locally, while Cloudflare sign-out remains pending. The pending
state is durable across tabs and browser restarts. On reconnect—or when the app
is opened online in another tab—the app completes the authenticated cache-clear
request and navigates to Cloudflare Access logout before it may load a session,
remove the privacy barrier, or sync private data. A failed remote request keeps
the pending state and retries on a later connectivity transition; it must never
be treated as a fresh successful login.

The logout operation then attempts all of these independent cleanup mechanisms:

- clear and verify the `songs`, `songDetails`, and `metadata` IndexedDB tables;
- delete and verify every `music-library-*` CacheStorage entry;
- call authenticated `POST /api/logout`, whose network response carries
  `Clear-Site-Data: "cache"` to cover the browser HTTP cache, including private
  media responses where supported; and
- navigate with history replacement to Cloudflare Access
  `/cdn-cgi/access/logout`.

The service worker never handles `/api/*` or `/cdn-cgi/access/*`, so it cannot
serve an offline shell in place of either cleanup request. The privacy barrier
remains if an individual browser cleanup API fails. A later authenticated app
load must retry local cleanup before it can bind a fresh opaque cache namespace
and remove the barrier. The Worker endpoint changes no database, R2 object,
application session, or server-side record; Cloudflare Access owns termination
of its authentication session. Scan/audio responses now use `private, no-store`
rather than a persistent browser HTTP-cache lifetime; `Clear-Site-Data` remains
defense in depth for responses cached by an older deployed version.

Cloudflare documents that this end-user logout revokes the user's Access session
across Access applications, not only this library, and that previously issued
tokens may take roughly 20–30 seconds to stop being accepted. The application-
domain URL is retained because it also removes this application's authorization
cookie immediately; see [Cloudflare Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#log-out-as-a-user).

## Protected-staging acceptance gate

After an explicitly approved staging deployment, test on macOS Safari and
Android Chrome:

1. complete a normal catalog sync and open a private Song detail;
2. keep a second tab/window open on private content where supported;
3. choose `Sign out and clear this device` in the first tab;
4. confirm the first tab reaches Cloudflare Access logout/login rather than the
   cached application shell;
5. confirm the other tab promptly hides private content and cannot restore it;
6. while offline, reopen the installed app/site and confirm no catalog or typed
   lyrics are readable;
7. reconnect and authenticate again, then confirm a fresh sync restores normal
   offline reading; and
8. confirm normal login persistence still works when logout was not requested.

Repeat from a fresh authenticated state while offline. The app must say that
local clearing succeeded and Cloudflare sign-out is pending. Private content
must remain unavailable. When connectivity returns or the app is opened online
in a new tab, it must reach Cloudflare logout/login before any catalog reload.

Do not record identities, titles, lyrics, filenames, or media in the acceptance
notes. iOS/iPadOS remains a separately deferred compatibility check.
